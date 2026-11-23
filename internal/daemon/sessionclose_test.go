package daemon

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// closeFake is a fake herdr with pane w1:p1 (terminal term_1, Claude already
// finished) that records the pane.close calls.
type closeFake struct {
	*herdrtest.Fake
	mu    sync.Mutex
	pane  map[string]any
	fails int // the next fails pane.list calls answer an error
}

func newCloseFake(t *testing.T) *closeFake {
	f := &closeFake{Fake: herdrtest.New(t)}
	f.pane = map[string]any{"pane_id": "w1:p1", "workspace_id": "w1", "terminal_id": "term_1",
		"agent": "claude", "agent_status": "idle"}
	f.Handle("pane.list", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.fails > 0 {
			f.fails--
			return nil, "internal_error"
		}
		p := map[string]any{}
		for k, v := range f.pane {
			p[k] = v
		}
		return map[string]any{"panes": []any{p}}, ""
	})
	f.Handle("pane.close", func(json.RawMessage) (any, string) { return map[string]any{}, "" })
	return f
}

func (f *closeFake) set(k string, v any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pane[k] = v
}

func (f *closeFake) closes() []string {
	var out []string
	for _, c := range f.Calls() {
		if c.Method == "pane.close" {
			var p struct {
				Pane string `json:"pane_id"`
			}
			json.Unmarshal(c.Params, &p)
			out = append(out, p.Pane)
		}
	}
	return out
}

func (f *closeFake) lists() int {
	n := 0
	for _, c := range f.Calls() {
		if c.Method == "pane.list" {
			n++
		}
	}
	return n
}

// closeTimes shortens the deadlines; set before starting any goroutine.
func closeTimes(t *testing.T, wait, poll, window time.Duration) {
	oW, oP, oX := sessionCloseWait, sessionClosePoll, sessionCloseWindow
	sessionCloseWait, sessionClosePoll, sessionCloseWindow = wait, poll, window
	t.Cleanup(func() { sessionCloseWait, sessionClosePoll, sessionCloseWindow = oW, oP, oX })
}

func closeSetup(t *testing.T, launchReq string) (*closeFake, *Host, *Registry) {
	closeTimes(t, time.Minute, 5*time.Millisecond, 100*time.Millisecond)
	f := newCloseFake(t)
	h := &Host{Herdr: &herdr.Client{Socket: f.Socket}}
	reg := NewRegistry("m1")
	h.trackSessions(reg)
	reg.Upsert(proto.SessionInfo{ID: "s1", HerdrPane: "w1:p1", HerdrWorkspace: "w1", LaunchReq: launchReq})
	return f, h, reg
}

// requested waits for the close request to have read the terminal_id.
func requested(t *testing.T, f *closeFake, h *Host, reg *Registry) {
	t.Helper()
	n := f.lists()
	h.closeRequested(reg, "s1")
	require.Eventually(t, func() bool { return f.lists() > n }, 2*time.Second, 2*time.Millisecond)
	time.Sleep(20 * time.Millisecond)
}

// noClose waits longer than the polling window and checks that nothing was closed.
func noClose(t *testing.T, f *closeFake) {
	t.Helper()
	time.Sleep(3 * sessionCloseWindow / 2)
	require.Empty(t, f.closes())
}

func closedOnce(t *testing.T, f *closeFake) {
	t.Helper()
	require.Eventually(t, func() bool { return len(f.closes()) == 1 }, 2*time.Second, 2*time.Millisecond)
	require.Equal(t, []string{"w1:p1"}, f.closes())
	time.Sleep(30 * time.Millisecond)
	require.Len(t, f.closes(), 1)
}

func TestSessionCloseAfterGone(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	require.Empty(t, f.closes()) // not yet: Claude is still closing
	reg.Gone("s1")
	closedOnce(t, f)
}

func TestSessionCloseDoneStatus(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	f.set("agent_status", "done")
	requested(t, f, h, reg)
	reg.Gone("s1")
	closedOnce(t, f)
}

func TestSessionCloseGoneBeforeTerminalID(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	h.closeRequested(reg, "s1")
	reg.Gone("s1") // may arrive before the terminal_id is read
	closedOnce(t, f)
}

// Without Gone, the deadline only forgets the request: the owner might be using the shell.
func TestSessionCloseTimeoutWithoutGone(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	sessionCloseWait = 30 * time.Millisecond
	requested(t, f, h, reg)
	time.Sleep(60 * time.Millisecond)
	reg.Gone("s1") // late: the request was already forgotten
	noClose(t, f)
}

func TestSessionCloseNeedsCloseCommand(t *testing.T) {
	f, _, reg := closeSetup(t, "req1")
	reg.Gone("s1") // ended on its own: its tab stays
	noClose(t, f)
}

func TestSessionCloseNotQuorumLaunched(t *testing.T) {
	f, h, reg := closeSetup(t, "")
	h.closeRequested(reg, "s1")
	reg.Gone("s1")
	noClose(t, f)
}

func TestSessionCloseTerminalChanged(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	f.set("terminal_id", "term_2") // herdr reused the pane's id
	reg.Gone("s1")
	noClose(t, f)
}

func TestSessionCloseAgentBusy(t *testing.T) {
	for _, st := range []string{"working", "blocked", "unknown"} {
		t.Run(st, func(t *testing.T) {
			f, h, reg := closeSetup(t, "req1")
			requested(t, f, h, reg)
			f.set("agent_status", st)
			reg.Gone("s1")
			noClose(t, f)
		})
	}
}

// After Gone it polls: first working, then idle → closes.
func TestSessionCloseRetriesUntilIdle(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	sessionCloseWindow = 2 * time.Second
	requested(t, f, h, reg)
	f.set("agent_status", "working")
	n := f.lists()
	reg.Gone("s1")
	require.Eventually(t, func() bool { return f.lists() >= n+3 }, 2*time.Second, 2*time.Millisecond)
	require.Empty(t, f.closes())
	f.set("agent_status", "idle")
	closedOnce(t, f)
}

func TestSessionCloseRetriesListErrors(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	f.mu.Lock()
	f.fails = 3
	f.mu.Unlock()
	reg.Gone("s1")
	closedOnce(t, f)
}

func TestSessionCloseNoAgent(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	f.set("agent", "")
	f.set("agent_status", "unknown") // without an agent the status does not count
	reg.Gone("s1")
	closedOnce(t, f)
}

// The close command arriving from the hub arms the close; the registry's Gone triggers it.
func TestSessionCloseViaHubLink(t *testing.T) {
	closeTimes(t, time.Minute, 5*time.Millisecond, 100*time.Millisecond)
	f := newCloseFake(t)
	fh, reg := startLink(t, hostFor(t, f.Socket))
	reg.Upsert(proto.SessionInfo{ID: "s1", HerdrPane: "w1:p1", LaunchReq: "req1"})
	cmds, cancel := reg.Subscribe("s1")
	defer cancel()
	p, _ := json.Marshal(proto.Command{Type: "close"})
	fh.send(t, proto.Envelope{Type: "command", Session: "s1", Payload: p})
	select {
	case c := <-cmds:
		require.Equal(t, "close", c.Type)
	case <-time.After(3 * time.Second):
		t.Fatal("the close did not reach the session")
	}
	require.Eventually(t, func() bool { return f.lists() > 0 }, 2*time.Second, 2*time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	reg.Gone("s1")
	closedOnce(t, f)
}
