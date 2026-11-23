package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// fastTerm shortens the watcher's intervals.
func fastTerm(t *testing.T, lease time.Duration) {
	oP, oS, oL := termPoll, termSize, termLease
	termPoll, termSize, termLease = 5*time.Millisecond, 20*time.Millisecond, lease
	t.Cleanup(func() { termPoll, termSize, termLease = oP, oS, oL })
}

// termFake is a fake herdr with a workspace w1 and a pane w1:p1 in /proj;
// tab.create adds new panes to pane.list.
type termFake struct {
	*herdrtest.Fake
	mu    sync.Mutex
	panes []map[string]any
	n     int
}

func newTermFake(t *testing.T) *termFake {
	f := &termFake{Fake: herdrtest.New(t)}
	f.panes = []map[string]any{{"pane_id": "w1:p1", "workspace_id": "w1", "terminal_id": "term_p1", "cwd": "/proj"}}
	f.Handle("workspace.list", func(json.RawMessage) (any, string) {
		return map[string]any{"workspaces": []any{map[string]any{"workspace_id": "w1", "number": 1}}}, ""
	})
	f.Handle("pane.list", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return map[string]any{"panes": append([]map[string]any(nil), f.panes...)}, ""
	})
	f.Handle("tab.create", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.n++
		id := "w1:t" + string(rune('0'+f.n))
		f.panes = append(f.panes, map[string]any{"pane_id": id, "workspace_id": "w1", "terminal_id": "term_" + id, "cwd": "/proj"})
		return map[string]any{"root_pane": map[string]any{"pane_id": id}}, ""
	})
	f.Handle("pane.layout", func(p json.RawMessage) (any, string) {
		var in struct {
			Pane string `json:"pane_id"`
		}
		json.Unmarshal(p, &in)
		return map[string]any{"layout": map[string]any{"panes": []any{
			map[string]any{"pane_id": in.Pane, "rect": map[string]any{"width": 80, "height": 24}},
		}}}, ""
	})
	ok := func(json.RawMessage) (any, string) { return map[string]any{}, "" }
	f.Handle("pane.send_text", ok)
	f.Handle("pane.send_keys", ok)
	f.Handle("pane.close", ok)
	return f
}

func (f *termFake) removePane(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, p := range f.panes {
		if p["pane_id"] == id {
			f.panes = append(f.panes[:i], f.panes[i+1:]...)
			return
		}
	}
}

// recycle simulates herdr restarting and reusing the pane's id for another terminal.
func (f *termFake) recycle(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.panes {
		if p["pane_id"] == id {
			p["terminal_id"] = "term_otra"
		}
	}
}

func (f *termFake) count(method string) int {
	n := 0
	for _, c := range f.Calls() {
		if c.Method == method {
			n++
		}
	}
	return n
}

func termHost(t *testing.T, sock string) *Host {
	dir := t.TempDir()
	return &Host{
		Herdr:      &herdr.Client{Socket: sock},
		WS:         &launch.Workspaces{Path: filepath.Join(dir, "ws.json")},
		Terms:      &Terminals{Path: filepath.Join(dir, "herdr-terminals.json")},
		TerminalOn: true,
	}
}

func linkCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

func call(t *testing.T, ctx context.Context, h *Host, reg *Registry, method string, params any) (json.RawMessage, error) {
	t.Helper()
	p, _ := json.Marshal(params)
	res, err := invokeRPC(ctx, h, reg, proto.RPC{Method: method, Params: p})
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(res)
	return b, nil
}

