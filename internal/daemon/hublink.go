package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/daemon/transcript"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var (
	backoffMin    = time.Second
	backoffMax    = 30 * time.Second
	stableAfter   = 30 * time.Second // una conexión más larga reinicia el backoff
	pingEvery     = 30 * time.Second
	linkWriteWait = 5 * time.Second
)

// launchRun abre la sesión; se sustituye en los tests.
var launchRun = launch.Run

const linkReadLimit = 8 << 20

// wsURL convierte la URL http(s) base del hub en la del WebSocket de máquinas.
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

// RunHubLink mantiene la conexión con el hub hasta ctx.Done, reconectando con
// backoff. Mientras no hay conexión sigue vaciando reg.Out(): el hello de la
// próxima conexión restituye el estado de las sesiones.
func RunHubLink(ctx context.Context, cfg Config, reg *Registry) {
	backoff := backoffMin
	for ctx.Err() == nil {
		start := time.Now()
		err := linkOnce(ctx, cfg, reg)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > stableAfter {
			backoff = backoffMin
		}
		log.Printf("hub: enlace caído (%v); reintento en %s", err, backoff)
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

func linkOnce(ctx context.Context, cfg Config, reg *Registry) error {
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

	// Lo emitido sin conexión se descarta; el hello lleva el estado actual.
	for drained := false; !drained; {
		select {
		case <-reg.Out():
		default:
			drained = true
		}
	}
	hello := proto.MachineHello{Machine: cfg.Machine, OS: runtime.GOOS, Env: machineEnv(),
		Version: proto.Version, Sessions: reg.Snapshot()}
	p, _ := json.Marshal(hello)
	if err := writeEnv(ctx, ws, proto.Envelope{Type: "hello", Machine: cfg.Machine, Payload: p}); err != nil {
		return err
	}

	cctx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()
	readErr := make(chan error, 1)
	go func() { readErr <- readLoop(cctx, ws, reg) }()

	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
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
		case err := <-readErr:
			return err
		case <-ctx.Done():
			ws.CloseNow() // cierre acotado: no esperar al par al apagar
			return ctx.Err()
		}
	}
}

func writeEnv(ctx context.Context, ws *websocket.Conn, env proto.Envelope) error {
	ctx, cancel := context.WithTimeout(ctx, linkWriteWait)
	defer cancel()
	return wsjson.Write(ctx, ws, env)
}

func readLoop(ctx context.Context, ws *websocket.Conn, reg *Registry) error {
	for {
		var env proto.Envelope
		if err := wsjson.Read(ctx, ws, &env); err != nil {
			return err
		}
		switch env.Type {
		case "command":
			var cmd proto.Command
			if err := json.Unmarshal(env.Payload, &cmd); err != nil {
				log.Printf("hub: command inválido: %v", err)
				continue
			}
			if !reg.Send(env.Session, cmd) {
				log.Printf("hub: command para %s sin suscriptor", env.Session)
			}
		case "launch":
			var req proto.LaunchRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				log.Printf("hub: launch inválido: %v", err)
				continue
			}
			go func() { // nunca bloquear el bucle de lectura
				res := launchRun(ctx, req)
				p, _ := json.Marshal(res)
				reg.EmitEnvelope(proto.Envelope{Type: "launch_result", Machine: reg.machine, Payload: p})
			}()
		case "backfill":
			go backfill(reg, env.Session) // nunca bloquear el bucle de lectura
		default:
			log.Printf("hub: mensaje %q ignorado", env.Type)
		}
	}
}

const (
	backfillLimit    = 500
	maxTranscriptLen = 200 << 20
	backfillBudget   = 4 << 20 // bytes serializados; el hub lee hasta 8 MiB por mensaje
)

// backfill rearma el historial reciente de la sesión desde su transcript y lo
// responde al hub. Ante cualquier problema responde una lista vacía.
func backfill(reg *Registry, session string) {
	evs := []proto.Event{}
	for _, si := range reg.Snapshot() {
		if si.ID == session {
			evs = readTranscript(si.TranscriptPath)
			break
		}
	}
	p := marshalWithin(evs, backfillBudget)
	reg.EmitEnvelope(proto.Envelope{Type: "backfill_result", Machine: reg.machine, Session: session, Payload: p})
}

// marshalWithin serializa evs descartando primero los más viejos hasta que quepan en budget bytes.
func marshalWithin(evs []proto.Event, budget int) json.RawMessage {
	for {
		p, _ := json.Marshal(evs)
		if len(p) <= budget || len(evs) == 0 {
			return p
		}
		// descarta en bloques para no re-serializar demasiadas veces
		drop := len(evs) / 8
		if drop < 1 {
			drop = 1
		}
		evs = evs[drop:]
	}
}

func readTranscript(path string) []proto.Event {
	if path == "" || !filepath.IsAbs(path) || !strings.HasSuffix(path, ".jsonl") {
		return []proto.Event{}
	}
	f, err := os.Open(path)
	if err != nil {
		return []proto.Event{}
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() || st.Size() > maxTranscriptLen {
		return []proto.Event{}
	}
	evs, err := transcript.Parse(f, backfillLimit)
	if err != nil || evs == nil {
		return []proto.Event{}
	}
	return evs
}

// LinkMachine canjea el código de enlace en hubURL y guarda Hub y MachineToken.
func LinkMachine(ctx context.Context, cfg Config, hubURL, code string) (Config, error) {
	hubURL = strings.TrimRight(hubURL, "/")
	body, _ := json.Marshal(map[string]string{"code": code, "machine": cfg.Machine})
	req, err := http.NewRequestWithContext(ctx, "POST", hubURL+"/api/link", strings.NewReader(string(body)))
	if err != nil {
		return cfg, fmt.Errorf("URL del hub inválida: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return cfg, fmt.Errorf("no se pudo contactar al hub: %w", err)
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
		return cfg, fmt.Errorf("el hub rechazó el enlace: %s", msg)
	}
	cfg.Hub, cfg.MachineToken = hubURL, out.Token
	if err := SaveConfig(cfg); err != nil {
		return cfg, fmt.Errorf("no se pudo guardar la config: %w", err)
	}
	return cfg, nil
}
