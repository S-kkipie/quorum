package hub

// Regresiones de la segunda ronda de arreglos (residuales del plan 1).

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func upsertEnv(id, prev string, st proto.SessionState) proto.Envelope {
	return proto.Envelope{Type: "session_upsert", Session: id, Payload: mustJSON(proto.SessionInfo{ID: id, PreviousID: prev, State: st})}
}

func (f *appFx) restSessions(t *testing.T) map[string]proto.SessionInfo {
	t.Helper()
	req, _ := http.NewRequest("GET", f.ts.URL+"/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var list []proto.SessionInfo
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	out := map[string]proto.SessionInfo{}
	for _, si := range list {
		out[si.ID] = si
	}
	return out
}

// Important Q: tras /clear A→B, `claude --resume A` revive A mientras B vive. Los
// upserts/hellos que aún traen B.previousId=A no mueven asks de A a B.
func TestResumedOldIDKeepsAsks(t *testing.T) {
	f := newAppFx(t, "A")
	f.machineSend(t, upsertEnv("B", "A", proto.StateIdle)) // /clear
	eventually(t, func() bool { _, err := f.st.Session("A"); return err != nil })

	f.machineSend(t, upsertEnv("A", "", proto.StateIdle)) // resume A en otra terminal
	eventually(t, func() bool { return f.srv.sessionLive("A") })
	_, ch := f.live(t)
	waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" })
	f.machineSend(t, askEnv("A", "a2"))
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return f.srv.asks.open["a2"] == "A" })

	// B se re-registra (update/hello) todavía con previousId=A
	f.machineSend(t, upsertEnv("B", "A", proto.StateWorking))
	e := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" && e.Session == "B" })
	var si proto.SessionInfo
	require.NoError(t, json.Unmarshal(e.Payload, &si))
	require.Empty(t, si.PreviousID)
	// y una reconexión con las dos vivas en el hello
	f.mach.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mc, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.machTok}}})
	require.NoError(t, err)
	t.Cleanup(func() { mc.CloseNow() })
	h := proto.MachineHello{Machine: "m1", Version: proto.Version, Sessions: []proto.SessionInfo{
		{ID: "B", PreviousID: "A", State: proto.StateIdle}, {ID: "A", State: proto.StateIdle}}}
	require.NoError(t, wsjson.Write(ctx, mc, proto.Envelope{Type: "hello", Payload: mustJSON(h)}))
	eventually(t, func() bool { si, _ := f.st.Session("B"); return si.State == proto.StateIdle })

	require.True(t, f.srv.sessionLive("A"))
	require.True(t, f.srv.sessionLive("B"))
	rest := f.restSessions(t)
	require.Empty(t, rest["B"].PreviousID)
	require.Empty(t, rest["A"].PreviousID)
	require.Equal(t, 202, f.post("/api/sessions/A/decide", `{"askId":"a2","decision":"allow"}`).StatusCode)
}

// Important R: tras reiniciar el hub, una máquina que no vuelve cierra sus sesiones
// (y poda sus asks) al vencer la gracia; la que vuelve a tiempo no pierde nada.
func TestStartupGraceClosesMachinesThatNeverReturn(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	for _, x := range []struct{ m, s string }{{"m1", "s1"}, {"m2", "s2"}} {
		require.NoError(t, st.UpsertMachine(x.m, "linux", "linux", "1", true, proto.MachineCaps{}))
		require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: x.s, Machine: x.m, State: proto.StateNeedsYou}))
		_, err := st.AppendEvent(proto.Event{Session: x.s, Kind: proto.KindAsk, Data: mustJSON(proto.Ask{AskID: "ask-" + x.s})})
		require.NoError(t, err)
	}
	clock := &fakeClock{now: time.Unix(1000, 0)}
	old := defaultAfterFunc
	defaultAfterFunc = clock.afterFunc
	t.Cleanup(func() { defaultAfterFunc = old })
	s := NewServer(st)
	require.Len(t, clock.timers, 2)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	f := &appFx{srv: s, st: st, ts: ts, cmds: make(chan proto.Command, 64)}
	f.machTok, _ = NewToken()
	require.NoError(t, st.AddToken("machine", "m1", f.machTok))
	f.devTok, _ = NewToken()
	require.NoError(t, st.AddToken("device", "tel", f.devTok))
	// m1 vuelve dentro de la gracia
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mc, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.machTok}}})
	require.NoError(t, err)
	t.Cleanup(func() { mc.CloseNow() })
	sendHello(t, mc, "m1", "s1")
	eventually(t, func() bool { return online2(st, "m1") })
	clock.advance(61 * time.Second)
	si1, _ := st.Session("s1")
	si2, _ := st.Session("s2")
	require.Equal(t, proto.StateIdle, si1.State)
	require.Equal(t, proto.StateClosed, si2.State)
	s.asks.mu.Lock()
	require.Equal(t, map[string]string{"ask-s1": "s1"}, s.asks.open)
	s.asks.mu.Unlock()
}

