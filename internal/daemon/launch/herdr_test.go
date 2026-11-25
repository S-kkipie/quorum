package launch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

type hws = map[string]any

// fakeHerdr builds a fake herdr with the given workspaces and panes.
func fakeHerdr(t *testing.T, workspaces, panes []hws) *herdrtest.Fake {
	t.Helper()
	t.Setenv("HOME", t.TempDir()) // TrustDir never touches the real ~/.claude.json
	f := herdrtest.New(t)
	f.Handle("workspace.list", func(json.RawMessage) (any, string) {
		return hws{"workspaces": workspaces}, ""
	})
	f.Handle("pane.list", func(json.RawMessage) (any, string) {
		return hws{"panes": panes}, ""
	})
	f.Handle("workspace.create", func(json.RawMessage) (any, string) {
		return hws{"workspace": hws{"workspace_id": "wNEW"}, "root_pane": hws{"pane_id": "wNEW:p1"}}, ""
	})
	f.Handle("tab.create", func(json.RawMessage) (any, string) {
		return hws{"root_pane": hws{"pane_id": "wT:p7"}}, ""
	})
	f.Handle("agent.start", func(json.RawMessage) (any, string) { return hws{}, "" })
	return f
}

func callsOf(f *herdrtest.Fake, method string) []map[string]any {
	var out []map[string]any
	for _, c := range f.Calls() {
		if c.Method == method {
			var m map[string]any
			_ = json.Unmarshal(c.Params, &m)
			out = append(out, m)
		}
	}
	return out
}

func noGeteuidRoot(t *testing.T) {
	old := geteuid
	geteuid = func() int { return 1000 }
	t.Cleanup(func() { geteuid = old })
}

func TestRunHerdrReusesRememberedWorkspace(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, []hws{{"workspace_id": "w1", "number": 1}, {"workspace_id": "w2", "number": 2, "focused": true}},
		[]hws{{"pane_id": "w2:p1", "workspace_id": "w2", "cwd": root}, {"pane_id": "w1:p1", "workspace_id": "w1", "cwd": root}})
	ws := &Workspaces{Path: filepath.Join(t.TempDir(), "herdr-workspaces.json")}
	require.NoError(t, ws.Set(root, "w1"))

	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, ws,
		proto.LaunchRequest{ReqID: "AbC-123x", Dir: root, PermissionMode: "bypass"})
	require.Equal(t, proto.LaunchResult{ReqID: "AbC-123x", OK: true, Pane: "wT:p7", Via: "herdr"}, res)

	tabs := callsOf(f, "tab.create")
	require.Len(t, tabs, 1)
	require.Equal(t, map[string]any{"workspace_id": "w1", "cwd": root, "label": "claude", "focus": false,
		"env": map[string]any{"QUORUM_LAUNCH_REQ": "AbC-123x"}}, tabs[0])
	require.Empty(t, callsOf(f, "workspace.create"))
	ag := callsOf(f, "agent.start")
	require.Len(t, ag, 1)
	require.Equal(t, map[string]any{"name": "qabc123", "kind": "claude", "pane_id": "wT:p7",
		"args": []any{"--dangerously-skip-permissions"}, "timeout_ms": float64(60000)}, ag[0])
	require.Equal(t, "w1", ws.Get(root))
}

func TestRunHerdrPicksWorkspaceByCwd(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	other := t.TempDir()
	panes := []hws{
		{"pane_id": "w9:p1", "workspace_id": "w9", "cwd": other},
		{"pane_id": "w3:p1", "workspace_id": "w3", "cwd": root},
		{"pane_id": "w2:p1", "workspace_id": "w2", "cwd": root},
	}
	wss := []hws{{"workspace_id": "w2", "number": 2}, {"workspace_id": "w3", "number": 3}, {"workspace_id": "w9", "number": 1, "focused": true}}

	// no focused one among the candidates: the lowest-numbered
	f := fakeHerdr(t, wss, panes)
	// the remembered one no longer exists in herdr: ignored
	ws := &Workspaces{Path: filepath.Join(t.TempDir(), "m.json")}
	require.NoError(t, ws.Set(root, "wGONE"))
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, ws, proto.LaunchRequest{ReqID: "r1", Dir: root})
	require.True(t, res.OK, res.Error)
	require.Equal(t, "w2", callsOf(f, "tab.create")[0]["workspace_id"])
	require.Equal(t, "w2", ws.Get(root))

	// with a focused one among the candidates: that one
	wss[1]["focused"] = true
	f = fakeHerdr(t, wss, panes)
	ws = &Workspaces{Path: filepath.Join(t.TempDir(), "m.json")}
	res = RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, ws, proto.LaunchRequest{ReqID: "r2", Dir: root})
	require.True(t, res.OK, res.Error)
	require.Equal(t, "w3", callsOf(f, "tab.create")[0]["workspace_id"])
	require.Equal(t, "w3", ws.Get(root))
}

