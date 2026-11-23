package daemon

import (
	"context"
	"log"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Closing a session from the app ends Claude but leaves its herdr tab with
// an idle shell. If Quorum launched that session in herdr and the session goes away after
// the close request, the daemon also closes the tab, only if the pane is still
// the same (same terminal_id) and there is no active agent in it. If the
// session does not go away within sessionCloseWait, the request is forgotten without closing anything (the
// owner might be using that shell). Sessions that end on their own
// close nothing.

// Deadlines; variables for tests (read when the close is requested, before starting
// goroutines).
var (
	sessionCloseWait   = 15 * time.Second // for the session to go away after the request
	sessionClosePoll   = time.Second      // pane.list polling after Gone
	sessionCloseWindow = 10 * time.Second // how long to poll before giving up
)

// pendingClose is a pending tab close; its mutable fields go under Host.cmu.
type pendingClose struct {
	pane         string
	wait         time.Duration
	poll, window time.Duration

	tid   string // terminal_id of the pane when the close was requested
	ready bool   // tid already read
	gone  bool   // the session already went away
	timer *time.Timer
}

// trackSessions hooks the Host to the registry's Gone events.
func (h *Host) trackSessions(reg *Registry) {
	if h == nil || reg == nil {
		return
	}
	reg.SetOnGone(h.sessionGone)
}

// closeRequested records the pending close of session id if Quorum launched it in
// herdr. It does not block: the terminal_id is read separately.
func (h *Host) closeRequested(reg *Registry, id string) {
	if h == nil || h.Herdr == nil || reg == nil {
		return
	}
	var si proto.SessionInfo
	for _, s := range reg.Snapshot() {
		if s.ID == id {
			si = s
			break
		}
	}
	if si.HerdrPane == "" || si.LaunchReq == "" {
		return // not launched by Quorum in herdr: its tab is not ours
	}
	p := &pendingClose{pane: si.HerdrPane, wait: sessionCloseWait,
		poll: sessionClosePoll, window: sessionCloseWindow}
	h.cmu.Lock()
	if h.closing == nil {
		h.closing = map[string]*pendingClose{}
	}
	if h.closing[id] != nil {
		h.cmu.Unlock()
		return
	}
	h.closing[id] = p
	h.cmu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), termCallWait)
		live, err := livePanes(ctx, h.Herdr)
		cancel()
		tid := live[p.pane]
		h.cmu.Lock()
		if err != nil || tid == "" {
			if h.closing[id] == p {
				delete(h.closing, id)
			}
			h.cmu.Unlock()
			log.Printf("sessions: tab of %s will not be closed (no terminal_id for %s: %v)", id, p.pane, err)
			return
		}
		p.tid, p.ready = tid, true
		gone := p.gone
		if !gone {
			p.timer = time.AfterFunc(p.wait, func() { h.dropClose(id, p) })
		}
		h.cmu.Unlock()
		if gone {
			h.closeTab(id, p)
		}
	}()
}

// sessionGone is called after each registry Gone; it does not block.
func (h *Host) sessionGone(id string) {
	h.cmu.Lock()
	p := h.closing[id]
	if p == nil {
		h.cmu.Unlock()
		return
	}
	p.gone = true
	ready := p.ready
	h.cmu.Unlock()
	if ready {
		go h.closeTab(id, p)
	}
}

// dropClose forgets the request if the session did not go away in time.
func (h *Host) dropClose(id string, p *pendingClose) {
	h.cmu.Lock()
	defer h.cmu.Unlock()
	if h.closing[id] == p && !p.gone {
		delete(h.closing, id)
		log.Printf("sessions: %s did not end after the close request; its tab stays", id)
	}
}

// closeTab (once per request, after Gone) polls pane.list during the
// window and closes the pane as soon as it is still the same terminal and has
// no active agent. If the pane disappears or changed terminal, it does nothing.
func (h *Host) closeTab(id string, p *pendingClose) {
	h.cmu.Lock()
	if h.closing[id] != p {
		h.cmu.Unlock()
		return
	}
	delete(h.closing, id)
	if p.timer != nil {
		p.timer.Stop()
	}
	h.cmu.Unlock()

	deadline := time.Now().Add(p.window)
	for {
		switch h.tabState(p) {
		case tabClose:
			ctx, cancel := context.WithTimeout(context.Background(), termCallWait)
			if err := h.Herdr.ClosePane(ctx, p.pane); err != nil && !herdr.IsNotFound(err) {
				log.Printf("sessions: could not close the tab of %s: %v", id, err)
			}
			cancel()
			return
		case tabDrop:
			return
		}
		if time.Now().Add(p.poll).After(deadline) {
			log.Printf("sessions: the tab of %s is still busy; not closing", id)
			return
		}
		time.Sleep(p.poll)
	}
}

type tabVerdict int

const (
	tabWait  tabVerdict = iota // active agent, doubtful state or pane.list failed
	tabClose                   // same terminal and no active agent
	tabDrop                    // the pane no longer exists or is another terminal
)

func (h *Host) tabState(p *pendingClose) tabVerdict {
	ctx, cancel := context.WithTimeout(context.Background(), termCallWait)
	defer cancel()
	panes, err := h.Herdr.ListPanes(ctx, "")
	if err != nil {
		return tabWait
	}
	for _, x := range panes {
		if x.ID != p.pane {
			continue
		}
		switch {
		case x.TerminalID != p.tid:
			return tabDrop // herdr reused the id: it is another pane now
		case x.Agent == "", x.AgentStatus == "idle", x.AgentStatus == "done":
			return tabClose
		default:
			return tabWait // working, blocked, unknown...
		}
	}
	return tabDrop
}