// Minor: el límite de intentos de emparejamiento es por IP remota.
func TestPairLimiterPerIP(t *testing.T) {
	s, st, h := newTestServer(t)
	try := func(remote, xff, code string) int {
		req := httptest.NewRequest("POST", "/api/pair", strings.NewReader(`{"code":"`+code+`"}`))
		req.RemoteAddr = remote
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr.Code
	}
	for i := 0; i < 10; i++ {
		require.Equal(t, 400, try("203.0.113.9:4000", "", "bad"))
	}
	require.Equal(t, 429, try("203.0.113.9:4001", "", "bad"))
	// otra IP no queda bloqueada
	code, err := st.CreateCode("pair")
	require.NoError(t, err)
	require.Equal(t, 200, try("198.51.100.7:5000", "", code))
	// X-Forwarded-For solo cuenta detrás de un proxy local (loopback)
	require.Equal(t, 429, try("203.0.113.9:4002", "198.51.100.8", "bad"))
	for i := 0; i < 10; i++ {
		require.Equal(t, 400, try("127.0.0.1:6000", "192.0.2.50", "bad"))
	}
	require.Equal(t, 429, try("127.0.0.1:6001", "192.0.2.50", "bad"))
	require.Equal(t, 400, try("127.0.0.1:6002", "192.0.2.51", "bad"))
	_ = s
}

// Minor: el nombre del dispositivo se recorta y se limita a 64 caracteres.
func TestDeviceNameTrimmedAndLimited(t *testing.T) {
	require.Equal(t, "tel", deviceName("  tel \n"))
	require.Equal(t, "dispositivo", deviceName("   "))
	long := strings.Repeat("ñ", 100)
	require.Equal(t, strings.Repeat("ñ", 64), deviceName(long))
	_, st, h := newTestServer(t)
	code, _ := st.CreateCode("pair")
	rr := do(h, "POST", "/api/pair", `{"code":"`+code+`","deviceName":"`+long+`"}`, nil)
	require.Equal(t, 200, rr.Code)
	ds, _ := st.ListDevices()
	require.Len(t, ds, 1)
	require.Equal(t, strings.Repeat("ñ", 64), ds[0].Name)
}

// Minor: el plazo de escritura crece con el tamaño (backfill de hasta 4 MiB).
func TestWriteTimeoutScalesWithSize(t *testing.T) {
	require.Equal(t, writeTimeout, writeTimeoutFor(proto.Envelope{}))
	big := proto.Envelope{Payload: make(json.RawMessage, 4<<20)}
	require.Equal(t, writeTimeout+4*time.Second, writeTimeoutFor(big))
}