func TestRunHerdrCreatesWorkspaceAndUsesItsRootPane(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, []hws{{"workspace_id": "w1", "number": 1}}, nil)
	ws := &Workspaces{Path: filepath.Join(t.TempDir(), "m.json")}
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, ws,
		proto.LaunchRequest{ReqID: "r1", Dir: root, Label: "My Project"})
	require.Equal(t, proto.LaunchResult{ReqID: "r1", OK: true, Pane: "wNEW:p1", Via: "herdr"}, res)
	require.Empty(t, callsOf(f, "tab.create"))
	cw := callsOf(f, "workspace.create")
	require.Len(t, cw, 1)
	require.Equal(t, map[string]any{"cwd": root, "label": "My Project", "focus": false,
		"env": map[string]any{"QUORUM_LAUNCH_REQ": "r1"}}, cw[0])
	require.Equal(t, "wNEW:p1", callsOf(f, "agent.start")[0]["pane_id"])
	require.Equal(t, "wNEW", ws.Get(root))

	// without Label: the basename
	f = fakeHerdr(t, nil, nil)
	RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r2", Dir: root})
	require.Equal(t, filepath.Base(root), callsOf(f, "workspace.create")[0]["label"])
}

func TestResolveWorkspaceFreshPaneOnlyWhenCreated(t *testing.T) {
	root := t.TempDir()
	f := fakeHerdr(t, []hws{{"workspace_id": "w1", "number": 1}}, []hws{{"pane_id": "w1:p1", "workspace_id": "w1", "cwd": root}})
	id, fresh, err := ResolveWorkspace(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, root, "x", nil)
	require.NoError(t, err)
	require.Equal(t, "w1", id)
	require.Empty(t, fresh)
}

func TestRunHerdrResumeArgs(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, nil, nil)
	id := "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{},
		proto.LaunchRequest{ReqID: "r1", Dir: root, PermissionMode: "default", Resume: id})
	require.True(t, res.OK, res.Error)
	require.Equal(t, []any{"--permission-mode", "default", "--resume", id}, callsOf(f, "agent.start")[0]["args"])

	res = RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{},
		proto.LaunchRequest{ReqID: "r2", Dir: root, Resume: "x; rm -rf /"})
	require.False(t, res.OK)
	require.Equal(t, "invalid conversation id", res.Error)
	require.Len(t, callsOf(f, "agent.start"), 1)
}

func TestRunHerdrAgentNotReadyIsOK(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, nil, nil)
	f.Handle("agent.start", func(json.RawMessage) (any, string) { return nil, "agent_not_ready" })
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r1", Dir: root})
	require.Equal(t, proto.LaunchResult{ReqID: "r1", OK: true, Pane: "wNEW:p1", Via: "herdr"}, res)

	f.Handle("agent.start", func(json.RawMessage) (any, string) { return nil, "pane_busy" })
	res = RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r2", Dir: root})
	require.False(t, res.OK)
	require.Contains(t, res.Error, "pane_busy")
	require.Equal(t, "herdr", res.Via)
}

func TestRunHerdrOddPath(t *testing.T) {
	noGeteuidRoot(t)
	root := filepath.Join(t.TempDir(), `x "y";z`)
	require.NoError(t, os.Mkdir(root, 0o755))
	f := fakeHerdr(t, nil, nil)
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r1", Dir: root})
	require.True(t, res.OK, res.Error)
	cw := callsOf(f, "workspace.create")[0]
	require.Equal(t, root, cw["cwd"])
	require.Equal(t, `x "y";z`, cw["label"])
}

func TestRunHerdrValidates(t *testing.T) {
	f := fakeHerdr(t, nil, nil)
	c := &herdr.Client{Socket: f.Socket}
	old := geteuid
	t.Cleanup(func() { geteuid = old })
	geteuid = func() int { return 0 }
	res := RunHerdr(context.Background(), c, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: t.TempDir(), PermissionMode: "bypass"})
	require.Equal(t, proto.LaunchResult{ReqID: "r", Error: "Skip permissions does not work as root"}, res)
	geteuid = func() int { return 1000 }
	res = RunHerdr(context.Background(), c, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: "rel"})
	require.Equal(t, "the folder must be an absolute path", res.Error)
	res = RunHerdr(context.Background(), c, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: "/no/existe/xyz"})
	require.Equal(t, "the folder does not exist: /no/existe/xyz", res.Error)
	require.Empty(t, f.Calls())
}

func TestRunHerdrTrusts(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, nil, nil) // temporary HOME
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: root, Trust: true})
	require.True(t, res.OK, res.Error)
	b, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".claude.json"))
	require.NoError(t, err)
	var m struct {
		Projects map[string]struct {
			HasTrustDialogAccepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	require.NoError(t, json.Unmarshal(b, &m))
	require.True(t, m.Projects[root].HasTrustDialogAccepted)
}

func TestWorkspacesPersist(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "herdr-workspaces.json")
	ws := &Workspaces{Path: p}
	require.Equal(t, "", ws.Get("/a"))
	require.NoError(t, ws.Set("/a", "w1"))
	require.NoError(t, ws.Set("/b c", "w2"))
	ws2 := &Workspaces{Path: p}
	require.Equal(t, "w1", ws2.Get("/a"))
	require.Equal(t, "w2", ws2.Get("/b c"))
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(p), "*.tmp*"))
	require.Empty(t, left)
}

