package hub

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

const sentinel = "SENTINEL-tok-9f3a"

func (f *appFx) req(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	r, _ := http.NewRequest(method, f.ts.URL+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(r)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (f *appFx) reqJSON(t *testing.T, method, path, body string, want int, v any) {
	t.Helper()
	code, b := f.req(t, method, path, body)
	require.Equal(t, want, code, b)
	if v != nil {
		require.NoError(t, json.Unmarshal([]byte(b), v))
	}
}

func TestProjectAPICRUD(t *testing.T) {
	f, p, ids := linkFx(t)
	var wss []proto.Workspace
	f.reqJSON(t, "GET", "/api/workspaces", "", 200, &wss)
	require.Len(t, wss, 1)
	var ws proto.Workspace
	f.reqJSON(t, "PATCH", "/api/workspaces/"+wss[0].ID, `{"color":"#fff","whoasProfile":"acme"}`, 200, &ws)
	require.Equal(t, "w", ws.Name)
	require.Equal(t, "#fff", ws.Color)
	require.Equal(t, "acme", ws.WhoasProfile)
	code, _ := f.req(t, "PATCH", "/api/workspaces/nope", `{"name":"x"}`)
	require.Equal(t, 404, code)
	code, b := f.req(t, "PATCH", "/api/workspaces/"+ws.ID, `{"name":" "}`)
	require.Equal(t, 400, code, b)
	code, b = f.req(t, "DELETE", "/api/workspaces/"+ws.ID, "")
	require.Equal(t, 409, code)
	require.JSONEq(t, `{"error":"el trabajo tiene proyectos"}`, b)

	var ws2 proto.Workspace
	f.reqJSON(t, "POST", "/api/workspaces", `{"name":"otro"}`, 201, &ws2)
	var ps []proto.Project
	f.reqJSON(t, "GET", "/api/projects?workspace="+ws2.ID, "", 200, &ps)
	require.Empty(t, ps)
	f.reqJSON(t, "GET", "/api/projects?workspace="+ws.ID, "", 200, &ps)
	require.Len(t, ps, 1)
	f.reqJSON(t, "GET", "/api/projects", "", 200, &ps)
	require.Len(t, ps, 1)
	var got proto.Project
	f.reqJSON(t, "GET", "/api/projects/"+p.ID, "", 200, &got)
	require.Equal(t, "p", got.Name)
	code, _ = f.req(t, "GET", "/api/projects/nope", "")
	require.Equal(t, 404, code)

	// validación del conector
	for _, bad := range []string{
		`{"connector":{"kind":"jira","intervalMin":5}}`,
		`{"connector":{"kind":"github","intervalMin":0}}`,
		`{"connector":{"kind":"github","intervalMin":61}}`,
		`{"connector":{"kind":"github","intervalMin":5,"settings":{"a":1}}}`,
		`{"workspaceId":"nope"}`,
	} {
		code, b = f.req(t, "PATCH", "/api/projects/"+p.ID, bad)
		require.GreaterOrEqual(t, code, 400, bad)
		require.Less(t, code, 500, bad+b)
	}
	f.reqJSON(t, "PATCH", "/api/projects/"+p.ID,
		`{"name":"p2","workspaceId":"`+ws2.ID+`","connector":{"kind":"github","intervalMin":10,"settings":{"repo":"o/r"}}}`, 200, &got)
	require.Equal(t, "p2", got.Name)
	require.Equal(t, ws2.ID, got.WorkspaceID)
	require.Equal(t, "github", got.Connector.Kind)
	require.Equal(t, 10, got.Connector.IntervalMin)
	require.Equal(t, "o/r", got.Connector.Settings["repo"])
	require.Equal(t, linkRepo, got.RepoURL)

	// repo con credenciales: se limpian
	f.reqJSON(t, "PATCH", "/api/projects/"+p.ID, `{"repoURL":"https://user:pw@github.com/o/r2"}`, 200, &got)
	require.NotContains(t, got.RepoURL, "pw")
	require.Equal(t, "o/r", got.Connector.Settings["repo"])

	// token
	code, b = f.req(t, "PUT", "/api/projects/"+p.ID+"/token", `{"token":"`+sentinel+`"}`)
	require.Equal(t, 204, code, b)
	f.reqJSON(t, "GET", "/api/projects/"+p.ID, "", 200, &got)
	require.True(t, got.Connector.HasToken)
	code, _ = f.req(t, "PUT", "/api/projects/nope/token", `{"token":"x"}`)
	require.Equal(t, 404, code)

	// tickets y vínculos (cambiar a github borró los del origen anterior: se siembran de nuevo)
	f.mach.CloseNow()
	require.NoError(t, f.st.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "41", Title: "login", Status: "por_hacer"}, {ExternalID: "42", Title: "otro", Status: "por_hacer"},
		{ExternalID: "x1", Title: "[ACME-12] pagos", Status: "por_hacer"},
	}))
	if ts, err := f.st.ListTickets(p.ID); err == nil {
		for _, tk := range ts {
			ids[tk.ExternalID] = tk.ID
		}
	}
	require.NoError(t, f.st.LinkSessionTicket(proto.SessionTicket{SessionID: "s1", TicketID: ids["41"], Confirmed: true}))
	var tv []struct {
		ID       string
		Sessions []struct {
			SessionID string
			Confirmed bool
		}
	}
	f.reqJSON(t, "GET", "/api/projects/"+p.ID+"/tickets", "", 200, &tv)
	require.Len(t, tv, 3)
	n := 0
	for _, x := range tv {
		if x.ID == ids["41"] {
			require.Len(t, x.Sessions, 1)
			require.True(t, x.Sessions[0].Confirmed)
			n++
		} else {
			require.NotNil(t, x.Sessions)
			require.Empty(t, x.Sessions)
		}
	}
	require.Equal(t, 1, n)
	code, _ = f.req(t, "GET", "/api/projects/nope/tickets", "")
	require.Equal(t, 404, code)

	_, err := f.st.CreateProposal(proto.Proposal{TicketID: ids["41"], Kind: "comment", Body: "hola", Status: "pendiente"})
	require.NoError(t, err)
	var td struct {
		ID        string
		Title     string
		Sessions  []map[string]any
		Proposals []proto.Proposal
	}
	f.reqJSON(t, "GET", "/api/tickets/"+ids["41"], "", 200, &td)
	require.Equal(t, "login", td.Title)
	require.Len(t, td.Sessions, 1)
	require.Len(t, td.Proposals, 1)
	code, _ = f.req(t, "GET", "/api/tickets/nope", "")
	require.Equal(t, 404, code)
	var pl []proto.Proposal
	f.reqJSON(t, "GET", "/api/proposals?ticket="+ids["41"], "", 200, &pl)
	require.Len(t, pl, 1)
	f.reqJSON(t, "GET", "/api/proposals?ticket="+ids["42"], "", 200, &pl)
	require.Empty(t, pl)

	// token vacío lo borra
	code, _ = f.req(t, "PUT", "/api/projects/"+p.ID+"/token", `{"token":""}`)
	require.Equal(t, 204, code)
	f.reqJSON(t, "GET", "/api/projects/"+p.ID, "", 200, &got)
	require.False(t, got.Connector.HasToken)

	// borrar
	code, _ = f.req(t, "DELETE", "/api/projects/"+p.ID, "")
	require.Equal(t, 204, code)
	code, _ = f.req(t, "GET", "/api/projects/"+p.ID, "")
	require.Equal(t, 404, code)
	code, _ = f.req(t, "DELETE", "/api/projects/"+p.ID, "")
	require.Equal(t, 404, code)
	code, _ = f.req(t, "DELETE", "/api/workspaces/"+ws.ID, "")
	require.Equal(t, 204, code)
}

