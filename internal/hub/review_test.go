package hub

// Regresiones de la revisión final de la etapa 1.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

// Important 1: la caída de una máquina cierra sus sesiones y las apps se enteran.
func TestExpirePublishesSessionGone(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1", "s2")
	eventually(t, func() bool { return online(f, "m1") })
	c.Close(websocket.StatusNormalClosure, "")
	eventually(t, func() bool { f.clock.mu.Lock(); defer f.clock.mu.Unlock(); return len(f.clock.timers) == 1 })
	f.cap.mu.Lock()
	f.cap.envs = nil
	f.cap.mu.Unlock()
	f.clock.advance(61 * time.Second)
	f.cap.mu.Lock()
	defer f.cap.mu.Unlock()
	var gone []string
	for _, e := range f.cap.envs {
		if e.Type == "session_gone" {
			gone = append(gone, e.Session)
		}
	}
	require.ElementsMatch(t, []string{"s1", "s2"}, gone)
	require.Equal(t, "machine_status", f.cap.envs[len(f.cap.envs)-1].Type)
}

// Important 1: una sesión que reaparece con el hello llega a las apps.
func TestHelloSessionReachesLiveApps(t *testing.T) {
	f := newAppFx(t)
	_, ch := f.live(t)
	waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "machine_status" }) // snapshot
	f.mach.CloseNow()
	f.connectMachine(t, "s9")
	e := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" })
	require.Equal(t, "s9", e.Session)
}

// Important 2: el renombre queda en el store y sale en el snapshot y en el REST.
func TestPreviousIDInSnapshotAndREST(t *testing.T) {
	f := newAppFx(t, "a")
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "b", Payload: mustJSON(proto.SessionInfo{ID: "b", PreviousID: "a", State: proto.StateIdle})})
	eventually(t, func() bool { si, err := f.st.Session("b"); return err == nil && si.PreviousID == "a" })
	// un upsert posterior sin previousId no lo borra
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "b", Payload: mustJSON(proto.SessionInfo{ID: "b", State: proto.StateWorking})})
	eventually(t, func() bool { si, _ := f.st.Session("b"); return si.State == proto.StateWorking })
	_, ch := f.live(t)
	e := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" })
	var si proto.SessionInfo
	require.NoError(t, json.Unmarshal(e.Payload, &si))
	require.Equal(t, "a", si.PreviousID)

	req, _ := http.NewRequest("GET", f.ts.URL+"/api/sessions?closed=1", nil)
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var list []proto.SessionInfo
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	require.Len(t, list, 1)
	require.Equal(t, "a", list[0].PreviousID)
}

// Important 5: reiniciar el daemon (hello vacío y luego re-registro) no deja la tarjeta muerta.
func TestAsksSurviveDaemonRestart(t *testing.T) {
	f := newAppFx(t, "s1")
	f.machineSend(t, askEnv("s1", "a1"))
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return len(f.srv.asks.open) == 1 })
	f.mach.CloseNow()
	f.connectMachine(t) // daemon nuevo: hello sin sesiones → s1 cerrada
	eventually(t, func() bool { si, _ := f.st.Session("s1"); return si.State == proto.StateClosed })
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "s1", Payload: mustJSON(proto.SessionInfo{ID: "s1", State: proto.StateNeedsYou})})
	eventually(t, func() bool { si, _ := f.st.Session("s1"); return si.State == proto.StateNeedsYou })
	require.Equal(t, 202, f.post("/api/sessions/s1/decide", `{"askId":"a1","decision":"allow"}`).StatusCode)
	require.Equal(t, "decide", f.nextCmd(t).Type)
}

