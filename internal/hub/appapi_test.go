package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

type appFx struct {
	srv       *Server
	st        *store.Store
	ts        *httptest.Server
	devTok    string
	mach      *websocket.Conn
	cmds      chan proto.Command
	launches  chan proto.LaunchRequest
	backfills chan proto.Envelope
	machTok   string
}

func newAppFx(t *testing.T, sessions ...string) *appFx {
	t.Helper()
	s, st, h := newTestServer(t)
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	f := &appFx{srv: s, st: st, ts: ts, cmds: make(chan proto.Command, 64), launches: make(chan proto.LaunchRequest, 8), backfills: make(chan proto.Envelope, 8)}
	var err error
	f.devTok, err = NewToken()
	require.NoError(t, err)
	require.NoError(t, st.AddToken("device", "tel", f.devTok))
	f.machTok, _ = NewToken()
	require.NoError(t, st.AddToken("machine", "m1", f.machTok))
	f.connectMachine(t, sessions...)
	return f
}

func (f *appFx) wsURL(p string) string { return "ws" + strings.TrimPrefix(f.ts.URL, "http") + p }

func (f *appFx) connectMachine(t *testing.T, sessions ...string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.machTok}}})
	require.NoError(t, err)
	t.Cleanup(func() { c.CloseNow() })
	f.mach = c
	sendHello(t, c, "m1", sessions...)
	go func() {
		for {
			var env proto.Envelope
			if wsjson.Read(context.Background(), c, &env) != nil {
				return
			}
			var cmd proto.Command
			if env.Type == "command" && json.Unmarshal(env.Payload, &cmd) == nil {
				f.cmds <- cmd
			}
			if env.Type == "backfill" {
				f.backfills <- env
			}
			var lr proto.LaunchRequest
			if env.Type == "launch" && json.Unmarshal(env.Payload, &lr) == nil {
				f.launches <- lr
			}
		}
	}()
	eventually(t, func() bool { return online2(f.st, "m1") })
	if len(sessions) > 0 {
		eventually(t, func() bool { l, _ := f.st.ListSessions(false); return len(l) == len(sessions) })
	}
}

func online2(st *store.Store, n string) bool {
	ms, _ := st.ListMachines()
	for _, m := range ms {
		if m.Name == n {
			return m.Online
		}
	}
	return false
}

func (f *appFx) post(path, body string) *http.Response {
	req, _ := http.NewRequest("POST", f.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	return resp
}

func (f *appFx) postBody(path, body string) (int, string) {
	req, _ := http.NewRequest("POST", f.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	var m map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m["error"]
}

func (f *appFx) live(t *testing.T) (*websocket.Conn, chan proto.Envelope) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, f.wsURL("/api/live?token="+f.devTok), nil)
	require.NoError(t, err)
	c.SetReadLimit(-1) // como un navegador: sin tope por mensaje
	t.Cleanup(func() { c.CloseNow() })
	ch := make(chan proto.Envelope, 256)
	go func() {
		for {
			var env proto.Envelope
			if wsjson.Read(context.Background(), c, &env) != nil {
				return
			}
			ch <- env
		}
	}()
	return c, ch
}

func (f *appFx) nextCmd(t *testing.T) proto.Command {
	t.Helper()
	select {
	case c := <-f.cmds:
		return c
	case <-time.After(3 * time.Second):
		t.Fatal("no llegó command")
		return proto.Command{}
	}
}

func (f *appFx) machineSend(t *testing.T, env proto.Envelope) {
	require.NoError(t, wsjson.Write(context.Background(), f.mach, env))
}

