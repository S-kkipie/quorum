package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func (f *appFx) get(t *testing.T, path string, v any) {
	t.Helper()
	req, _ := http.NewRequest("GET", f.ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.NoError(t, json.NewDecoder(resp.Body).Decode(v))
}

func (f *appFx) postJSON(t *testing.T, path, body string, v any) int {
	t.Helper()
	req, _ := http.NewRequest("POST", f.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	if v != nil {
		require.NoError(t, json.NewDecoder(resp.Body).Decode(v))
	}
	return resp.StatusCode
}

// second conecta una segunda máquina (m2) con sesión s2 en root, con repo y rama.
func (f *appFx) second(t *testing.T, id, root, repo string) *websocket.Conn {
	t.Helper()
	tok, _ := NewToken()
	require.NoError(t, f.st.AddToken("machine", "m2", tok))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok}}})
	require.NoError(t, err)
	t.Cleanup(func() { c.CloseNow() })
	p, _ := json.Marshal(proto.MachineHello{Machine: "m2", OS: "linux", Env: "linux", Version: "t",
		Sessions: []proto.SessionInfo{{ID: id, Root: root, Cwd: root, State: proto.StateIdle, RepoURL: repo, Branch: "dev", ProjectID: "evil"}}})
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "hello", Payload: p}))
	eventually(t, func() bool { _, err := f.st.Session(id); return err == nil })
	return c
}

func (f *appFx) upsert(t *testing.T, id, root, repo, branch string) {
	p, _ := json.Marshal(proto.SessionInfo{ID: id, Root: root, Cwd: root, State: proto.StateIdle, RepoURL: repo, Branch: branch, ProjectID: "evil"})
	f.machineSend(t, proto.Envelope{Type: "session_upsert", Session: id, Payload: p})
}

func TestSuggestionsAcceptAttachCheckouts(t *testing.T) {
	f := newAppFx(t)
	_, ch := f.live(t)
	f.upsert(t, "s1", "/w/r", "git@github.com:o/r.git", "main")
	eventually(t, func() bool { _, err := f.st.Session("s1"); return err == nil })
	f.second(t, "s2", "/home/r", "https://github.com/O/r")
	f.upsert(t, "s3", "/w/other", "", "")

	var sug []struct {
		RepoURL  string `json:"repoURL"`
		Roots    []struct{ Machine, Root string }
		Sessions int
	}
	f.get(t, "/api/projects/suggestions", &sug)
	require.Len(t, sug, 1)
	require.Len(t, sug[0].Roots, 2)
	require.Equal(t, 2, sug[0].Sessions)

	si, _ := f.st.Session("s1")
	require.Equal(t, "", si.ProjectID, "el projectId nunca lo dicta el mod")
	require.Equal(t, "main", si.Branch)

	var ws proto.Workspace
	require.Equal(t, 201, f.postJSON(t, "/api/workspaces", `{"name":"T"}`, &ws))
	var p proto.Project
	require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"R","repoURL":"https://github.com/o/r"}`, &p))

	cos, err := f.st.ListCheckouts(p.ID)
	require.NoError(t, err)
	require.Len(t, cos, 2)
	f.get(t, "/api/projects/suggestions", &sug)
	require.Len(t, sug, 0)

	// la app ve projectId por session_upsert y por REST
	got := waitEnv(t, ch, func(e proto.Envelope) bool {
		var s proto.SessionInfo
		return e.Type == "session_upsert" && e.Session == "s1" && json.Unmarshal(e.Payload, &s) == nil && s.ProjectID == p.ID
	})
	require.NotNil(t, got.Payload)
	var list []proto.SessionInfo
	f.get(t, "/api/sessions", &list)
	n := 0
	for _, s := range list {
		if s.ProjectID == p.ID {
			n++
		}
	}
	require.Equal(t, 2, n)

	// una sesión nueva con el mismo remoto se asocia sola
	f.upsert(t, "s4", "/w/r2", "ssh://git@github.com/o/r.git", "x")
	eventually(t, func() bool { s, err := f.st.Session("s4"); return err == nil && s.ProjectID == p.ID })
}

func TestCreateProjectErrors(t *testing.T) {
	f := newAppFx(t)
	code, msg := f.postBody("/api/workspaces", `{}`)
	require.Equal(t, 400, code)
	require.NotEmpty(t, msg)
	code, _ = f.postBody("/api/projects", `{"name":"x"}`)
	require.Equal(t, 400, code)
	code, _ = f.postBody("/api/projects", `{"workspaceId":"w"}`)
	require.Equal(t, 400, code)
	code, msg = f.postBody("/api/projects", `{"workspaceId":"nope","name":"x"}`)
	require.Equal(t, 404, code)
	require.Equal(t, "trabajo no encontrado", msg)
}

func TestBranchUpdateKeepsRepoWhenModSendsEmpty(t *testing.T) {
	f := newAppFx(t)
	f.upsert(t, "s1", "/w/r", "git@github.com:o/r.git", "main")
	eventually(t, func() bool { s, err := f.st.Session("s1"); return err == nil && s.Branch == "main" })
	f.upsert(t, "s1", "/w/r", "git@github.com:o/r.git", "feat")
	eventually(t, func() bool { s, _ := f.st.Session("s1"); return s.Branch == "feat" })
	f.upsert(t, "s1", "/w/r", "", "")
	time.Sleep(200 * time.Millisecond)
	s, _ := f.st.Session("s1")
	require.Equal(t, "feat", s.Branch)
	require.Equal(t, "git@github.com:o/r.git", s.RepoURL)
}

func TestRepoCredentialsNeverStored(t *testing.T) {
	f := newAppFx(t)
	f.upsert(t, "s1", "/w/r", "https://TOKEN@github.com/o/r.git", "main")
	eventually(t, func() bool { s, err := f.st.Session("s1"); return err == nil && s.RepoURL != "" })
	s, _ := f.st.Session("s1")
	require.Equal(t, "https://github.com/o/r.git", s.RepoURL)
	var sug []struct {
		RepoURL string `json:"repoURL"`
	}
	f.get(t, "/api/projects/suggestions", &sug)
	require.Len(t, sug, 1)
	require.NotContains(t, sug[0].RepoURL, "TOKEN")

	var ws proto.Workspace
	f.postJSON(t, "/api/workspaces", `{"name":"T"}`, &ws)
	var p proto.Project
	f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"R","repoURL":"https://u:p@github.com/o/r"}`, &p)
	require.Equal(t, "https://github.com/o/r", p.RepoURL)
	eventually(t, func() bool { s, _ := f.st.Session("s1"); return s.ProjectID == p.ID })
}

