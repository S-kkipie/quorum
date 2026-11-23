package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

type launchSessionPayload struct {
	ReqID     string `json:"reqId"`
	SessionID string `json:"sessionId"`
}

// waitLaunchSession espera un launch_session y devuelve su payload y si antes llegó
// el session_upsert de esa sesión.
func waitLaunchSession(t *testing.T, ch chan proto.Envelope) (launchSessionPayload, bool) {
	t.Helper()
	upserted := map[string]bool{}
	timeout := time.After(3 * time.Second)
	for {
		select {
		case e := <-ch:
			if e.Type == "session_upsert" {
				upserted[e.Session] = true
			}
			if e.Type == "launch_session" {
				var p launchSessionPayload
				require.NoError(t, json.Unmarshal(e.Payload, &p))
				require.Equal(t, p.SessionID, e.Session)
				return p, upserted[p.SessionID]
			}
		case <-timeout:
			t.Fatal("no llegó launch_session")
		}
	}
}

// noLaunchSession comprueba que no llega ningún launch_session en un rato.
func noLaunchSession(t *testing.T, ch chan proto.Envelope) {
	t.Helper()
	timeout := time.After(200 * time.Millisecond)
	for {
		select {
		case e := <-ch:
			require.NotEqual(t, "launch_session", e.Type, string(e.Payload))
		case <-timeout:
			return
		}
	}
}

func (f *appFx) upsertReq(t *testing.T, id, prev, root, req string) {
	p, _ := json.Marshal(proto.SessionInfo{ID: id, PreviousID: prev, Root: root, Cwd: root, State: proto.StateIdle,
		StartedAt: time.Now().UnixMilli(), LaunchReq: req, HerdrPane: "p_1"})
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: id, Payload: p})
}

func (f *appFx) pendingCount() int {
	f.srv.hub.mu.Lock()
	defer f.srv.hub.mu.Unlock()
	return len(f.srv.hub.pending)
}

func TestLaunchSessionPublishedByLaunchReq(t *testing.T) {
	f, proj, _ := linkFx(t)
	_, ch := f.live(t)
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/launch",
		`{"machine":"m1","dir":"/w/n","permissionMode":"default","resume":"abc","projectId":"`+proj.ID+`"}`, &res))
	lr := <-f.launches
	require.Equal(t, proto.LaunchRequest{ReqID: res.ReqID, Dir: "/w/n", PermissionMode: "default", Resume: "abc", Label: "p", Trust: true}, lr)

	// una sesión nueva en la misma carpeta pero sin el reqId no cumple un lanzamiento sin ticket
	f.upsertReq(t, "other", "", "/w/n", "")
	noLaunchSession(t, ch)
	require.Equal(t, 1, f.pendingCount())

	// otra carpeta, pero con el reqId: es la sesión lanzada
	f.upsertReq(t, "s1", "", "/w/elsewhere", res.ReqID)
	p, after := waitLaunchSession(t, ch)
	require.Equal(t, launchSessionPayload{ReqID: res.ReqID, SessionID: "s1"}, p)
	require.True(t, after, "launch_session va después del session_upsert de la sesión")
	require.Equal(t, 0, f.pendingCount())
}

func TestLaunchLabelExplicitAndNoTicketDedup(t *testing.T) {
	f, proj, _ := linkFx(t)
	var a, b struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/launch", `{"machine":"m1","dir":"/w/x","label":"mío","projectId":"`+proj.ID+`"}`, &a))
	require.Equal(t, "mío", (<-f.launches).Label)
	// dos lanzamientos sin ticket a la misma carpeta conviven
	require.Equal(t, 202, f.postJSON(t, "/api/launch", `{"machine":"m1","dir":"/w/x"}`, &b))
	lr := <-f.launches
	require.Equal(t, "", lr.Label)
	require.True(t, lr.Trust)
	require.Equal(t, 2, f.pendingCount())
}

func TestLaunchSessionAfterIDChange(t *testing.T) {
	f := newAppFx(t)
	_, ch := f.live(t)
	f.upsertReq(t, "old", "", "/w/r", "")
	eventually(t, func() bool { _, err := f.st.Session("old"); return err == nil })
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/launch", `{"machine":"m1","dir":"/w/r","resume":"old"}`, &res))
	<-f.launches
	// la sesión retomada llega con otro id que hereda la vieja (PreviousID aplicado)
	f.upsertReq(t, "new", "old", "/w/r", res.ReqID)
	p, after := waitLaunchSession(t, ch)
	require.Equal(t, launchSessionPayload{ReqID: res.ReqID, SessionID: "new"}, p)
	require.True(t, after)
	// un segundo upsert con el mismo reqId no vuelve a publicar
	f.upsertReq(t, "new", "", "/w/r", res.ReqID)
	noLaunchSession(t, ch)
}