func TestPromptRoutedAsCommand(t *testing.T) {
	f := newAppFx(t, "s1")
	require.Equal(t, 202, f.post("/api/sessions/s1/prompt", `{"text":"hola"}`).StatusCode)
	c := f.nextCmd(t)
	require.Equal(t, proto.Command{Type: "prompt", Text: "hola", Mode: "queue"}, c)
	require.Equal(t, 202, f.post("/api/sessions/s1/abort", ``).StatusCode)
	require.Equal(t, "abort", f.nextCmd(t).Type)
	require.Equal(t, 202, f.post("/api/sessions/s1/close", ``).StatusCode)
	require.Equal(t, "close", f.nextCmd(t).Type)
	code, msg := f.postBody("/api/sessions/s1/prompt", `{"text":""}`)
	require.Equal(t, 400, code)
	require.Equal(t, "el mensaje está vacío", msg)
	code, msg = f.postBody("/api/sessions/nope/prompt", `{"text":"x"}`)
	require.Equal(t, 404, code)
	require.Equal(t, "sesión no encontrada", msg)
}

func TestOfflineMachineAndClosedSession(t *testing.T) {
	f := newAppFx(t, "s1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "m1", State: proto.StateClosed}))
	code, msg := f.postBody("/api/sessions/s2/prompt", `{"text":"x"}`)
	require.Equal(t, 409, code)
	require.Equal(t, "la sesión está cerrada", msg)
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s3", Machine: "off", State: proto.StateIdle}))
	code, msg = f.postBody("/api/sessions/s3/prompt", `{"text":"x"}`)
	require.Equal(t, 409, code)
	require.Equal(t, "la máquina está fuera de línea", msg)
}

func TestRESTListings(t *testing.T) {
	f := newAppFx(t, "s1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "m1", State: proto.StateClosed}))
	get := func(p string, v any) {
		req, _ := http.NewRequest("GET", f.ts.URL+p, nil)
		req.Header.Set("Authorization", "Bearer "+f.devTok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, 200, resp.StatusCode)
		require.NoError(t, json.NewDecoder(resp.Body).Decode(v))
	}
	var ss []proto.SessionInfo
	get("/api/sessions", &ss)
	require.Len(t, ss, 1)
	get("/api/sessions?closed=1", &ss)
	require.Len(t, ss, 2)
	for i := 0; i < 5; i++ {
		_, err := f.st.AppendEvent(proto.Event{Session: "s1", Kind: proto.KindInfo})
		require.NoError(t, err)
	}
	var evs []proto.Event
	get("/api/sessions/s1/events?limit=2&before=5", &evs)
	require.Len(t, evs, 2)
	require.EqualValues(t, 4, evs[0].Seq)
	var ms []store.Machine
	get("/api/machines", &ms)
	require.Len(t, ms, 1)
}

func askEnv(session, askID string) proto.Envelope {
	d := mustJSON(proto.Ask{AskID: askID, Kind: "permission"})
	return proto.Envelope{Type: "event", Session: session, Payload: mustJSON(proto.Event{Session: session, Kind: proto.KindAsk, Data: d})}
}

func TestDecideFirstWins(t *testing.T) {
	f := newAppFx(t, "s1")
	_, ch := f.live(t)
	f.machineSend(t, askEnv("s1", "a1"))
	waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "event" })
	code, _ := f.postBody("/api/sessions/s1/decide", `{"askId":"a1","decision":"maybe"}`)
	require.Equal(t, 400, code)
	require.Equal(t, 202, f.post("/api/sessions/s1/decide", `{"askId":"a1","decision":"allow","reason":"ok"}`).StatusCode)
	c := f.nextCmd(t)
	require.Equal(t, proto.Command{Type: "decide", AskID: "a1", Decision: "allow", Reason: "ok"}, c)
	code, msg := f.postBody("/api/sessions/s1/decide", `{"askId":"a1","decision":"deny"}`)
	require.Equal(t, 409, code)
	require.Equal(t, "ya se respondió", msg)
	code, _ = f.postBody("/api/sessions/s1/decide", `{"askId":"zz","decision":"deny"}`)
	require.Equal(t, 409, code)
	// ask_resolved emitido y guardado
	e := waitEnv(t, ch, func(e proto.Envelope) bool {
		var ev proto.Event
		json.Unmarshal(e.Payload, &ev)
		return e.Type == "event" && ev.Kind == proto.KindAskResolved
	})
	var ev proto.Event
	json.Unmarshal(e.Payload, &ev)
	require.Contains(t, string(ev.Data), `"by":"device:tel"`)
	evs, _ := f.st.Events("s1", 0, 10)
	require.Len(t, evs, 2) // ask + ask_resolved
}