func TestEmptyRepoURLNeverAdopts(t *testing.T) {
	f := newAppFx(t)
	// checkouts que normalizan a vacío (el store los guarda tal cual, sin proyecto)
	for i, u := range []string{"", "https://u:p@/", "https://@/"} {
		_, err := f.st.UpsertCheckout(proto.Checkout{Machine: "m1", Root: "/w/" + string(rune('a'+i)), RepoURL: u})
		require.NoError(t, err)
	}
	var ws proto.Workspace
	f.postJSON(t, "/api/workspaces", `{"name":"T"}`, &ws)
	for _, u := range []string{"", "https://u:p@/"} {
		var p proto.Project
		require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"R","repoURL":"`+u+`"}`, &p))
		cos, _ := f.st.ListCheckouts(p.ID)
		require.Len(t, cos, 0)
	}
	all, _ := f.st.AllCheckouts()
	for _, c := range all {
		require.Equal(t, "", c.ProjectID)
	}
}

func TestStripRepoUserinfoCases(t *testing.T) {
	for in, want := range map[string]string{
		"https://u:pa/ss@github.com/o/r.git":        "https://github.com/o/r.git",
		"https://github.com/o/r.git?access_token=x": "https://github.com/o/r.git",
		"https://TOKEN@github.com/o/r#frag":         "https://github.com/o/r",
		"git@github.com:o/r.git":                    "git@github.com:o/r.git",
	} {
		require.Equal(t, want, store.StripRepoUserinfo(in))
	}
}

func TestUpdateProjectStripsCredentials(t *testing.T) {
	f := newAppFx(t)
	w, _ := f.st.CreateWorkspace(proto.Workspace{Name: "T"})
	p, err := f.st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "R"})
	require.NoError(t, err)
	p.RepoURL = "https://u:p@github.com/o/r?access_token=z"
	require.NoError(t, f.st.UpdateProject(p))
	got, _ := f.st.GetProject(p.ID)
	require.Equal(t, "https://github.com/o/r", got.RepoURL)
}

func TestSyncEndpoint(t *testing.T) {
	f := newAppFx(t)
	var ws proto.Workspace
	require.Equal(t, 201, f.postJSON(t, "/api/workspaces", `{"name":"w"}`, &ws))
	var p proto.Project
	require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"p"}`, &p))
	require.Equal(t, 400, f.postJSON(t, "/api/projects/"+p.ID+"/sync", `{}`, nil))
	require.Equal(t, 404, f.postJSON(t, "/api/projects/nope/sync", `{}`, nil))
	p.Connector = proto.ConnectorConfig{Kind: "exec", Settings: map[string]string{"command": "true"}}
	require.NoError(t, f.st.UpdateProject(p))
	require.Equal(t, 202, f.postJSON(t, "/api/projects/"+p.ID+"/sync", `{}`, nil))
	// Espera a que termine la sincronización de fondo antes de cerrar el almacén.
	require.Eventually(t, func() bool { q, _ := f.st.GetProject(p.ID); return q.SyncedAt != 0 }, 5*time.Second, 20*time.Millisecond)
}