func TestLaunchSessionExistingSameID(t *testing.T) {
	f := newAppFx(t)
	_, ch := f.live(t)
	f.upsertReq(t, "s1", "", "/w/r", "")
	eventually(t, func() bool { _, err := f.st.Session("s1"); return err == nil })
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/launch", `{"machine":"m1","dir":"/w/r","resume":"s1"}`, &res))
	<-f.launches
	f.upsertReq(t, "s1", "", "/w/r", res.ReqID)
	p, _ := waitLaunchSession(t, ch)
	require.Equal(t, launchSessionPayload{ReqID: res.ReqID, SessionID: "s1"}, p)
}

func TestTicketLaunchStillLinksByReq(t *testing.T) {
	f, _, ids := linkFx(t)
	_, ch := f.live(t)
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/tickets/"+ids["41"]+"/launch", `{"machine":"m1","checkoutRoot":"/w/t"}`, &res))
	lr := <-f.launches
	require.True(t, lr.Trust)
	require.Equal(t, "p", lr.Label)
	// otra carpeta (p. ej. un worktree), pero el reqId la ata al ticket
	f.upsertReq(t, "tk", "", "/w/elsewhere", res.ReqID)
	eventually(t, func() bool { return f.linked("tk")[ids["41"]] })
	p, _ := waitLaunchSession(t, ch)
	require.Equal(t, launchSessionPayload{ReqID: res.ReqID, SessionID: "tk"}, p)
	require.Equal(t, 0, f.pendingCount())
}

func TestTicketLaunchFolderRuleStillPublishes(t *testing.T) {
	f, _, ids := linkFx(t)
	_, ch := f.live(t)
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/tickets/"+ids["42"]+"/launch", `{"machine":"m1","checkoutRoot":"/w/f"}`, &res))
	<-f.launches
	// sin reqId (mod viejo): la regla por carpeta sigue valiendo para tickets
	f.upsertReq(t, "fold", "", "/w/f", "")
	eventually(t, func() bool { return f.linked("fold")[ids["42"]] })
	p, _ := waitLaunchSession(t, ch)
	require.Equal(t, launchSessionPayload{ReqID: res.ReqID, SessionID: "fold"}, p)
}

func TestForeignLaunchReqSkipsFolderRule(t *testing.T) {
	f, _, ids := linkFx(t)
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/tickets/"+ids["42"]+"/launch", `{"machine":"m1","checkoutRoot":"/w/g"}`, &res))
	<-f.launches
	// una sesión de otro lanzamiento (reqId ajeno) no cumple el del ticket aunque comparta carpeta
	f.upsertReq(t, "alien", "", "/w/g", "otro-req")
	eventually(t, func() bool { _, err := f.st.Session("alien"); return err == nil })
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, f.linked("alien"))
	require.Equal(t, 1, f.pendingCount())
}

// reconnectHello reconecta la máquina m1 con un hello que trae estas sesiones.
func (f *appFx) reconnectHello(t *testing.T, ss ...proto.SessionInfo) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.machTok}}})
	require.NoError(t, err)
	t.Cleanup(func() { c.CloseNow() })
	h := proto.MachineHello{Machine: "m1", OS: "linux", Env: "linux", Version: proto.Version, Sessions: ss}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "hello", Machine: "m1", Payload: mustJSON(h)}))
}

// La sesión lanzada llega primero en el hello de una reconexión: también se ata.
func TestLaunchSessionFromHello(t *testing.T) {
	f := newAppFx(t)
	var res struct{ ReqID string }
	require.Equal(t, 202, f.postJSON(t, "/api/launch", `{"machine":"m1","dir":"/w/h"}`, &res))
	<-f.launches
	_, ch := f.live(t)
	f.reconnectHello(t, proto.SessionInfo{ID: "h1", Machine: "m1", Root: "/w/h", Cwd: "/w/h", State: proto.StateIdle,
		StartedAt: time.Now().UnixMilli(), LaunchReq: res.ReqID, HerdrPane: "p_4"})
	p, after := waitLaunchSession(t, ch)
	require.Equal(t, launchSessionPayload{ReqID: res.ReqID, SessionID: "h1"}, p)
	require.True(t, after, "launch_session va después del session_upsert del hello")
	require.Equal(t, 0, f.pendingCount())
}

// Las sesiones republicadas desde la base (hello, snapshot, REST) conservan el panel de herdr.
func TestHelloRepublishKeepsHerdrPane(t *testing.T) {
	f := newAppFx(t)
	_, ch := f.live(t)
	f.reconnectHello(t, proto.SessionInfo{ID: "hp", Machine: "m1", State: proto.StateIdle, HerdrPane: "p_7", HerdrWorkspace: "w_7"})
	e := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "session_upsert" && e.Session == "hp" })
	var si proto.SessionInfo
	require.NoError(t, json.Unmarshal(e.Payload, &si))
	require.Equal(t, "p_7", si.HerdrPane)
	require.Equal(t, "w_7", si.HerdrWorkspace)
	ss, err := f.st.ListSessions(false)
	require.NoError(t, err)
	require.Len(t, ss, 1)
	require.Equal(t, "p_7", ss[0].HerdrPane)
}
