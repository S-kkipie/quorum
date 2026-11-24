package daemon

import (
	"context"
	"encoding/json"
	"github.com/S-kkipie/quorum/internal/daemon/transcript"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func fastBackoff(t *testing.T) {
	old := backoffMin
	backoffMin = 50 * time.Millisecond
	t.Cleanup(func() { backoffMin = old })
}

func TestWSURL(t *testing.T) {
	require.Equal(t, "ws://vps:7420/api/machine/ws", wsURL("http://vps:7420/"))
	require.Equal(t, "wss://h.ts.net/api/machine/ws", wsURL("https://h.ts.net"))
}

// fakeHub is a WS server that records the hellos received.
type fakeHub struct {
	mu     sync.Mutex
	hellos []proto.MachineHello
	auth   []string
	conns  []*websocket.Conn
	envs   []proto.Envelope // what was received after the hello
}

func (f *fakeHub) handler(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	var env proto.Envelope
	if wsjson.Read(r.Context(), ws, &env) != nil {
		return
	}
	var h proto.MachineHello
	_ = json.Unmarshal(env.Payload, &h)
	f.mu.Lock()
	f.hellos = append(f.hellos, h)
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	f.conns = append(f.conns, ws)
	f.mu.Unlock()
	for {
		var e proto.Envelope
		if err := wsjson.Read(r.Context(), ws, &e); err != nil {
			return
		}
		f.mu.Lock()
		f.envs = append(f.envs, e)
		f.mu.Unlock()
	}
}

func (f *fakeHub) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.hellos) }

func TestReconnectResendsSnapshot(t *testing.T) {
	fastBackoff(t)
	fh := &fakeHub{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(fh.handler))
	srv.Listener = ln
	srv.Start()

	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", State: proto.StateWorking})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go RunHubLink(ctx, Config{Machine: "m1", Hub: "http://" + addr, MachineToken: "tok"}, reg, noHerdrHost(t))

	require.Eventually(t, func() bool { return fh.count() == 1 }, 3*time.Second, 10*time.Millisecond)
	fh.mu.Lock()
	require.Equal(t, "Bearer tok", fh.auth[0])
	require.Equal(t, "m1", fh.hellos[0].Machine)
	require.Equal(t, proto.Version, fh.hellos[0].Version)
	require.Len(t, fh.hellos[0].Sessions, 1)
	fh.mu.Unlock()

	srv.Close()
	fh.mu.Lock()
	for _, c := range fh.conns { // hijacked WS connections are not closed by httptest
		c.CloseNow()
	}
	fh.mu.Unlock()
	reg.Upsert(proto.SessionInfo{ID: "s2", State: proto.StateIdle}) // without a connection: the envelope is dropped, not the session

	ln2, err := net.Listen("tcp", addr)
	require.NoError(t, err)
	srv2 := httptest.NewUnstartedServer(http.HandlerFunc(fh.handler))
	srv2.Listener = ln2
	srv2.Start()
	defer srv2.Close()

	require.Eventually(t, func() bool { return fh.count() == 2 }, 5*time.Second, 10*time.Millisecond)
	fh.mu.Lock()
	defer fh.mu.Unlock()
	require.Len(t, fh.hellos[1].Sessions, 2)
}

func TestCommandReachesSession(t *testing.T) {
	fastBackoff(t)
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	defer st.Close()
	hs := hub.NewServer(st)
	ts := httptest.NewServer(hs.Handler())
	defer ts.Close()

	code, err := st.CreateCode("link")
	require.NoError(t, err)
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	cfg, err := LoadConfig()
	require.NoError(t, err)
	cfg.Machine = "m1"
	cfg, err = LinkMachine(context.Background(), cfg, ts.URL, code)
	require.NoError(t, err)
	require.Equal(t, ts.URL, cfg.Hub)
	saved, err := LoadConfig()
	require.NoError(t, err)
	require.Equal(t, cfg.MachineToken, saved.MachineToken)

	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", State: proto.StateIdle})
	ch, cancelSub := reg.Subscribe("s1")
	defer cancelSub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go RunHubLink(ctx, cfg, reg, noHerdrHost(t))

	require.Eventually(t, func() bool {
		p, _ := json.Marshal(proto.Command{Type: "prompt", Text: "hello"})
		return hs.Hub().SendToMachine("m1", proto.Envelope{Type: "command", Session: "s1", Payload: p})
	}, 3*time.Second, 20*time.Millisecond)
	require.Equal(t, "hello", nextPrompt(t, ch).Text)
	// and what the registry emits reaches the hub
	reg.Upsert(proto.SessionInfo{ID: "s1", State: proto.StateWorking})
	require.Eventually(t, func() bool {
		l, _ := st.ListSessions(false)
		return len(l) == 1 && l[0].State == proto.StateWorking
	}, 3*time.Second, 20*time.Millisecond)
}