func TestDecideResolvedByTerminalCloses(t *testing.T) {
	f := newAppFx(t, "s1")
	f.machineSend(t, askEnv("s1", "a1"))
	d := mustJSON(proto.AskResolved{AskID: "a1", By: "terminal"})
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(proto.Event{Session: "s1", Kind: proto.KindAskResolved, Data: d})})
	eventually(t, func() bool { evs, _ := f.st.Events("s1", 0, 10); return len(evs) == 2 })
	code, _ := f.postBody("/api/sessions/s1/decide", `{"askId":"a1","decision":"allow"}`)
	require.Equal(t, 409, code)
}

func TestConcurrentDecideExactlyOneWins(t *testing.T) {
	f := newAppFx(t, "s1")
	f.machineSend(t, askEnv("s1", "a1"))
	eventually(t, func() bool { evs, _ := f.st.Events("s1", 0, 10); return len(evs) == 1 })
	var ok, conflict int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch f.post("/api/sessions/s1/decide", `{"askId":"a1","decision":"allow"}`).StatusCode {
			case 202:
				atomic.AddInt32(&ok, 1)
			case 409:
				atomic.AddInt32(&conflict, 1)
			}
		}()
	}
	wg.Wait()
	require.EqualValues(t, 1, ok)
	require.EqualValues(t, 11, conflict)
	f.nextCmd(t)
	select {
	case c := <-f.cmds:
		t.Fatalf("comando extra: %+v", c)
	case <-time.After(200 * time.Millisecond):
	}
}

func waitEnv(t *testing.T, ch chan proto.Envelope, ok func(proto.Envelope) bool) proto.Envelope {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case e := <-ch:
			if ok(e) {
				return e
			}
		case <-timeout:
			t.Fatal("no llegó el envelope esperado")
		}
	}
}

func TestLiveSnapshotAndStream(t *testing.T) {
	f := newAppFx(t, "s1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "dead", Machine: "m1", State: proto.StateClosed}))
	_, ch := f.live(t)
	m := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "machine_status" })
	require.Equal(t, "m1", m.Machine)
	u := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" })
	require.Equal(t, "s1", u.Session)
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(proto.Event{Session: "s1", Kind: proto.KindAssistantDelta})})
	e := waitEnv(t, ch, func(e proto.Envelope) bool {
		return e.Type != "session_upsert" && e.Type != "machine_status"
	})
	require.Equal(t, "event", e.Type)
	require.NotEqual(t, "dead", e.Session)
}

func TestLiveRequiresDevice(t *testing.T) {
	f := newAppFx(t)
	_, resp, err := websocket.Dial(context.Background(), f.wsURL("/api/live?token=bad"), nil)
	require.Error(t, err)
	require.Equal(t, 401, resp.StatusCode)
}

func TestSlowClientDisconnectedNotBlocking(t *testing.T) {
	s, _, _ := newTestServer(t)
	cl := &liveClient{ws: nil, send: make(chan proto.Envelope, 1)}
	s.live.clients[cl] = struct{}{}
	s.live.Publish(proto.Envelope{Type: "event"})
	require.Len(t, s.live.clients, 1)
	// el segundo no cabe: se desconecta sin bloquear
	s.live.Publish(proto.Envelope{Type: "event"})
	s.live.mu.Lock()
	n := len(s.live.clients)
	s.live.mu.Unlock()
	require.Equal(t, 0, n)
}