// Important 5: con /clear los asks de la sesión vieja se contestan en la nueva.
func TestAsksFollowRename(t *testing.T) {
	f := newAppFx(t, "s1")
	f.machineSend(t, askEnv("s1", "a1"))
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return len(f.srv.asks.open) == 1 })
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "s2", Payload: mustJSON(proto.SessionInfo{ID: "s2", PreviousID: "s1", State: proto.StateNeedsYou})})
	eventually(t, func() bool { f.srv.asks.mu.Lock(); defer f.srv.asks.mu.Unlock(); return f.srv.asks.open["a1"] == "s2" })
	require.Equal(t, 202, f.post("/api/sessions/s2/decide", `{"askId":"a1","decision":"deny"}`).StatusCode)
	require.Equal(t, "decide", f.nextCmd(t).Type)
	// ya resuelto: un upsert posterior no lo reabre
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "s2", Payload: mustJSON(proto.SessionInfo{ID: "s2", State: proto.StateWorking})})
	eventually(t, func() bool { si, _ := f.st.Session("s2"); return si.State == proto.StateWorking })
	code, _ := f.postBody("/api/sessions/s2/decide", `{"askId":"a1","decision":"allow"}`)
	require.Equal(t, 409, code)
}

// Important 8: al arrancar, ninguna máquina figura en línea hasta su hello.
func TestStartupMarksMachinesOffline(t *testing.T) {
	_, st, _ := newTestServer(t)
	require.NoError(t, st.UpsertMachine("m1", "linux", "linux", "1", true, proto.MachineCaps{}))
	NewServer(st)
	ms, _ := st.ListMachines()
	require.Len(t, ms, 1)
	require.False(t, ms[0].Online)
}

// Minor: una máquina no difunde tipos desconocidos ni falsifica machine_status.
func TestMachineEnvelopeWhitelist(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	ctx := context.Background()
	fake := mustJSON(map[string]any{"name": "otra", "online": true})
	require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "machine_status", Payload: fake}))
	require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "wat"}))
	require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "launch_result", Payload: mustJSON(proto.LaunchResult{ReqID: "r"})}))
	eventually(t, func() bool { ts := f.cap.types(); return len(ts) > 0 && ts[len(ts)-1] == "launch_result" })
	require.Equal(t, []string{"session_upsert", "machine_status", "launch_result"}, f.cap.types())
}

// Minor: revocar un token cierra sus WebSockets vivos.
func TestRevokedTokenClosesLiveSockets(t *testing.T) {
	old := tokenRecheck.Swap(int64(20 * time.Millisecond))
	t.Cleanup(func() { tokenRecheck.Store(old) })
	f := newAppFx(t, "s1")
	f.live(t)
	liveN := func() int { f.srv.live.mu.Lock(); defer f.srv.live.mu.Unlock(); return len(f.srv.live.clients) }
	eventually(t, func() bool { return liveN() == 1 })
	time.Sleep(60 * time.Millisecond) // varias comprobaciones con el token aún válido
	require.Equal(t, 1, liveN())
	require.True(t, f.srv.hub.Connected("m1"))
	require.NoError(t, f.st.RevokeToken("device", "tel"))
	require.NoError(t, f.st.RevokeToken("machine", "m1"))
	eventually(t, func() bool { return liveN() == 0 })
	eventually(t, func() bool { return !f.srv.hub.Connected("m1") })
}

// Minor: /api/pair y /api/link frenan la fuerza bruta de códigos.
func TestPairLinkRateLimited(t *testing.T) {
	s, st, h := newTestServer(t)
	_ = s
	for i := 0; i < 10; i++ {
		path := "/api/pair"
		if i%2 == 1 {
			path = "/api/link"
		}
		rr := do(h, "POST", path, fmt.Sprintf(`{"code":"x%d","machine":"m"}`, i), nil)
		require.Equal(t, 400, rr.Code)
	}
	code, err := st.CreateCode("pair")
	require.NoError(t, err)
	rr := do(h, "POST", "/api/pair", `{"code":"`+code+`"}`, nil)
	require.Equal(t, 429, rr.Code)
	require.JSONEq(t, `{"error":"demasiados intentos, espera un minuto"}`, rr.Body.String())
	// pasado el minuto vuelve a aceptar
	s.fails.now = func() time.Time { return time.Now().Add(61 * time.Second) }
	rr = do(h, "POST", "/api/pair", `{"code":"`+code+`"}`, nil)
	require.Equal(t, 200, rr.Code, rr.Body.String())
}