type openRes struct {
	Pane string `json:"pane"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func termOpen(t *testing.T, h *Host, root string, isNew bool) openRes {
	t.Helper()
	b, err := call(t, context.Background(), h, NewRegistry("m1"), "term_open", map[string]any{"root": root, "label": "proj", "new": isNew})
	require.NoError(t, err)
	var r openRes
	require.NoError(t, json.Unmarshal(b, &r))
	return r
}

// frames takes from the queue the term_frame events there are right now.
func frames(reg *Registry) []proto.TermFrame {
	var out []proto.TermFrame
	for {
		select {
		case e := <-reg.Out():
			if e.Type == "term_frame" {
				var f proto.TermFrame
				json.Unmarshal(e.Payload, &f)
				out = append(out, f)
			}
		default:
			return out
		}
	}
}

func TestTermOpenReuses(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	a := termOpen(t, h, "/proj", false)
	require.Equal(t, openRes{Pane: "w1:t1", Cols: 80, Rows: 24}, a)
	b := termOpen(t, h, "/proj", false)
	require.Equal(t, a, b)
	require.Equal(t, 1, f.count("tab.create"))

	// it stays remembered on disk: another Host with the same file reuses it
	h2 := termHost(t, f.Socket)
	h2.Terms.Path = h.Terms.Path
	require.Equal(t, "w1:t1", termOpen(t, h2, "/proj", false).Pane)
	require.Equal(t, 1, f.count("tab.create"))

	// the tab.create goes without stealing focus, in /proj and with label "terminal"
	for _, c := range f.Calls() {
		if c.Method == "tab.create" {
			require.JSONEq(t, `{"workspace_id":"w1","cwd":"/proj","label":"terminal","focus":false}`, string(c.Params))
		}
	}

	// if the remembered pane no longer exists, it opens another
	f.removePane("w1:t1")
	require.Equal(t, "w1:t2", termOpen(t, h, "/proj", false).Pane)
}

func TestTermOpenNewCreatesTab(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	a := termOpen(t, h, "/proj", false)
	b := termOpen(t, h, "/proj", true)
	require.NotEqual(t, a.Pane, b.Pane)
	require.Equal(t, 2, f.count("tab.create"))
	// the next one without new reuses the last
	require.Equal(t, b.Pane, termOpen(t, h, "/proj", false).Pane)
	// both are Quorum's: they can be closed
	ctx := context.Background()
	_, err := call(t, ctx, h, NewRegistry("m1"), "term_close", map[string]any{"pane": a.Pane})
	require.NoError(t, err)
	_, err = call(t, ctx, h, NewRegistry("m1"), "term_close", map[string]any{"pane": b.Pane})
	require.NoError(t, err)
}

func TestTermOpenFreshWorkspace(t *testing.T) {
	f := newTermFake(t)
	f.Handle("workspace.list", func(json.RawMessage) (any, string) { return map[string]any{"workspaces": []any{}}, "" })
	f.Handle("workspace.create", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		f.panes = append(f.panes, map[string]any{"pane_id": "w9:p1", "workspace_id": "w9", "terminal_id": "term_w9", "cwd": "/other"})
		f.mu.Unlock()
		return map[string]any{"workspace": map[string]any{"workspace_id": "w9"}, "root_pane": map[string]any{"pane_id": "w9:p1"}}, ""
	})
	h := termHost(t, f.Socket)
	require.Equal(t, "w9:p1", termOpen(t, h, "/other", false).Pane)
	require.Equal(t, 0, f.count("tab.create"))
	_, err := call(t, context.Background(), h, NewRegistry("m1"), "term_close", map[string]any{"pane": "w9:p1"})
	require.NoError(t, err)
}

// readSeq makes pane.read return the texts in order and then repeat the last one.
func readSeq(f *termFake, texts ...string) *atomic.Int32 {
	var n atomic.Int32
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		i := int(n.Add(1)) - 1
		if i >= len(texts) {
			i = len(texts) - 1
		}
		return map[string]any{"read": map[string]any{"text": texts[i]}}, ""
	})
	return &n
}

func watch(t *testing.T, ctx context.Context, h *Host, reg *Registry, pane string) {
	t.Helper()
	_, err := call(t, ctx, h, reg, "term_watch", map[string]any{"pane": pane})
	require.NoError(t, err)
}

func TestTermWatchEmitsOnlyOnChange(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	reads := readSeq(f, "uno", "uno", "uno", "dos")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx := linkCtx(t)
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool { return reads.Load() >= 10 }, 3*time.Second, 5*time.Millisecond)
	got := frames(reg)
	require.Len(t, got, 2)
	require.Equal(t, proto.TermFrame{Pane: "w1:p1", Cols: 80, Rows: 24, ANSI: "uno"}, got[0])
	require.Equal(t, "dos", got[1].ANSI)

	// renewing the lease does not start a second watcher; it resends the current frame
	// only once (see TestTermWatchResendsOnRenew)
	watch(t, ctx, h, reg, "w1:p1")
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	got = frames(reg)
	require.Len(t, got, 1)
	require.Equal(t, "dos", got[0].ANSI)
	require.Less(t, reads.Load()-n, int32(20)) // ~10 reads in 50 ms with a single watcher
}

func TestTermWatchEnvelope(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	readSeq(f, "x")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	watch(t, linkCtx(t), h, reg, "w1:p1")
	select {
	case e := <-reg.Out():
		require.Equal(t, "term_frame", e.Type)
		require.Equal(t, "m1", e.Machine)
	case <-time.After(2 * time.Second):
		t.Fatal("no frame")
	}
}

func TestTermWatchClosed(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	var reads atomic.Int32
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		if reads.Add(1) > 2 {
			return nil, "pane_not_found" // herdr 0.9.5's real code
		}
		return map[string]any{"read": map[string]any{"text": "hello"}}, ""
	})
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	watch(t, linkCtx(t), h, reg, "w1:p1")
	var got []proto.TermFrame
	require.Eventually(t, func() bool {
		got = append(got, frames(reg)...)
		return len(got) == 2
	}, 3*time.Second, 5*time.Millisecond)
	require.Equal(t, proto.TermFrame{Pane: "w1:p1", Closed: true}, got[1])
	// the watcher ended: it reads no more
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, n, reads.Load())
	require.Equal(t, 0, h.watching())
}

// When the view is reopened, the app discards old frames: each term_watch makes
// the watcher send the current frame again even if it has not changed.
func TestTermWatchResendsOnRenew(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	reads := readSeq(f, "igual")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx := linkCtx(t)
	watch(t, ctx, h, reg, "w1:p1")
	var got []proto.TermFrame
	require.Eventually(t, func() bool {
		got = append(got, frames(reg)...)
		return len(got) == 1
	}, 3*time.Second, 5*time.Millisecond)
	n := reads.Load()
	require.Eventually(t, func() bool { return reads.Load() >= n+5 }, 3*time.Second, 5*time.Millisecond)
	require.Empty(t, frames(reg)) // no changes, no frames
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool {
		got = append(got, frames(reg)...)
		return len(got) == 2
	}, 3*time.Second, 5*time.Millisecond)
	require.Equal(t, got[0], got[1])
	require.Equal(t, 1, h.watching())
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, frames(reg)) // y vuelve a callar
}

func TestTermWatchLeaseExpires(t *testing.T) {
	fastTerm(t, 80*time.Millisecond)
	f := newTermFake(t)
	reads := readSeq(f, "x")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx := linkCtx(t)
	watch(t, ctx, h, reg, "w1:p1")
	// renewing before it expires extends it
	time.Sleep(50 * time.Millisecond)
	watch(t, ctx, h, reg, "w1:p1")
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, 1, h.watching())
	require.Eventually(t, func() bool { return h.watching() == 0 }, 2*time.Second, 5*time.Millisecond)
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, n, reads.Load())

	// after expiring, another term_watch starts a new watcher and sends the screen again
	frames(reg)
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool { return len(frames(reg)) == 1 }, 2*time.Second, 5*time.Millisecond)
}

func TestTermWatchStopsWithLink(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	reads := readSeq(f, "x")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx, cancel := context.WithCancel(context.Background())
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool { return reads.Load() > 2 }, 2*time.Second, 5*time.Millisecond)
	cancel()
	require.Eventually(t, func() bool { return h.watching() == 0 }, 2*time.Second, 5*time.Millisecond)
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, n, reads.Load())

	// a new link watches the same pane again
	frames(reg)
	watch(t, linkCtx(t), h, reg, "w1:p1")
	require.Eventually(t, func() bool { return len(frames(reg)) == 1 }, 2*time.Second, 5*time.Millisecond)
}

func TestTermFrameTruncated(t *testing.T) {
	var sb strings.Builder
	for i := 0; sb.Len() < 300<<10; i++ {
		sb.WriteString(strings.Repeat("a", 99) + "\n")
	}
	sb.WriteString("FINAL")
	s := sb.String()
	got := trimFront(s, termFrameMax)
	require.LessOrEqual(t, len(got), termFrameMax)
	require.True(t, strings.HasSuffix(got, "FINAL"))
	require.True(t, strings.HasSuffix(s, got))
	require.Equal(t, byte('\n'), s[len(s)-len(got)-1]) // cut at a line boundary
	require.Equal(t, "corto", trimFront("corto", termFrameMax))

	// also in the watcher
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	readSeq(f, s)
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	watch(t, linkCtx(t), h, reg, "w1:p1")
	var fr []proto.TermFrame
	require.Eventually(t, func() bool { fr = append(fr, frames(reg)...); return len(fr) > 0 }, 2*time.Second, 5*time.Millisecond)
	require.Equal(t, got, fr[0].ANSI)
}

func TestTermInputRejectsUnknownKey(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	ctx, reg := context.Background(), NewRegistry("m1")
	_, err := call(t, ctx, h, reg, "term_input", map[string]any{"pane": "w1:p1", "text": "ls", "keys": []string{"enter", "f1"}})
	require.EqualError(t, err, `tecla no permitida: "f1"`)
	require.Equal(t, 0, f.count("pane.send_text"))
	require.Equal(t, 0, f.count("pane.send_keys"))

	_, err = call(t, ctx, h, reg, "term_input", map[string]any{"pane": "w1:p1", "text": "ls", "keys": []string{"enter", "ctrl+c"}})
	require.NoError(t, err)
	var order []string
	for _, c := range f.Calls() {
		switch c.Method {
		case "pane.send_text":
			order = append(order, c.Method)
			require.JSONEq(t, `{"pane_id":"w1:p1","text":"ls"}`, string(c.Params))
		case "pane.send_keys":
			order = append(order, c.Method)
			require.JSONEq(t, `{"pane_id":"w1:p1","keys":["enter","ctrl+c"]}`, string(c.Params))
		}
	}
	require.Equal(t, []string{"pane.send_text", "pane.send_keys"}, order)
}

func TestTermRead(t *testing.T) {
	f := newTermFake(t)
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		return map[string]any{"read": map[string]any{"text": "historial"}}, ""
	})
	h := termHost(t, f.Socket)
	b, err := call(t, context.Background(), h, NewRegistry("m1"), "term_read", map[string]any{"pane": "w1:p1", "lines": 99999})
	require.NoError(t, err)
	require.JSONEq(t, `{"ansi":"historial"}`, string(b))
	var p struct {
		Source string `json:"source"`
		Lines  int    `json:"lines"`
	}
	for _, c := range f.Calls() {
		if c.Method == "pane.read" {
			json.Unmarshal(c.Params, &p)
		}
	}
	require.Equal(t, "recent", p.Source)
	require.Equal(t, 2000, p.Lines)
}

func TestTermCloseOnlyOwn(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	ctx, reg := context.Background(), NewRegistry("m1")
	_, err := call(t, ctx, h, reg, "term_close", map[string]any{"pane": "w1:p1"})
	require.EqualError(t, err, "Quorum only closes terminals it opened")
	require.Equal(t, 0, f.count("pane.close"))

	own := termOpen(t, h, "/proj", false).Pane
	_, err = call(t, ctx, h, reg, "term_close", map[string]any{"pane": own})
	require.NoError(t, err)
	require.Equal(t, 1, f.count("pane.close"))
	// already closed: it is no longer its own
	_, err = call(t, ctx, h, reg, "term_close", map[string]any{"pane": own})
	require.EqualError(t, err, "Quorum only closes terminals it opened")
	require.Equal(t, 1, f.count("pane.close"))
}

func TestTermDisabled(t *testing.T) {
	f := newTermFake(t)
	off := termHost(t, f.Socket)
	off.TerminalOn = false
	none := termHost(t, filepath.Join(t.TempDir(), "none.sock"))
	for h, want := range map[*Host]string{off: "terminal is disabled on this machine", none: "herdr is not responding on this machine"} {
		for _, m := range []string{"term_open", "term_watch", "term_input", "term_read", "term_close"} {
			_, err := call(t, context.Background(), h, NewRegistry("m1"), m, map[string]any{"pane": "w1:p1", "root": "/proj"})
			require.EqualError(t, err, want, m)
		}
	}
	for _, c := range f.Calls() {
		require.Equal(t, "workspace.list", c.Method) // only checked whether herdr answers
	}
}

func TestConversationsRPC(t *testing.T) {
	home := t.TempDir()
	old := userHome
	userHome = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHome = old })
	dir := filepath.Join(home, ".claude", "projects", "-proj-x")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	line := `{"type":"user","message":{"role":"user","content":"hello"}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(line), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "s2.jsonl"), []byte(line), 0o600))

	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s2"})
	b, err := call(t, context.Background(), noHerdrHost(t), reg, "conversations", map[string]any{"root": "/proj/x"})
	require.NoError(t, err)
	var got []proto.Conversation
	require.NoError(t, json.Unmarshal(b, &got))
	require.Len(t, got, 2)
	open := map[string]bool{}
	for _, c := range got {
		open[c.ID] = c.Open
	}
	require.Equal(t, map[string]bool{"s1": false, "s2": true}, open)

	_, err = call(t, context.Background(), noHerdrHost(t), reg, "conversations", map[string]any{"root": "relativa"})
	require.Error(t, err)
}

