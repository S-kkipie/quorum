package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
	"github.com/stretchr/testify/require"
)

type focusFx struct {
	w     *focusWatcher
	mu    sync.Mutex
	panes []map[string]any
	seen  []string
	now   time.Time
}

func pane(id string, focused bool, status, session string) map[string]any {
	p := map[string]any{"pane_id": id, "focused": focused, "agent_status": status}
	if session != "" {
		p["agent_session"] = map[string]any{"agent": "claude", "kind": "id", "value": session}
	}
	return p
}

func newFocusFx(t *testing.T) *focusFx {
	t.Helper()
	fk := herdrtest.New(t)
	f := &focusFx{now: time.Unix(1000, 0)}
	fk.Handle("pane.list", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return map[string]any{"panes": f.panes}, ""
	})
	f.w = newFocusWatcher(&herdr.Client{Socket: fk.Socket}, func(s string) { f.seen = append(f.seen, s) })
	f.w.now = func() time.Time { return f.now }
	return f
}

func (f *focusFx) set(p ...map[string]any) { f.mu.Lock(); f.panes = p; f.mu.Unlock() }
func (f *focusFx) tick()                   { f.w.tick(context.Background()) }

func TestFocusReportsOnlyOnTheFalseToTrueEdge(t *testing.T) {
	f := newFocusFx(t)
	f.set(pane("w1:p1", false, "idle", "s1"), pane("w2:p1", false, "idle", "s2"))
	f.tick()
	require.Empty(t, f.seen)
	f.set(pane("w1:p1", true, "idle", "s1"), pane("w2:p1", false, "idle", "s2"))
	f.tick()
	require.Equal(t, []string{"s1"}, f.seen)
	f.tick() // still focused: no new edge
	require.Equal(t, []string{"s1"}, f.seen)
}

func TestFocusIgnoresPanesWithoutAClaudeSession(t *testing.T) {
	f := newFocusFx(t)
	f.set(pane("w1:p1", false, "unknown", ""))
	f.tick()
	f.set(pane("w1:p1", true, "unknown", ""))
	f.tick()
	require.Empty(t, f.seen)
}

func TestFocusFirstPollOnlyRecordsState(t *testing.T) {
	f := newFocusFx(t)
	f.set(pane("w1:p1", true, "idle", "s1"))
	f.tick() // daemon restart / config reload: the pane was already focused, nobody looked at it now
	require.Empty(t, f.seen)
	f.tick()
	require.Empty(t, f.seen, "still focused: no edge")
	f.set(pane("w1:p1", false, "idle", "s1"))
	f.tick()
	f.set(pane("w1:p1", true, "idle", "s1"))
	f.tick()
	require.Equal(t, []string{"s1"}, f.seen)
}

func TestFocusDebouncedEdgeFiresAfterTheWindow(t *testing.T) {
	f := newFocusFx(t)
	on, off := pane("w1:p1", true, "idle", "s1"), pane("w1:p1", false, "idle", "s1")
	f.set(off)
	f.tick()
	f.set(on)
	f.tick() // reported
	f.now = f.now.Add(time.Second)
	f.set(off)
	f.tick()
	f.now = f.now.Add(time.Second)
	f.set(on)
	f.tick() // debounced
	require.Equal(t, []string{"s1"}, f.seen)
	f.now = f.now.Add(9 * time.Second) // still focused past the window
	f.tick()
	require.Equal(t, []string{"s1", "s1"}, f.seen)
	f.now = f.now.Add(20 * time.Second)
	f.tick() // no new edge
	require.Equal(t, []string{"s1", "s1"}, f.seen)
}

func TestFocusDebouncesPerSession(t *testing.T) {
	f := newFocusFx(t)
	a, b := pane("w1:p1", true, "idle", "s1"), pane("w2:p1", false, "idle", "s2")
	a2, b2 := pane("w1:p1", false, "idle", "s1"), pane("w2:p1", true, "idle", "s2")
	f.set(a2, b)
	f.tick() // start: records only
	f.set(a, b)
	f.tick() // s1
	f.now = f.now.Add(2 * time.Second)
	f.set(a2, b2)
	f.tick() // s2
	f.now = f.now.Add(2 * time.Second)
	f.set(a, b)
	f.tick() // s1 again within 10 s: debounced
	require.Equal(t, []string{"s1", "s2"}, f.seen)
	f.now = f.now.Add(10 * time.Second)
	f.set(a2, b2)
	f.tick()
	f.now = f.now.Add(time.Second)
	f.set(a, b)
	f.tick() // s1 again, 13 s after its last report
	require.Equal(t, []string{"s1", "s2", "s2", "s1"}, f.seen)
}

func TestFocusKeepsStateWhenHerdrFails(t *testing.T) {
	f := newFocusFx(t)
	f.set(pane("w1:p1", false, "idle", "s1"))
	f.tick()
	f.set(pane("w1:p1", true, "idle", "s1"))
	f.tick()
	f.w.client = &herdr.Client{Socket: "/nonexistent/h.sock"}
	f.tick() // error: nothing changes, no panic
	require.Equal(t, []string{"s1"}, f.seen)
}

func TestFocusWatcherStopsWithTheContext(t *testing.T) {
	f := newFocusFx(t)
	f.w.every = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.w.run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run did not stop")
	}
}
