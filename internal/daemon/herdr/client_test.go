package herdr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
)

func TestCallDecodesResult(t *testing.T) {
	f := herdrtest.New(t)
	f.Handle("workspace.list", func(json.RawMessage) (any, string) {
		return map[string]any{"type": "workspace_list", "workspaces": []map[string]any{
			{"workspace_id": "w1", "label": "x", "focused": true, "number": 1},
		}}, ""
	})
	c := &Client{Socket: f.Socket}
	ws, err := c.ListWorkspaces(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []Workspace{{ID: "w1", Label: "x", Focused: true, Number: 1}}
	if !reflect.DeepEqual(ws, want) {
		t.Fatalf("got %+v", ws)
	}
}

func TestCallServerError(t *testing.T) {
	f := herdrtest.New(t)
	f.Handle("pane.read", func(json.RawMessage) (any, string) { return nil, "not_found" })
	c := &Client{Socket: f.Socket}
	_, err := c.ReadPane(context.Background(), "w1:p9", "visible", 10)
	var he *Error
	if !errors.As(err, &he) || he.Code != "not_found" {
		t.Fatalf("err = %v", err)
	}
}

// herdr 0.9.5 responde pane_not_found (y workspace_not_found, tab_not_found...);
// versiones viejas, not_found.
func TestIsNotFound(t *testing.T) {
	for code, want := range map[string]bool{
		"not_found": true, "pane_not_found": true, "workspace_not_found": true, "tab_not_found": true,
		"agent_not_ready": false, "unknown_method": false, "found": false, "": false,
	} {
		if got := IsNotFound(&Error{Code: code}); got != want {
			t.Errorf("IsNotFound(%q) = %v", code, got)
		}
	}
	if IsNotFound(errors.New("not_found")) || IsNotFound(nil) {
		t.Error("solo errores de herdr")
	}
	if !IsNotFound(fmt.Errorf("envuelto: %w", &Error{Code: "pane_not_found"})) {
		t.Error("debe ver errores envueltos")
	}
}

func TestCreateTabSendsEnvAndCwd(t *testing.T) {
	f := herdrtest.New(t)
	f.Handle("tab.create", func(json.RawMessage) (any, string) {
		return map[string]any{"root_pane": map[string]any{"pane_id": "w1:p2"}}, ""
	})
	c := &Client{Socket: f.Socket}
	pane, err := c.CreateTab(context.Background(), "w1", "/tmp/a b;c", "lbl", map[string]string{"QUORUM_LAUNCH_REQ": "r1"})
	if err != nil || pane != "w1:p2" {
		t.Fatalf("pane=%q err=%v", pane, err)
	}
	calls := f.Calls()
	if len(calls) != 1 || calls[0].Method != "tab.create" {
		t.Fatalf("calls = %+v", calls)
	}
	var got map[string]any
	json.Unmarshal(calls[0].Params, &got)
	want := map[string]any{
		"workspace_id": "w1", "cwd": "/tmp/a b;c", "label": "lbl", "focus": false,
		"env": map[string]any{"QUORUM_LAUNCH_REQ": "r1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("params = %v", got)
	}
}

func TestAvailableFalseWithoutSocket(t *testing.T) {
	c := &Client{Socket: t.TempDir() + "/no.sock"}
	if c.Available(context.Background()) {
		t.Fatal("no debería estar disponible")
	}
}

func TestWorkspaceAndPaneHelpers(t *testing.T) {
	f := herdrtest.New(t)
	f.Handle("workspace.create", func(json.RawMessage) (any, string) {
		return map[string]any{"workspace": map[string]any{"workspace_id": "w2"}, "root_pane": map[string]any{"pane_id": "w2:p1"}}, ""
	})
	f.Handle("pane.layout", func(json.RawMessage) (any, string) {
		return map[string]any{"layout": map[string]any{"panes": []map[string]any{
			{"pane_id": "w2:p1", "rect": map[string]int{"x": 0, "y": 0, "width": 183, "height": 50}},
		}}}, ""
	})
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		return map[string]any{"read": map[string]any{"pane_id": "w2:p1", "text": "hola"}}, ""
	})
	f.Handle("pane.list", func(json.RawMessage) (any, string) {
		return map[string]any{"panes": []map[string]any{
			{"pane_id": "w2:p1", "workspace_id": "w2", "tab_id": "w2:t1", "terminal_id": "term_abc", "cwd": "/x", "agent": "claude", "agent_session": map[string]any{"value": "u1"}},
		}}, ""
	})
	f.Handle("agent.start", func(json.RawMessage) (any, string) { return map[string]any{}, "" })
	f.Handle("pane.send_text", func(json.RawMessage) (any, string) { return map[string]any{}, "" })
	f.Handle("pane.send_keys", func(json.RawMessage) (any, string) { return map[string]any{}, "" })
	f.Handle("pane.close", func(json.RawMessage) (any, string) { return map[string]any{}, "" })
	c := &Client{Socket: f.Socket}
	ctx := context.Background()

	ws, root, err := c.CreateWorkspace(ctx, "/x", "l", nil)
	if err != nil || ws != "w2" || root != "w2:p1" {
		t.Fatalf("%q %q %v", ws, root, err)
	}
	cols, rows, err := c.PaneSize(ctx, "w2:p1")
	if err != nil || cols != 183 || rows != 50 {
		t.Fatalf("%d %d %v", cols, rows, err)
	}
	if _, _, err := c.PaneSize(ctx, "w2:p9"); err == nil {
		t.Fatal("panel ausente debería fallar")
	}
	txt, err := c.ReadPane(ctx, "w2:p1", "visible", 40)
	if err != nil || txt != "hola" {
		t.Fatalf("%q %v", txt, err)
	}
	ps, err := c.ListPanes(ctx, "w2")
	if err != nil || len(ps) != 1 || ps[0].AgentSession == nil || ps[0].AgentSession.Value != "u1" || ps[0].TabID != "w2:t1" || ps[0].TerminalID != "term_abc" {
		t.Fatalf("%+v %v", ps, err)
	}
	if err := c.StartAgent(ctx, "n", "claude", "w2:p1", []string{"--resume", "a"}, 1000); err != nil {
		t.Fatal(err)
	}
	if err := c.SendText(ctx, "w2:p1", "hi"); err != nil {
		t.Fatal(err)
	}
	if err := c.SendKeys(ctx, "w2:p1", []string{"esc"}); err != nil {
		t.Fatal(err)
	}
	if err := c.ClosePane(ctx, "w2:p1"); err != nil {
		t.Fatal(err)
	}

	for _, call := range f.Calls() {
		var p map[string]any
		json.Unmarshal(call.Params, &p)
		switch call.Method {
		case "workspace.create":
			if p["focus"] != false {
				t.Fatalf("workspace.create sin focus:false: %v", p)
			}
		case "pane.read":
			if p["format"] != "ansi" || p["strip_ansi"] != false || p["source"] != "visible" || p["lines"] != float64(40) {
				t.Fatalf("pane.read params: %v", p)
			}
		case "agent.start":
			if p["timeout_ms"] != float64(1000) || p["pane_id"] != "w2:p1" {
				t.Fatalf("agent.start params: %v", p)
			}
		}
	}
}