func TestHelloPublishesOnlyKeptSessions(t *testing.T) {
	f := newFixture(t, "m1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "foreign", Machine: "other", State: proto.StateIdle}))
	c := f.dial(t)
	sendHello(t, c, "m1", "mine", "foreign")
	eventually(t, func() bool { return len(f.cap.types()) >= 2 })
	f.cap.mu.Lock()
	defer f.cap.mu.Unlock()
	require.Equal(t, []string{"session_upsert", "machine_status"}, []string{f.cap.envs[0].Type, f.cap.envs[1].Type})
	var si proto.SessionInfo
	require.NoError(t, json.Unmarshal(f.cap.envs[0].Payload, &si))
	require.Equal(t, "mine", si.ID)
	require.Equal(t, "m1", si.Machine)
}

func TestAsksSurviveHubRestart(t *testing.T) {
	f := newAppFx(t, "s1")
	f.machineSend(t, askEnv("s1", "a1"))
	eventually(t, func() bool { evs, _ := f.st.Events("s1", 0, 10); return len(evs) == 1 })
	// hub nuevo sobre el mismo store; la máquina vuelve a conectar
	s2 := NewServer(f.st)
	ts2 := httptest.NewServer(s2.Handler())
	t.Cleanup(ts2.Close)
	f2 := &appFx{srv: s2, st: f.st, ts: ts2, devTok: f.devTok, machTok: f.machTok, cmds: make(chan proto.Command, 64)}
	f2.connectMachine(t, "s1")
	require.Equal(t, 202, f2.post("/api/sessions/s1/decide", `{"askId":"a1","decision":"allow"}`).StatusCode)
	require.Equal(t, "decide", f2.nextCmd(t).Type)
}

func TestSessionGoneDropsAsksAndEmptyAskID(t *testing.T) {
	f := newAppFx(t, "s1")
	code, msg := f.postBody("/api/sessions/s1/decide", `{"decision":"allow"}`)
	require.Equal(t, 400, code)
	require.Equal(t, "falta askId", msg)
	f.machineSend(t, askEnv("s1", "a1"))
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return len(f.srv.asks.open) == 1 })
	f.machineSend(t, proto.Envelope{Type: "session_gone", Session: "s1"})
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return len(f.srv.asks.open) == 0 })
}

func TestReopenDoesNotReviveResolved(t *testing.T) {
	a := newAskTracker()
	a.open["a1"] = "s1"
	require.True(t, a.claim("a1", "s1"))
	d := mustJSON(proto.AskResolved{AskID: "a1", By: "terminal"})
	a.observe(proto.Envelope{Type: "event", Payload: mustJSON(proto.Event{Session: "s1", Kind: proto.KindAskResolved, Data: d})}, nil)
	a.reopen("a1", "s1")
	require.False(t, a.claim("a1", "s1"))
}

func TestMachineJSONKeys(t *testing.T) {
	b, _ := json.Marshal(store.Machine{Name: "m"})
	require.JSONEq(t, `{"name":"m","os":"","env":"","version":"","online":false,"lastSeen":0,"caps":{"herdr":false,"terminal":false,"root":false}}`, string(b))
}

