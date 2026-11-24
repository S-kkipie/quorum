package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var (
	backoffMin    = time.Second
	backoffMax    = 30 * time.Second
	stableAfter   = 30 * time.Second // a longer connection resets the backoff
	pingEvery     = 30 * time.Second
	linkWriteWait = 5 * time.Second
)

// launchRun opens the session without herdr; launchHerdr, with herdr. Replaced in tests.
var (
	launchRun   = launch.Run
	launchHerdr = launch.RunHerdrCause
)

// capsEvery: how often capabilities are recomputed; a variable for tests.
var capsEvery = 30 * time.Second

const linkReadLimit = 8 << 20

// wsURL converts the hub's base http(s) URL into the machines WebSocket one.
func wsURL(hub string) string {
	hub = strings.TrimRight(hub, "/")
	switch {
	case strings.HasPrefix(hub, "https://"):
		hub = "wss://" + hub[len("https://"):]
	case strings.HasPrefix(hub, "http://"):
		hub = "ws://" + hub[len("http://"):]
	}
	return hub + "/api/machine/ws"
}

func machineEnv() string {
	if runtime.GOOS == "linux" && IsWSL() {
		return "wsl"
	}
	return runtime.GOOS
}

// RunHubLink keeps the connection to the hub until ctx.Done, reconnecting with
// backoff. While there is no connection it keeps draining reg.Out(): the next
// connection's hello restores the sessions' state.
func RunHubLink(ctx context.Context, cfg Config, reg *Registry, host *Host) {
	host.trackSessions(reg)
	host.watchFocus(ctx, reg)
	backoff := backoffMin
	for ctx.Err() == nil {
		start := time.Now()
		err := linkOnce(ctx, cfg, reg, host)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > stableAfter {
			backoff = backoffMin
		}
		log.Printf("hub: link down (%v); retrying in %s", err, backoff)
		drainFor(ctx, reg, backoff)
		if backoff *= 2; backoff > backoffMax {
			backoff = backoffMax
		}
	}
}

func drainFor(ctx context.Context, reg *Registry, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	for {
		select {
		case <-reg.Out():
		case <-t.C:
			return
		case <-ctx.Done():
			return
		}
	}
}

func linkOnce(ctx context.Context, cfg Config, reg *Registry, host *Host) error {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	ws, _, err := websocket.Dial(dctx, wsURL(cfg.Hub), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.MachineToken}},
	})
	cancel()
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	ws.SetReadLimit(linkReadLimit)

	// Anything emitted while disconnected is dropped; the hello carries the current state.
	for drained := false; !drained; {
		select {
		case <-reg.Out():
		default:
			drained = true
		}
	}
	caps := host.Caps(ctx)
	hello := proto.MachineHello{Machine: cfg.Machine, OS: runtime.GOOS, Env: machineEnv(),
		Version: proto.Version, Sessions: reg.Snapshot(), Caps: caps}
	p, _ := json.Marshal(hello)
	if err := writeEnv(ctx, ws, proto.Envelope{Type: "hello", Machine: cfg.Machine, Payload: p}); err != nil {
		return err
	}
	// what was sent while disconnected was dropped: the sessions' command lists go again
	for _, sc := range reg.AllCommands() {
		cp, _ := json.Marshal(sc)
		if err := writeEnv(ctx, ws, proto.Envelope{Type: "session_commands", Machine: cfg.Machine, Session: sc.Session, Payload: cp}); err != nil {
			return err
		}
	}

	cctx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()
	readErr := make(chan error, 1)
	go func() { readErr <- readLoop(cctx, ws, reg, host) }()

	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	capsTick := time.NewTicker(capsEvery)
	defer capsTick.Stop()
	for {
		select {
		case env := <-reg.Out():
			if err := writeEnv(cctx, ws, env); err != nil {
				return err
			}
		case <-ping.C:
			pctx, c := context.WithTimeout(cctx, linkWriteWait)
			err := ws.Ping(pctx)
			c()
			if err != nil {
				return err
			}
		case <-capsTick.C:
			if now := host.Caps(cctx); now != caps {
				caps = now
				p, _ := json.Marshal(caps)
				if err := writeEnv(cctx, ws, proto.Envelope{Type: "caps", Machine: cfg.Machine, Payload: p}); err != nil {
					return err
				}
			}
		case err := <-readErr:
			return err
		case <-ctx.Done():
			ws.CloseNow() // bounded close: do not wait for the peer on shutdown
			return ctx.Err()
		}
	}
}