// Minor: dos pedidos simultáneos de historial mandan un solo backfill.
func TestConcurrentBackfillRequestSendsOnce(t *testing.T) {
	f := newAppFx(t, "s1")
	var wg sync.WaitGroup
	var mu sync.Mutex
	sent := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if f.srv.hub.requestBackfill("m1", "s1") {
				mu.Lock()
				sent++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	require.Equal(t, 1, sent)
	<-f.backfills
	select {
	case <-f.backfills:
		t.Fatal("backfill duplicado")
	case <-time.After(150 * time.Millisecond):
	}
	// un envío fallido no deja la sesión marcada
	require.False(t, f.srv.hub.requestBackfill("nadie", "s9"))
	f.srv.hub.mu.Lock()
	_, marked := f.srv.hub.backfills["s9"]
	f.srv.hub.mu.Unlock()
	require.False(t, marked)
}

// Minor: un session_upsert de una sesión viva ya sembrada no vuelve a leer sus asks;
// una sesión nueva o que vuelve tras cerrarse sí.
func TestReseedOnlyForNewOrReturningSessions(t *testing.T) {
	f := newAppFx(t, "s1")
	f.machineSend(t, upsertEnv("s1", "", proto.StateWorking))
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return f.srv.asks.known["s1"] })
	// un ask guardado sin pasar por el feed (no se observa)
	_, err := f.st.AppendEvent(proto.Event{Session: "s1", Kind: proto.KindAsk, Data: mustJSON(proto.Ask{AskID: "hidden"})})
	require.NoError(t, err)
	f.machineSend(t, upsertEnv("s1", "", proto.StateIdle))
	eventually(t, func() bool { si, _ := f.st.Session("s1"); return si.State == proto.StateIdle })
	time.Sleep(50 * time.Millisecond)
	f.srv.asks.mu.Lock()
	_, open := f.srv.asks.open["hidden"]
	f.srv.asks.mu.Unlock()
	require.False(t, open, "reseed no debió consultar el store")
	f.machineSend(t, proto.Envelope{Type: "session_gone", Session: "s1"})
	eventually(t, func() bool { return !f.srv.sessionLive("s1") })
	f.machineSend(t, upsertEnv("s1", "", proto.StateNeedsYou))
	eventually(t, func() bool {
		f.srv.asks.mu.Lock()
		defer f.srv.asks.mu.Unlock()
		return f.srv.asks.open["hidden"] == "s1"
	})
}

// Minor: si no se puede guardar el ask_resolved no se publica sin seq ni queda reclamado.
func TestDecideStoreFailureNoUnsequencedEventNoClaimLeak(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	s := NewServer(st)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	f := &appFx{srv: s, st: st, ts: ts, cmds: make(chan proto.Command, 64)}
	f.devTok, _ = NewToken()
	require.NoError(t, st.AddToken("device", "tel", f.devTok))
	f.machTok, _ = NewToken()
	require.NoError(t, st.AddToken("machine", "m1", f.machTok))
	f.connectMachine(t, "s1")
	f.machineSend(t, askEnv("s1", "a1"))
	eventually(t, func() bool { s.asks.mu.Lock(); defer s.asks.mu.Unlock(); return s.asks.open["a1"] == "s1" })
	_, ch := f.live(t)
	waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" })

	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "hub.db")+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	defer db.Close()
	_, err = db.Exec(`CREATE TRIGGER no_resolved BEFORE INSERT ON events WHEN NEW.kind='ask_resolved' BEGIN SELECT RAISE(ABORT,'no'); END`)
	require.NoError(t, err)

	require.Equal(t, 202, f.post("/api/sessions/s1/decide", `{"askId":"a1","decision":"allow"}`).StatusCode)
	require.Equal(t, "decide", f.nextCmd(t).Type)
	select {
	case e := <-ch:
		if e.Type == "event" {
			t.Fatalf("evento publicado sin seq: %s", e.Payload)
		}
	case <-time.After(150 * time.Millisecond):
	}
	s.asks.mu.Lock()
	defer s.asks.mu.Unlock()
	require.Empty(t, s.asks.claimed)
	require.True(t, s.asks.resolved["a1"])
}

