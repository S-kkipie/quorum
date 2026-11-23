package hub

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

const linkRepo = "https://github.com/o/r"

func linkFx(t *testing.T) (*appFx, proto.Project, map[string]string) {
	f := newAppFx(t)
	var ws proto.Workspace
	require.Equal(t, 201, f.postJSON(t, "/api/workspaces", `{"name":"w"}`, &ws))
	var p proto.Project
	require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"p","repoURL":"`+linkRepo+`"}`, &p))
	require.NoError(t, f.st.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "41", Title: "login", Status: "por_hacer"}, {ExternalID: "42", Title: "otro", Status: "por_hacer"},
		{ExternalID: "x1", Title: "[ACME-12] pagos", Status: "por_hacer"},
	}))
	ts, _ := f.st.ListTickets(p.ID)
	ids := map[string]string{}
	for _, tk := range ts {
		ids[tk.ExternalID] = tk.ID
	}
	return f, p, ids
}

func (f *appFx) linked(sid string) map[string]bool {
	ls, _ := f.st.SessionTickets(sid)
	m := map[string]bool{}
	for _, l := range ls {
		m[l.TicketID] = l.Confirmed
	}
	return m
}

func (f *appFx) del(t *testing.T, path string) int {
	req, _ := http.NewRequest("DELETE", f.ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	return resp.StatusCode
}

func TestBranchSuggestions(t *testing.T) {
	f, _, ids := linkFx(t)
	cases := []struct {
		sid, branch string
		want        []string
	}{
		{"s1", "feat/41-login", []string{"41"}},
		{"s2", "GH-41", []string{"41"}},
		{"s3", "fix_41", []string{"41"}},
		{"s4", "release-2026", nil},
		{"s5", "feat/acme-12-pagos", []string{"x1"}},
	}
	for _, c := range cases {
		f.upsert(t, c.sid, "/r/"+c.sid, linkRepo, c.branch)
		want := map[string]bool{}
		for _, w := range c.want {
			want[ids[w]] = false
		}
		require.Eventually(t, func() bool {
			got := f.linked(c.sid)
			if len(want) == 0 {
				return true
			}
			return len(got) == len(want)
		}, 3*time.Second, 20*time.Millisecond, c.branch)
		time.Sleep(30 * time.Millisecond)
		require.Equal(t, want, f.linked(c.sid), c.branch)
	}
}

func TestNoProjectNoSuggestion(t *testing.T) {
	f, _, _ := linkFx(t)
	f.upsert(t, "sn", "/r/n", "https://github.com/other/x", "feat/41-login")
	time.Sleep(100 * time.Millisecond)
	require.Empty(t, f.linked("sn"))
}

func TestConfirmUnlinkDismiss(t *testing.T) {
	f, _, ids := linkFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/41-login")
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 1 }, 3*time.Second, 20*time.Millisecond)

	require.Equal(t, 404, f.postJSON(t, "/api/sessions/s1/ticket", `{"ticketId":"nope"}`, nil))
	require.Equal(t, 200, f.postJSON(t, "/api/sessions/s1/ticket", `{"ticketId":"`+ids["41"]+`"}`, nil))
	require.True(t, f.linked("s1")[ids["41"]])
	// confirmar otro degrada el confirmado anterior a sugerido
	require.Equal(t, 200, f.postJSON(t, "/api/sessions/s1/ticket", `{"ticketId":"`+ids["42"]+`"}`, nil))
	require.Equal(t, map[string]bool{ids["41"]: false, ids["42"]: true}, f.linked("s1"))

	require.Equal(t, 204, f.del(t, "/api/sessions/s1/ticket?ticketId="+ids["41"]))
	require.Equal(t, map[string]bool{ids["42"]: true}, f.linked("s1"))
	// no se vuelve a sugerir tras desasociar
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/41-login")
	time.Sleep(150 * time.Millisecond)
	require.NotContains(t, f.linked("s1"), ids["41"])
	// una sugerencia nunca degrada un confirmado
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/42-x")
	time.Sleep(150 * time.Millisecond)
	require.True(t, f.linked("s1")[ids["42"]])
}

func TestTicketCommand(t *testing.T) {
	f, _, ids := linkFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "main")
	send := func(tk string) {
		d, _ := json.Marshal(map[string]string{"ticket": tk})
		ev, _ := json.Marshal(proto.Event{Session: "s1", Kind: proto.KindTicket, Data: d})
		f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: ev})
	}
	send("41")
	require.Eventually(t, func() bool { return f.linked("s1")[ids["41"]] }, 3*time.Second, 20*time.Millisecond)
	send("999")
	require.Eventually(t, func() bool {
		evs, _ := f.st.Events("s1", 0, 20)
		for _, e := range evs {
			if e.Kind == proto.KindInfo && string(e.Data) == `{"text":"No encontré el ticket 999 en este proyecto"}` {
				return true
			}
		}
		return false
	}, 3*time.Second, 20*time.Millisecond)
	send("-")
	send("")
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 0 }, 3*time.Second, 20*time.Millisecond)
}

func TestTurnEndMentionSuggests(t *testing.T) {
	f, _, ids := linkFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "main")
	d, _ := json.Marshal(proto.TurnEnd{Answer: "listo, cierra #42"})
	ev, _ := json.Marshal(proto.Event{Session: "s1", Kind: proto.KindTurnEnd, Data: d})
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: ev})
	require.Eventually(t, func() bool { v, ok := f.linked("s1")[ids["42"]]; return ok && !v }, 3*time.Second, 20*time.Millisecond)
}

func TestRenameMovesLinks(t *testing.T) {
	f, _, ids := linkFx(t)
	f.upsert(t, "old", "/r/1", linkRepo, "main")
	require.Eventually(t, func() bool { si, err := f.st.Session("old"); return err == nil && si.ProjectID != "" }, 3*time.Second, 20*time.Millisecond)
	require.Equal(t, 200, f.postJSON(t, "/api/sessions/old/ticket", `{"ticketId":"`+ids["41"]+`"}`, nil))
	require.NoError(t, f.st.DismissSessionTicket("old", ids["42"]))
	// conflicto: ambas tenían un confirmado distinto; gana el de la nueva
	require.NoError(t, f.st.LinkSessionTicket(proto.SessionTicket{SessionID: "new", TicketID: ids["x1"], Confirmed: true}))
	_, liveCh := f.live(t)
	p, _ := json.Marshal(proto.SessionInfo{ID: "new", PreviousID: "old", Root: "/r/1", Cwd: "/r/1", State: proto.StateIdle, RepoURL: linkRepo, Branch: "main"})
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "new", Payload: p})
	require.Eventually(t, func() bool { return len(f.linked("new")) == 2 && f.linked("new")[ids["x1"]] }, 3*time.Second, 20*time.Millisecond)
	require.Equal(t, map[string]bool{ids["41"]: false, ids["x1"]: true}, f.linked("new"))
	require.Empty(t, f.linked("old"))
	seen := map[string]int{}
	deadline := time.After(500 * time.Millisecond)
loop:
	for {
		select {
		case env := <-liveCh:
			if env.Type == "session_ticket" && env.Session == "new" {
				var l proto.SessionTicket
				require.NoError(t, json.Unmarshal(env.Payload, &l))
				require.Equal(t, "new", l.SessionID)
				seen[l.TicketID]++
			}
		case <-deadline:
			break loop
		}
	}
	require.Equal(t, map[string]int{ids["41"]: 1, ids["x1"]: 1}, seen)
	// el descarte también viajó: no se vuelve a sugerir
	ok, err := f.st.SuggestSessionTicket("new", ids["42"])
	require.NoError(t, err)
	require.False(t, ok)
}

func TestUnlinkCommandNoResuggest(t *testing.T) {
	f, _, ids := linkFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/41-login")
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 1 }, 3*time.Second, 20*time.Millisecond)
	require.Equal(t, 200, f.postJSON(t, "/api/sessions/s1/ticket", `{"ticketId":"`+ids["41"]+`"}`, nil))
	d, _ := json.Marshal(map[string]string{"ticket": ""})
	ev, _ := json.Marshal(proto.Event{Session: "s1", Kind: proto.KindTicket, Data: d})
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: ev})
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 0 }, 3*time.Second, 20*time.Millisecond)
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/41-other")
	time.Sleep(150 * time.Millisecond)
	require.Empty(t, f.linked("s1"))
}

func TestTurnEndDedupeAndEndpointGuards(t *testing.T) {
	f, _, ids := linkFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "main")
	for i := 0; i < 2; i++ {
		d, _ := json.Marshal(proto.TurnEnd{Answer: "ver #42 y #42"})
		ev, _ := json.Marshal(proto.Event{Session: "s1", Kind: proto.KindTurnEnd, Data: d})
		f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: ev})
	}
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 1 }, 3*time.Second, 20*time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	require.Equal(t, map[string]bool{ids["42"]: false}, f.linked("s1"))
	require.Equal(t, 404, f.del(t, "/api/sessions/s1/ticket?ticketId=nope"))
	// sesión de servicio: no se asocia
	p, _ := json.Marshal(proto.SessionInfo{ID: "svc", Role: proto.RoleService, Root: "/r/s", Cwd: "/r/s", State: proto.StateIdle, RepoURL: linkRepo})
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: "svc", Payload: p})
	require.Eventually(t, func() bool { _, err := f.st.Session("svc"); return err == nil }, 3*time.Second, 20*time.Millisecond)
	require.Equal(t, 409, f.postJSON(t, "/api/sessions/svc/ticket", `{"ticketId":"`+ids["41"]+`"}`, nil))
}

// Regresión e2e Plan 2: una sesión en feat/41-… abierta antes de crear el proyecto no
// recibía la sugerencia: al adoptar el checkout aún no hay tickets y, cuando la primera
// sincronización los trae, nadie volvía a mirar la rama (hasta otro upsert de la sesión).
func TestSuggestAfterProjectCreateAndFirstSync(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("conector exec con script de shell")
	}
	f := newAppFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/41-login")
	eventually(t, func() bool { _, err := f.st.Session("s1"); return err == nil })
	script := filepath.Join(t.TempDir(), "conn.sh")
	require.NoError(t, os.WriteFile(script, []byte("#!/bin/sh\ncat >/dev/null\necho '{\"tickets\":[{\"externalId\":\"41\",\"title\":\"login\",\"rawStatus\":\"open\"}]}'\n"), 0o755))
	var ws proto.Workspace
	require.Equal(t, 201, f.postJSON(t, "/api/workspaces", `{"name":"w"}`, &ws))
	var p proto.Project
	require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"p","repoURL":"`+linkRepo+
		`","connector":{"kind":"exec","settings":{"command":"`+script+`"}}}`, &p))
	require.Equal(t, 202, f.postJSON(t, "/api/projects/"+p.ID+"/sync", `{}`, nil))
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 1 }, 3*time.Second, 20*time.Millisecond)
}

// Al adoptar checkouts de un proyecto que ya tiene tickets (p. ej. al ponerle el remoto
// después), las sesiones vivas reciben la sugerencia de su rama.
func TestSuggestOnAdoptWithExistingTickets(t *testing.T) {
	f := newAppFx(t)
	f.upsert(t, "s1", "/r/1", linkRepo, "feat/41-login")
	eventually(t, func() bool { _, err := f.st.Session("s1"); return err == nil })
	var ws proto.Workspace
	require.Equal(t, 201, f.postJSON(t, "/api/workspaces", `{"name":"w"}`, &ws))
	var p proto.Project
	require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"p"}`, &p))
	require.NoError(t, f.st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "41", Title: "login", Status: "por_hacer"}}))
	code, _ := f.req(t, "PATCH", "/api/projects/"+p.ID, `{"repoURL":"`+linkRepo+`"}`)
	require.Equal(t, 200, code)
	require.Eventually(t, func() bool { return len(f.linked("s1")) == 1 }, 3*time.Second, 20*time.Millisecond)
}