func writeEnv(ctx context.Context, ws *websocket.Conn, env proto.Envelope) error {
	ctx, cancel := context.WithTimeout(ctx, linkWriteWait)
	defer cancel()
	return wsjson.Write(ctx, ws, env)
}

func readLoop(ctx context.Context, ws *websocket.Conn, reg *Registry, host *Host) error {
	for {
		var env proto.Envelope
		if err := wsjson.Read(ctx, ws, &env); err != nil {
			return err
		}
		switch env.Type {
		case "command":
			var cmd proto.Command
			if err := json.Unmarshal(env.Payload, &cmd); err != nil {
				log.Printf("hub: invalid command: %v", err)
				continue
			}
			if cmd.Type == "close" {
				host.closeRequested(reg, env.Session) // before the session ends
			}
			if !reg.Send(env.Session, cmd) {
				log.Printf("hub: command for %s with no subscriber", env.Session)
			}
		case "launch":
			var req proto.LaunchRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				log.Printf("hub: invalid launch: %v", err)
				continue
			}
			go func() { // never block the read loop
				res := host.launch(ctx, req)
				p, _ := json.Marshal(res)
				reg.EmitEnvelope(proto.Envelope{Type: "launch_result", Machine: reg.machine, Payload: p})
			}()
		case "rpc":
			var rq proto.RPC
			if err := json.Unmarshal(env.Payload, &rq); err != nil {
				log.Printf("hub: invalid rpc: %v", err)
				continue
			}
			go handleRPC(ctx, host, reg, rq) // never block the read loop
		case "backfill":
			go backfill(reg, env.Session) // never block the read loop
		default:
			log.Printf("hub: ignored message %q", env.Type)
		}
	}
}

const (
	backfillLimit  = 500
	backfillBudget = 4 << 20 // serialized bytes; the hub reads up to 8 MiB per message
)

// backfill rebuilds the session's recent history from the tail of its transcript (one page read
// backwards, never the whole file) and answers it to the hub. On any problem it answers an empty list.
func backfill(reg *Registry, session string) {
	evs := []proto.Event{}
	if pg, err := readPage(reg, session, "", backfillLimit, backfillBudget, 0); err == nil {
		evs = pg.Events
		if len(evs) > backfillLimit {
			evs = evs[len(evs)-backfillLimit:]
		}
	}
	p := marshalWithin(evs, backfillBudget)
	reg.EmitEnvelope(proto.Envelope{Type: "backfill_result", Machine: reg.machine, Session: session, Payload: p})
}

// marshalWithin serializes evs, dropping the oldest first until they fit in budget bytes.
func marshalWithin(evs []proto.Event, budget int) json.RawMessage {
	for {
		p, _ := json.Marshal(evs)
		if len(p) <= budget || len(evs) == 0 {
			return p
		}
		// drop in blocks so as not to re-serialize too many times
		drop := len(evs) / 8
		if drop < 1 {
			drop = 1
		}
		evs = evs[drop:]
	}
}

// LinkMachine redeems the link code at hubURL and saves Hub and MachineToken.
func LinkMachine(ctx context.Context, cfg Config, hubURL, code string) (Config, error) {
	hubURL = strings.TrimRight(hubURL, "/")
	body, _ := json.Marshal(map[string]string{"code": code, "machine": cfg.Machine})
	req, err := http.NewRequestWithContext(ctx, "POST", hubURL+"/api/link", strings.NewReader(string(body)))
	if err != nil {
		return cfg, fmt.Errorf("invalid hub URL: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return cfg, fmt.Errorf("could not contact the hub: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		Token string `json:"token"`
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 200 || out.Token == "" {
		msg := out.Error
		if msg == "" {
			msg = resp.Status
		}
		return cfg, fmt.Errorf("the hub rejected the link: %s", msg)
	}
	cfg.Hub, cfg.MachineToken = hubURL, out.Token
	if err := SaveConfig(cfg); err != nil {
		return cfg, fmt.Errorf("could not save the config: %w", err)
	}
	return cfg, nil
}
