package daemon

import (
	"context"
	"encoding/json"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Focusing a herdr pane that runs a Claude session means the owner is looking at it: the daemon
// tells the hub (session_seen) so the session stops being unread on every device. herdr does not
// expose whether its UI client is attached (`herdr status client` only reports the local binary's
// version), so focus alone counts. A pane's `focused` in pane.list is global, not per workspace: it
// is true only for the active pane of the active tab of the focused workspace (workspace.list and
// tab.list carry their own `focused`, and an unfocused workspace's active tab reports its pane as
// not focused), so the pane flag alone is enough.

var (
	focusEvery    = 3 * time.Second  // pane.list polling period
	focusDebounce = 10 * time.Second // at most one report per session in this window
)

// focusWatcher polls herdr and reports the focused false->true edges of panes with a Claude session.
type focusWatcher struct {
	client *herdr.Client
	emit   func(session string)
	every  time.Duration
	now    func() time.Time

	started bool            // the first successful poll already ran
	focused map[string]bool // pane|session -> was focused at the last poll
	last    map[string]time.Time
}

func newFocusWatcher(c *herdr.Client, emit func(session string)) *focusWatcher {
	return &focusWatcher{client: c, emit: emit, every: focusEvery, now: time.Now,
		focused: map[string]bool{}, last: map[string]time.Time{}}
}

// run polls until ctx.Done. While herdr is down a poll fails fast and is retried on the next tick.
func (w *focusWatcher) run(ctx context.Context) {
	t := time.NewTicker(w.every)
	defer t.Stop()
	for {
		w.tick(ctx)
		select {
		case <-t.C:
		case <-ctx.Done():
			return
		}
	}
}

func (w *focusWatcher) tick(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	panes, err := w.client.ListPanes(cctx, "")
	cancel()
	if err != nil {
		return // keep the last known state: an outage must not look like a new focus
	}
	first := !w.started
	w.started = true
	cur := map[string]bool{}
	for _, p := range panes {
		if p.AgentSession == nil || p.AgentSession.Value == "" || (p.AgentSession.Agent != "" && p.AgentSession.Agent != "claude") {
			continue
		}
		sid := p.AgentSession.Value
		key := p.ID + "|" + sid
		cur[key] = p.Focused
		// the first poll (daemon start, config reload) only records the state: a pane that was
		// already focused is not a new look, so it must not clear an unread the owner never saw
		if first || !p.Focused || w.focused[key] {
			continue
		}
		if at, ok := w.last[sid]; ok && w.now().Sub(at) < focusDebounce {
			cur[key] = false // keep the edge pending: it fires once the window has passed
			continue
		}
		w.last[sid] = w.now()
		w.emit(sid)
	}
	w.focused = cur
	for sid, at := range w.last { // forget old debounce marks
		if w.now().Sub(at) >= focusDebounce {
			delete(w.last, sid)
		}
	}
}

// watchFocus starts the focus watcher; it stops with ctx.
func (h *Host) watchFocus(ctx context.Context, reg *Registry) {
	if h == nil || h.Herdr == nil || reg == nil {
		return
	}
	w := newFocusWatcher(h.Herdr, func(sid string) {
		reg.EmitEnvelope(proto.Envelope{Type: "session_seen", Machine: reg.machine, Session: sid, Payload: json.RawMessage("{}")})
	})
	go w.run(ctx)
}