func TestRPCPerCallTimeout(t *testing.T) {
	old := rpcTimeout
	rpcTimeout = 30 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = old })
	rpcHandlers["lento"] = func(ctx context.Context, _ *Host, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	t.Cleanup(func() { delete(rpcHandlers, "lento") })
	done := make(chan error, 1)
	go func() {
		_, err := invokeRPC(context.Background(), noHerdrHost(t), NewRegistry("m1"), proto.RPC{Method: "lento"})
		done <- err
	}()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.DeadlineExceeded)
	case <-time.After(2 * time.Second):
		t.Fatal("the handler was not cut off")
	}
}

func TestTermCloseRefusesReusedPaneID(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	ctx, reg := context.Background(), NewRegistry("m1")
	own := termOpen(t, h, "/proj", false).Pane
	f.recycle(own) // same id, another terminal (e.g. herdr restarted)
	_, err := call(t, ctx, h, reg, "term_close", map[string]any{"pane": own})
	require.EqualError(t, err, "Quorum only closes terminals it opened")
	require.Equal(t, 0, f.count("pane.close"))
	// and it was forgotten: it is not reused on open either
	require.NotEqual(t, own, termOpen(t, h, "/proj", false).Pane)
}

func TestTermOpenDoesNotReuseRecycledID(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	own := termOpen(t, h, "/proj", false).Pane
	f.recycle(own)
	require.NotEqual(t, own, termOpen(t, h, "/proj", false).Pane)
	require.Equal(t, 2, f.count("tab.create"))
}

