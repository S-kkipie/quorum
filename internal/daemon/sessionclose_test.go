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

// closeFake es un herdr falso con el panel w1:p1 (terminal term_1, Claude ya
// terminado) que anota los pane.close.
type closeFake struct {
	*herdrtest.Fake
	mu   sync.Mutex
	pane map[string]any
}

func newCloseFake(t *testing.T) *closeFake {
	f := &closeFake{Fake: herdrtest.New(t)}
	f.pane = map[string]any{"pane_id": "w1:p1", "workspace_id": "w1", "terminal_id": "term_1",
		"agent": "claude", "agent_status": "idle"}
	f.Handle("pane.list", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
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

func closeSetup(t *testing.T, launchReq string) (*closeFake, *Host, *Registry) {
	old := sessionCloseWait
	sessionCloseWait = time.Minute
	t.Cleanup(func() { sessionCloseWait = old })
	f := newCloseFake(t)
	h := &Host{Herdr: &herdr.Client{Socket: f.Socket}}
	reg := NewRegistry("m1")
	h.trackSessions(reg)
	reg.Upsert(proto.SessionInfo{ID: "s1", HerdrPane: "w1:p1", HerdrWorkspace: "w1", LaunchReq: launchReq})
	return f, h, reg
}

// requested espera a que el pedido de cierre haya leído el terminal_id.
func requested(t *testing.T, f *closeFake, h *Host, reg *Registry) {
	t.Helper()
	n := f.lists()
	h.closeRequested(reg, "s1")
	require.Eventually(t, func() bool { return f.lists() > n }, 2*time.Second, 2*time.Millisecond)
	time.Sleep(20 * time.Millisecond)
}

func TestSessionCloseAfterGone(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	require.Empty(t, f.closes()) // todavía no: Claude sigue cerrándose
	reg.Gone("s1")
	require.Eventually(t, func() bool { return len(f.closes()) == 1 }, 2*time.Second, 2*time.Millisecond)
	require.Equal(t, []string{"w1:p1"}, f.closes())
	time.Sleep(30 * time.Millisecond)
	require.Len(t, f.closes(), 1)
}

func TestSessionCloseGoneBeforeTerminalID(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	h.closeRequested(reg, "s1")
	reg.Gone("s1") // puede llegar antes de que se lea el terminal_id
	require.Eventually(t, func() bool { return len(f.closes()) == 1 }, 2*time.Second, 2*time.Millisecond)
}

func TestSessionCloseDeadline(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	sessionCloseWait = 50 * time.Millisecond
	requested(t, f, h, reg)
	require.Eventually(t, func() bool { return len(f.closes()) == 1 }, 2*time.Second, 2*time.Millisecond)
}

func TestSessionCloseNeedsCloseCommand(t *testing.T) {
	f, _, reg := closeSetup(t, "req1")
	reg.Gone("s1") // terminó sola: su pestaña se queda
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, f.closes())
}

func TestSessionCloseNotQuorumLaunched(t *testing.T) {
	f, h, reg := closeSetup(t, "")
	sessionCloseWait = 30 * time.Millisecond
	h.closeRequested(reg, "s1")
	reg.Gone("s1")
	time.Sleep(80 * time.Millisecond)
	require.Empty(t, f.closes())
}

func TestSessionCloseTerminalChanged(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	f.set("terminal_id", "term_2") // herdr reusó el id del panel
	reg.Gone("s1")
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, f.closes())
}

func TestSessionCloseAgentStillWorking(t *testing.T) {
	for _, st := range []string{"working", "blocked"} {
		t.Run(st, func(t *testing.T) {
			f, h, reg := closeSetup(t, "req1")
			requested(t, f, h, reg)
			f.set("agent_status", st)
			reg.Gone("s1")
			time.Sleep(50 * time.Millisecond)
			require.Empty(t, f.closes())
		})
	}
}

func TestSessionCloseNoAgent(t *testing.T) {
	f, h, reg := closeSetup(t, "req1")
	requested(t, f, h, reg)
	f.set("agent", "")
	f.set("agent_status", "working") // sin agente el estado no cuenta
	reg.Gone("s1")
	require.Eventually(t, func() bool { return len(f.closes()) == 1 }, 2*time.Second, 2*time.Millisecond)
}

// El comando close que llega del hub arma el cierre; el Gone del registro lo dispara.
func TestSessionCloseViaHubLink(t *testing.T) {
	old := sessionCloseWait
	sessionCloseWait = time.Minute
	t.Cleanup(func() { sessionCloseWait = old })
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
		t.Fatal("el close no llegó a la sesión")
	}
	require.Eventually(t, func() bool { return f.lists() > 0 }, 2*time.Second, 2*time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	reg.Gone("s1")
	require.Eventually(t, func() bool { return len(f.closes()) == 1 }, 2*time.Second, 2*time.Millisecond)
}