func TestLinkMachineBadCode(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	defer st.Close()
	ts := httptest.NewServer(hub.NewServer(st).Handler())
	defer ts.Close()
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	_, err = LinkMachine(context.Background(), Config{Machine: "m1"}, ts.URL, "000000")
	require.ErrorContains(t, err, "invalid or expired code")
}

func TestReloadStartsHubLink(t *testing.T) {
	fastBackoff(t)
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	cfg, err := LoadConfig()
	require.NoError(t, err)
	fh := &fakeHub{}
	srv := httptest.NewServer(http.HandlerFunc(fh.handler))
	defer srv.Close()

	reg := NewRegistry(cfg.Machine)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lk := &linker{reg: reg, parent: ctx}
	lk.start(cfg) // without a hub: it only drains Out()
	reload := func() error {
		c, err := LoadConfig()
		if err != nil {
			return err
		}
		lk.start(c)
		return nil
	}
	api := httptest.NewServer(NewLocalAPIWithReload(reg, cfg.LocalToken, "v", reload))
	defer api.Close()

	post := func(tok string) int {
		req, _ := http.NewRequest("POST", api.URL+"/v1/reload", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	require.Equal(t, 401, post("malo"))
	require.Equal(t, 0, fh.count())

	cfg.Hub, cfg.MachineToken = srv.URL, "tok"
	require.NoError(t, SaveConfig(cfg))
	require.Equal(t, 204, post(cfg.LocalToken))
	require.Eventually(t, func() bool { return fh.count() == 1 }, 3*time.Second, 10*time.Millisecond)
}

type capBC struct{ ch chan proto.Envelope }

func (c capBC) Publish(e proto.Envelope) {
	select {
	case c.ch <- e:
	default:
	}
}

func TestLaunchHandledWithoutBlocking(t *testing.T) {
	fastBackoff(t)
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	defer st.Close()
	hs := hub.NewServer(st)
	bc := capBC{make(chan proto.Envelope, 64)}
	hs.Hub().SetBroadcaster(bc)
	ts := httptest.NewServer(hs.Handler())
	defer ts.Close()
	code, err := st.CreateCode("link")
	require.NoError(t, err)
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	cfg, err := LoadConfig()
	require.NoError(t, err)
	cfg.Machine = "m1"
	cfg, err = LinkMachine(context.Background(), cfg, ts.URL, code)
	require.NoError(t, err)

	release := make(chan struct{})
	old := launchRun
	launchRun = func(_ context.Context, req proto.LaunchRequest) proto.LaunchResult {
		<-release
		return proto.LaunchResult{ReqID: req.ReqID, OK: req.Dir == "/work"}
	}
	defer func() { launchRun = old }()

	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", State: proto.StateIdle})
	ch, cancelSub := reg.Subscribe("s1")
	defer cancelSub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go RunHubLink(ctx, cfg, reg, noHerdrHost(t))

	lp, _ := json.Marshal(proto.LaunchRequest{ReqID: "r1", Dir: "/work"})
	require.Eventually(t, func() bool {
		return hs.Hub().SendToMachine("m1", proto.Envelope{Type: "launch", Payload: lp})
	}, 3*time.Second, 20*time.Millisecond)
	// with the launch blocked, the read loop keeps serving commands
	cp, _ := json.Marshal(proto.Command{Type: "prompt", Text: "hello"})
	require.True(t, hs.Hub().SendToMachine("m1", proto.Envelope{Type: "command", Session: "s1", Payload: cp}))
	require.Equal(t, "hello", nextPrompt(t, ch).Text)
	close(release)
	deadline := time.After(3 * time.Second)
	for {
		select {
		case e := <-bc.ch:
			if e.Type != "launch_result" {
				continue
			}
			var res proto.LaunchResult
			require.NoError(t, json.Unmarshal(e.Payload, &res))
			require.Equal(t, proto.LaunchResult{ReqID: "r1", OK: true}, res)
			return
		case <-deadline:
			t.Fatal("launch_result did not arrive")
		}
	}
}

func TestBackfillRepliesWithParsedEvents(t *testing.T) {
	dir := t.TempDir()
	tp := filepath.Join(dir, "t.jsonl")
	require.NoError(t, os.WriteFile(tp, []byte(`{"type":"user","message":{"content":"hello"},"timestamp":"2026-01-02T03:04:05Z"}`+"\ngarbage\n"), 0o600))
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp})
	reg.Upsert(proto.SessionInfo{ID: "s2", TranscriptPath: "relativo.jsonl"})
	reg.Upsert(proto.SessionInfo{ID: "s3", TranscriptPath: dir}) // not a regular file
	txt := filepath.Join(dir, "t.txt")
	require.NoError(t, os.WriteFile(txt, []byte(`{"type":"user","message":{"content":"x"}}`+"\n"), 0o600))
	reg.Upsert(proto.SessionInfo{ID: "s4", TranscriptPath: txt}) // without .jsonl
	drain := func() {
		for len(reg.Out()) > 0 {
			<-reg.Out()
		}
	}
	drain()

	recv := func(id string) []proto.Event {
		go backfill(reg, id)
		select {
		case env := <-reg.Out():
			require.Equal(t, "backfill_result", env.Type)
			require.Equal(t, id, env.Session)
			var evs []proto.Event
			require.NoError(t, json.Unmarshal(env.Payload, &evs))
			return evs
		case <-time.After(3 * time.Second):
			t.Fatal("no response")
			return nil
		}
	}
	evs := recv("s1")
	require.Len(t, evs, 1)
	require.Equal(t, proto.KindUser, evs[0].Kind)
	require.EqualValues(t, 1767323045000, evs[0].TS)
	require.Empty(t, recv("s2"))
	require.Empty(t, recv("s3"))
	require.Empty(t, recv("s4"))
	require.Empty(t, recv("desconocida"))
}