func TestProjectAPILiveAndNoToken(t *testing.T) {
	f, p, ids := linkFx(t)
	var out []string
	_, ch := f.live(t) // antes de poner el token
	types := []string{}
	for !(slices.Contains(types, "workspace_upsert") && slices.Contains(types, "project_upsert")) {
		select {
		case env := <-ch:
			types = append(types, env.Type)
			bb, _ := json.Marshal(env)
			out = append(out, string(bb))
		case <-time.After(3 * time.Second):
			t.Fatalf("snapshot incompleto: %v", types)
		}
	}
	// workspace/project llegan después de máquinas y sesiones
	first := min(slices.Index(types, "workspace_upsert"), slices.Index(types, "project_upsert"))
	for i, ty := range types {
		if ty == "machine_status" || ty == "session_upsert" {
			require.Less(t, i, first, types)
		}
	}
	require.Contains(t, types, "machine_status")

	code, _ := f.req(t, "PUT", "/api/projects/"+p.ID+"/token", `{"token":"`+sentinel+`"}`)
	require.Equal(t, 204, code)
	_, b := f.req(t, "PATCH", "/api/projects/"+p.ID, `{"connector":{"kind":"exec","intervalMin":5,"settings":{"cmd":"x"}}}`)
	out = append(out, b)
	_, err := f.st.CreateProposal(proto.Proposal{TicketID: ids["41"], Kind: "comment", Body: "x", Status: "pendiente"})
	require.NoError(t, err)
	for _, e := range []string{"GET /api/workspaces", "GET /api/projects", "GET /api/projects/" + p.ID,
		"GET /api/projects/" + p.ID + "/tickets", "GET /api/tickets/" + ids["41"], "GET /api/proposals?ticket=" + ids["41"],
		"GET /api/projects/suggestions", "GET /api/sessions", "GET /api/machines"} {
		m, path, _ := strings.Cut(e, " ")
		_, b := f.req(t, m, path, "")
		out = append(out, b)
	}

	// cambios en vivo
	var ws proto.Workspace
	f.reqJSON(t, "POST", "/api/workspaces", `{"name":"nuevo"}`, 201, &ws)
	f.reqJSON(t, "PATCH", "/api/workspaces/"+ws.ID, `{"name":"n2"}`, 200, nil)
	f.req(t, "DELETE", "/api/workspaces/"+ws.ID, "")
	f.req(t, "DELETE", "/api/projects/"+p.ID, "")
	want := map[string]bool{"workspace_gone": false, "project_gone": false}
	sawToken := false
	for !(want["workspace_gone"] && want["project_gone"]) {
		select {
		case env := <-ch:
			bb, _ := json.Marshal(env)
			out = append(out, string(bb))
			if _, ok := want[env.Type]; ok {
				want[env.Type] = true
			}
			if env.Type == "project_upsert" && strings.Contains(string(env.Payload), `"hasToken":true`) {
				sawToken = true
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("faltan envelopes: %v", want)
		}
	}
	require.True(t, sawToken, "project_upsert tras poner el token")
	for _, s := range out {
		require.NotContains(t, s, sentinel)
	}
}

func TestProjectAPIDefaultsAndMessages(t *testing.T) {
	f, p, _ := linkFx(t)
	var got proto.Project
	f.reqJSON(t, "PATCH", "/api/projects/"+p.ID, `{"connector":{"kind":"github","settings":{"repo":"o/r"}}}`, 200, &got)
	require.Equal(t, 5, got.Connector.IntervalMin)
	code, _ := f.req(t, "PATCH", "/api/projects/"+p.ID, `{"connector":{"intervalMin":0}}`)
	require.Equal(t, 400, code)
	f.reqJSON(t, "POST", "/api/projects", `{"workspaceId":"`+p.WorkspaceID+`","name":"c","connector":{"kind":"exec"}}`, 201, &got)
	require.Equal(t, 5, got.Connector.IntervalMin)
	require.Equal(t, "exec", got.Connector.Kind)
	code, _ = f.req(t, "POST", "/api/projects", `{"workspaceId":"`+p.WorkspaceID+`","name":"c","connector":{"kind":"zzz"}}`)
	require.Equal(t, 400, code)

	code, b := f.req(t, "PATCH", "/api/projects/"+p.ID, `{"workspaceId":"nope"}`)
	require.Equal(t, 404, code)
	require.JSONEq(t, `{"error":"trabajo no encontrado"}`, b)
	code, b = f.req(t, "PATCH", "/api/projects/nope", `{"name":"x"}`)
	require.Equal(t, 404, code)
	require.JSONEq(t, `{"error":"proyecto no encontrado"}`, b)
}

func TestProjectAPIRequiresDevice(t *testing.T) {
	_, _, h := newTestServer(t)
	for _, e := range []string{"GET /api/workspaces", "GET /api/projects", "GET /api/tickets/x", "GET /api/projects/x/checkouts", "GET /api/proposals", "PUT /api/projects/x/token"} {
		m, p, _ := strings.Cut(e, " ")
		require.Equal(t, 401, do(h, m, p, "", nil).Code, e)
	}
}

func TestProjectCheckoutsAPI(t *testing.T) {
	f, p, _ := linkFx(t)
	var cos []proto.Checkout
	f.reqJSON(t, "GET", "/api/projects/"+p.ID+"/checkouts", "", 200, &cos)
	require.NotNil(t, cos)
	require.Empty(t, cos)
	_, err := f.st.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m1", Root: "/srv/r", RepoURL: linkRepo, Branch: "main"})
	require.NoError(t, err)
	_, err = f.st.UpsertCheckout(proto.Checkout{Machine: "m1", Root: "/otro", RepoURL: "git@x:o/otro.git"})
	require.NoError(t, err)
	f.reqJSON(t, "GET", "/api/projects/"+p.ID+"/checkouts", "", 200, &cos)
	require.Len(t, cos, 1)
	require.Equal(t, "m1", cos[0].Machine)
	require.Equal(t, "/srv/r", cos[0].Root)
	require.Equal(t, "main", cos[0].Branch)
	require.NotEmpty(t, cos[0].ID)
	code, b := f.req(t, "GET", "/api/projects/nope/checkouts", "")
	require.Equal(t, 404, code)
	require.JSONEq(t, `{"error":"proyecto no encontrado"}`, b)
}