func TestRunHerdrCauseUnavailableOnlyBeforeSideEffects(t *testing.T) {
	noGeteuidRoot(t)
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()

	// no socket: workspace.list fails, nothing was touched → can go to the fallback
	c := &herdr.Client{Socket: filepath.Join(t.TempDir(), "no.sock")}
	res, err := RunHerdrCause(context.Background(), c, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: root, Prompt: "hello"})
	require.False(t, res.OK)
	require.ErrorIs(t, err, ErrHerdrUnavailable)
	// did not leave the prompt file: the fallback can write it under the same name
	_, serr := os.Stat(filepath.Join(PromptDir(root), "ticket-r.md"))
	require.True(t, os.IsNotExist(serr))

	// pane.list fails: no effects either
	f := fakeHerdr(t, nil, nil)
	f.Handle("pane.list", func(json.RawMessage) (any, string) { return nil, "boom" })
	_, err = RunHerdrCause(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: root})
	require.ErrorIs(t, err, ErrHerdrUnavailable)

	// workspace.create fails: herdr may have created it → final
	f = fakeHerdr(t, nil, nil)
	f.Handle("workspace.create", func(json.RawMessage) (any, string) { return nil, "boom" })
	res, err = RunHerdrCause(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: root})
	require.False(t, res.OK)
	require.Error(t, err)
	require.False(t, errors.Is(err, ErrHerdrUnavailable))

	// agent.start hangs past the deadline: Claude may be starting → final, with pane
	f = fakeHerdr(t, nil, nil)
	f.Handle("agent.start", func(json.RawMessage) (any, string) { time.Sleep(time.Second); return hws{}, "" })
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	res, err = RunHerdrCause(ctx, &herdr.Client{Socket: f.Socket}, &Workspaces{}, proto.LaunchRequest{ReqID: "r", Dir: root})
	require.False(t, res.OK)
	require.Error(t, err)
	require.False(t, errors.Is(err, ErrHerdrUnavailable))
	require.Equal(t, "wNEW:p1", res.Pane)
	require.Equal(t, "herdr", res.Via)
}

func TestRunHerdrPromptAlwaysViaFile(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, nil, nil)
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{},
		proto.LaunchRequest{ReqID: "r1", Dir: root, Prompt: "hello $(id) 'x'", TicketID: "t1"})
	require.True(t, res.OK, res.Error)
	args := callsOf(f, "agent.start")[0]["args"].([]any)
	last := args[len(args)-1].(string)
	path := filepath.Join(PromptDir(root), "ticket-r1.md")
	require.Equal(t, "--", args[len(args)-2])
	require.Equal(t, "Read the file .claude/quorum/ticket-r1.md and work on that ticket.", last)
	for _, a := range args {
		require.False(t, strings.Contains(a.(string), "$(id)"))
	}
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, "hello $(id) 'x'", string(b))
}

func TestRunHerdrPromptNeverCarriesDir(t *testing.T) {
	noGeteuidRoot(t)
	root := filepath.Join(t.TempDir(), "a b'c;$(x)")
	require.NoError(t, os.MkdirAll(root, 0o700))
	f := fakeHerdr(t, nil, nil)
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, &Workspaces{},
		proto.LaunchRequest{ReqID: "r/2;x", Dir: root, Prompt: "hello"})
	require.True(t, res.OK, res.Error)
	args := callsOf(f, "agent.start")[0]["args"].([]any)
	for _, a := range args {
		require.NotContains(t, a.(string), root)
		require.NotContains(t, a.(string), "$(x)")
	}
	// no ticket: a neutral instruction (the app's "Continue where I left off" prompt)
	require.Equal(t, "Read the file .claude/quorum/ticket-r2x.md and follow it.", args[len(args)-1])
	b, err := os.ReadFile(filepath.Join(PromptDir(root), "ticket-r2x.md"))
	require.NoError(t, err)
	require.Equal(t, "hello", string(b))
}

func TestRunHerdrRememberedWithoutRootPaneFallsBack(t *testing.T) {
	noGeteuidRoot(t)
	root := t.TempDir()
	f := fakeHerdr(t, []hws{{"workspace_id": "w1", "number": 1}, {"workspace_id": "w2", "number": 2}},
		[]hws{{"pane_id": "w1:p1", "workspace_id": "w1", "cwd": t.TempDir()}, {"pane_id": "w2:p1", "workspace_id": "w2", "cwd": root}})
	ws := &Workspaces{Path: filepath.Join(t.TempDir(), "herdr-workspaces.json")}
	require.NoError(t, ws.Set(root, "w1"))
	res := RunHerdr(context.Background(), &herdr.Client{Socket: f.Socket}, ws, proto.LaunchRequest{ReqID: "r", Dir: root})
	require.True(t, res.OK, res.Error)
	require.Equal(t, "w2", callsOf(f, "tab.create")[0]["workspace_id"])
	require.Equal(t, "w2", ws.Get(root))
}