// Minor: el hub hace ping a las máquinas y suelta la que no contesta.
func TestSilentMachineDroppedByPing(t *testing.T) {
	old := machinePing.Swap(int64(20 * time.Millisecond))
	t.Cleanup(func() { machinePing.Store(old) })
	f := newFixture(t, "m1")
	c := f.dial(t) // nunca lee: no contesta pongs
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return f.srv.hub.Connected("m1") })
	eventually(t, func() bool { return !f.srv.hub.Connected("m1") })

	// una que lee (y contesta pongs) sigue conectada
	c2 := f.dial(t)
	go func() {
		for {
			if _, _, err := c2.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	sendHello(t, c2, "m1", "s1")
	eventually(t, func() bool { return f.srv.hub.Connected("m1") })
	time.Sleep(150 * time.Millisecond)
	require.True(t, f.srv.hub.Connected("m1"))
}

// Revisión: X-Forwarded-For falsificado (entradas a la izquierda) no da claves nuevas,
// y el techo global frena la rotación de IPs reales.
func TestPairLimiterRightmostXFFAndGlobalCeiling(t *testing.T) {
	_, _, h := newTestServer(t)
	try := func(remote, xff string) int {
		req := httptest.NewRequest("POST", "/api/pair", strings.NewReader(`{"code":"bad"}`))
		req.RemoteAddr = remote
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr.Code
	}
	for i := 0; i < 10; i++ {
		require.Equal(t, 400, try("127.0.0.1:1", fmt.Sprintf("10.9.9.%d, 192.0.2.7", i)))
	}
	require.Equal(t, 429, try("127.0.0.1:1", "10.1.1.1, 192.0.2.7"))
	require.Equal(t, "192.0.2.7", clientKey(func() *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "127.0.0.1:1"
		r.Header.Set("X-Forwarded-For", "1.2.3.4, 192.0.2.7")
		return r
	}()))

	_, _, h2 := newTestServer(t)
	h = h2
	n := 0
	for i := 0; i < 40; i++ {
		if try(fmt.Sprintf("198.51.100.%d:1", i), "") == 400 {
			n++
		}
	}
	require.Equal(t, 30, n) // tras 30 fallos en total, 429 para todos
	require.Equal(t, 429, try("203.0.113.200:1", ""))
}

// Revisión: un upsert viejo encolado antes de leer el snapshot no se reenvía tras él
// (resucitaría una sesión renombrada); los eventos sí; y un snapshot lento no deja al
// cliente por lento.
func TestSnapshotDropsOlderQueuedState(t *testing.T) {
	s, st, _ := newTestServer(t)
	l := s.live
	c := &liveClient{waiting: true}
	l.mu.Lock()
	l.clients[c] = struct{}{}
	l.mu.Unlock()
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: "B", Machine: "m", State: proto.StateIdle}))
	l.Publish(proto.Envelope{Type: "session_upsert", Session: "A", Payload: mustJSON(proto.SessionInfo{ID: "A", Machine: "m"})})
	l.Publish(proto.Envelope{Type: "event", Session: "B", Payload: mustJSON(proto.Event{Session: "B", Seq: 1, Kind: proto.KindInfo})})
	for i := 0; i < clientBuffer*2; i++ { // más de lo que cabría en el canal
		l.Publish(proto.Envelope{Type: "launch_result"})
	}
	l.mu.Lock()
	snapSeq := l.seq
	l.mu.Unlock()
	l.Publish(proto.Envelope{Type: "session_upsert", Session: "B", Payload: mustJSON(proto.SessionInfo{ID: "B", Machine: "m"})})
	send := l.ready(c, snapSeq)
	require.NotNil(t, send)
	var types []string
	for len(send) > 0 {
		e := <-send
		if e.Type != "launch_result" {
			types = append(types, e.Type+":"+e.Session)
		}
	}
	require.Equal(t, []string{"event:B", "session_upsert:B"}, types)
	l.mu.Lock()
	_, still := l.clients[c]
	l.mu.Unlock()
	require.True(t, still)
}

// Revisión: el previous_id guardado que repite cada hello no vuelve a consultar los
// asks de una sesión ya sembrada.
func TestHelloStoredPreviousIDDoesNotReseed(t *testing.T) {
	f := newAppFx(t, "A")
	f.machineSend(t, upsertEnv("B", "A", proto.StateIdle))
	eventually(t, func() bool {
		f.srv.asks.mu.Lock()
		defer f.srv.asks.mu.Unlock()
		return f.srv.asks.known["B"] && !f.srv.asks.known["A"]
	})
	_, err := f.st.AppendEvent(proto.Event{Session: "B", Kind: proto.KindAsk, Data: mustJSON(proto.Ask{AskID: "hidden"})})
	require.NoError(t, err)
	f.srv.asks.reseed(f.st, "B", "A") // lo que publica cada hello con previous_id=A
	f.srv.asks.mu.Lock()
	_, open := f.srv.asks.open["hidden"]
	f.srv.asks.mu.Unlock()
	require.False(t, open)
}