func TestTermCloseIgnoresLegacyEntries(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	// old format: ids without terminal_id → not closable
	require.NoError(t, os.WriteFile(h.Terms.Path, []byte(`{"byRoot":{"/proj":"w1:p1"},"owned":["w1:p1"]}`), 0o600))
	_, err := call(t, context.Background(), h, NewRegistry("m1"), "term_close", map[string]any{"pane": "w1:p1"})
	require.EqualError(t, err, "Quorum only closes terminals it opened")
	require.Equal(t, 0, f.count("pane.close"))
	require.NotEqual(t, "w1:p1", termOpen(t, h, "/proj", false).Pane)
}

func TestRPCTimeoutMessage(t *testing.T) {
	old := rpcTimeout
	rpcTimeout = 30 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = old })
	rpcHandlers["lento"] = func(ctx context.Context, _ *Host, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	t.Cleanup(func() { delete(rpcHandlers, "lento") })
	reg := NewRegistry("m1")
	handleRPC(context.Background(), noHerdrHost(t), reg, proto.RPC{ReqID: "q9", Method: "lento"})
	e := <-reg.Out()
	var res proto.RPCResult
	require.NoError(t, json.Unmarshal(e.Payload, &res))
	require.Equal(t, "q9", res.ReqID)
	require.Equal(t, "the operation took too long on the machine", res.Error)
	require.Equal(t, 9*time.Second, old)
}

// Final review: the close frame is not droppable; with a full queue it waits
// for room instead of getting lost.
func TestTermWatchClosedNotDroppable(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	f.Handle("pane.read", func(json.RawMessage) (any, string) { return nil, "pane_not_found" })
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	for len(reg.out) < cap(reg.out) {
		reg.out <- proto.Envelope{Type: "x"}
	}
	watch(t, linkCtx(t), h, reg, "w1:p1")
	time.Sleep(100 * time.Millisecond) // the watcher is already waiting for room
	var got []proto.TermFrame
	require.Eventually(t, func() bool {
		got = append(got, frames(reg)...)
		return len(got) == 1
	}, 3*time.Second, 5*time.Millisecond)
	require.Equal(t, proto.TermFrame{Pane: "w1:p1", Closed: true}, got[0])
}