func TestLaunchRoutedAndResultPublished(t *testing.T) {
	f := newAppFx(t)
	_, ch := f.live(t)
	code, msg := f.postBody("/api/launch", `{"machine":"m1","dir":""}`)
	require.Equal(t, 400, code)
	require.Equal(t, "falta la carpeta", msg)
	code, msg = f.postBody("/api/launch", `{"machine":"nope","dir":"/x"}`)
	require.Equal(t, 409, code)
	require.Equal(t, "la máquina está fuera de línea", msg)

	req, _ := http.NewRequest("POST", f.ts.URL+"/api/launch", strings.NewReader(`{"machine":"m1","dir":"/work","continue":true,"permissionMode":"plan"}`))
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 202, resp.StatusCode)
	var out map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.NotEmpty(t, out["reqId"])
	select {
	case lr := <-f.launches:
		require.Equal(t, proto.LaunchRequest{ReqID: out["reqId"], Dir: "/work", Continue: true, PermissionMode: "plan", Trust: true}, lr)
	case <-time.After(3 * time.Second):
		t.Fatal("no llegó launch")
	}
	p, _ := json.Marshal(proto.LaunchResult{ReqID: out["reqId"], OK: true})
	f.machineSend(t, proto.Envelope{Type: "launch_result", Machine: "m1", Payload: p})
	e := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "launch_result" })
	require.Equal(t, "m1", e.Machine)
	var lr proto.LaunchResult
	require.NoError(t, json.Unmarshal(e.Payload, &lr))
	require.Equal(t, proto.LaunchResult{ReqID: out["reqId"], OK: true}, lr)

	r2, _ := http.NewRequest("POST", f.ts.URL+"/api/launch", strings.NewReader(`{}`))
	resp2, err := http.DefaultClient.Do(r2)
	require.NoError(t, err)
	resp2.Body.Close()
	require.Equal(t, 401, resp2.StatusCode)
}

// Sin modos: no hay ruta de presencia y los mensajes watch de una app se ignoran.
func TestNoPresenceRouteAndWatchIgnored(t *testing.T) {
	f := newAppFx(t, "s1")
	// sin ruta: 404, o 405 porque el fallback web de GET / ocupa el patrón
	for _, id := range []string{"x", "s1"} {
		require.Contains(t, []int{404, 405}, f.post("/api/sessions/"+id+"/presence", `{"away":true}`).StatusCode)
	}
	c, ch := f.live(t)
	waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" })
	require.NoError(t, wsjson.Write(context.Background(), c, map[string]string{"type": "watch", "session": "s1"}))
	// la conexión sigue viva y ningún comando llega a la máquina
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(proto.Event{Session: "s1", Kind: proto.KindAssistantDelta})})
	waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "event" })
	select {
	case cmd := <-f.cmds:
		t.Fatalf("comando inesperado: %+v", cmd)
	case <-time.After(200 * time.Millisecond):
	}
}

// Revisión final: las fotos de la terminal se funden (solo la última por panel) y
// nunca dejan por lento a un cliente que no lee; lo normal sigue llegando en orden.
func TestTermFramesCoalescedNeverEvict(t *testing.T) {
	s, _, _ := newTestServer(t)
	cl := newLiveClient(nil)
	cl.waiting, cl.send = false, make(chan proto.Envelope, 4)
	s.live.clients[cl] = struct{}{}
	s.live.Publish(proto.Envelope{Type: "launch_result", Session: "1"})
	for i := 0; i < 1000; i++ {
		s.live.Publish(proto.Envelope{Type: "term_frame", Machine: "m",
			Payload: mustJSON(proto.TermFrame{Pane: "w1:p1", ANSI: fmt.Sprint(i)})})
	}
	s.live.Publish(proto.Envelope{Type: "term_frame", Machine: "m", Payload: mustJSON(proto.TermFrame{Pane: "w1:p2", ANSI: "otro"})})
	s.live.Publish(proto.Envelope{Type: "launch_result", Session: "2"})
	s.live.mu.Lock()
	_, still := s.live.clients[cl]
	s.live.mu.Unlock()
	require.True(t, still)
	require.Len(t, cl.send, 2)
	require.Equal(t, "1", (<-cl.send).Session)
	require.Equal(t, "2", (<-cl.send).Session)
	require.Len(t, cl.frameSig, 1)
	got := map[string]string{}
	for _, e := range s.live.takeFrames(cl) {
		var tf proto.TermFrame
		require.NoError(t, json.Unmarshal(e.Payload, &tf))
		got[tf.Pane] = tf.ANSI
	}
	require.Equal(t, map[string]string{"w1:p1": "999", "w1:p2": "otro"}, got)
	require.Empty(t, s.live.takeFrames(cl))
}