func TestBackfillOversizedTranscriptFitsBudget(t *testing.T) {
	big := strings.Repeat("é", 100_000) // 200 KB per message
	var sb strings.Builder
	for i := 0; i < 500; i++ {
		sb.WriteString(`{"type":"user","message":{"content":"` + big + "\"}}\n")
	}
	tp := filepath.Join(t.TempDir(), "big.jsonl")
	require.NoError(t, os.WriteFile(tp, []byte(sb.String()), 0o600))
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp})
	for len(reg.Out()) > 0 {
		<-reg.Out()
	}
	go backfill(reg, "s1")
	env := <-reg.Out()
	require.LessOrEqual(t, len(env.Payload), backfillBudget)
	var evs []proto.Event
	require.NoError(t, json.Unmarshal(env.Payload, &evs))
	require.NotEmpty(t, evs)
	var d map[string]string
	require.NoError(t, json.Unmarshal(evs[0].Data, &d))
	require.LessOrEqual(t, len(d["text"]), transcript.MaxText+len("…"))
	require.True(t, utf8.ValidString(d["text"]))
}

// nextPrompt waits for the next command on the channel.
func nextPrompt(t *testing.T, ch <-chan proto.Command) proto.Command {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case c := <-ch:
			return c
		case <-timeout:
			t.Fatal("the command did not arrive (read loop blocked?)")
		}
	}
}

// Plan 8: every known session's command list follows each hello (the hub may have restarted).
func TestHelloFollowedBySessionCommands(t *testing.T) {
	fastBackoff(t)
	fh := &fakeHub{}
	srv := httptest.NewServer(http.HandlerFunc(fh.handler))
	defer srv.Close()
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1"})
	reg.SetCommands("s1", proto.SessionCommands{Hash: "h1", Commands: []proto.SessionCommand{{Name: "compact"}}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go RunHubLink(ctx, Config{Machine: "m1", Hub: srv.URL, MachineToken: "tok"}, reg, noHerdrHost(t))
	require.Eventually(t, func() bool {
		fh.mu.Lock()
		defer fh.mu.Unlock()
		for _, e := range fh.envs {
			if e.Type == "session_commands" && e.Session == "s1" {
				return true
			}
		}
		return false
	}, 3*time.Second, 10*time.Millisecond)
}
