package hub

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/hub/web"
	"github.com/S-kkipie/quorum/internal/proto"
)

// askTracker remembers the open askIds (ask events) and closes them on seeing ask_resolved.
// The first decide wins: closing is atomic under the lock.
type askTracker struct {
	mu       sync.Mutex
	open     map[string]string // askId -> session
	resolved map[string]bool   // recently resolved (bounded), so reopen does not revive them
	order    []string
	claimed  map[string]bool // claimed by a decide in progress (reseed does not reopen them)
	// known: live sessions whose asks state was already seeded; a session_upsert for one
	// of them without previousId does not query the store again.
	known map[string]bool
}

const maxResolved = 1024

func newAskTracker() *askTracker {
	return &askTracker{open: map[string]string{}, resolved: map[string]bool{}, claimed: map[string]bool{}, known: map[string]bool{}}
}

func (t *askTracker) markResolved(id string) { // with t.mu held
	delete(t.open, id)
	delete(t.claimed, id)
	if t.resolved[id] {
		return
	}
	t.resolved[id] = true
	t.order = append(t.order, id)
	if len(t.order) > maxResolved {
		delete(t.resolved, t.order[0])
		t.order = t.order[1:]
	}
}

// resolve marks askId as resolved (e.g. if its ask_resolved could not be stored).
//
// Accepted case: resolved lives only in memory. If the hub restarts after a
// decide whose ask_resolved could not be stored, OpenAsks/reseed reopen that ask from
// the store and the app shows the card again. Answering it again sends a decide
// that the mod ignores (that askId is no longer waiting), so there is no double effect; the card
// goes away with the next ask_resolved or when the session closes.
func (t *askTracker) resolve(askID string) {
	t.mu.Lock()
	t.markResolved(askID)
	t.mu.Unlock()
}

// prune drops the asks whose session no longer exists or is closed (a single query).
func (t *askTracker) prune(st *store.Store) {
	live, err := st.LiveSessionIDs()
	if err != nil {
		log.Printf("hub: prune asks: %v", err)
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for a, sid := range t.open {
		if !live[sid] {
			delete(t.open, a)
		}
	}
	for id := range t.known {
		if !live[id] {
			delete(t.known, id)
		}
	}
}

// reseed rebuilds from the store the open asks of session id (and drops those of
// prev, its previous id: its events were already moved to id). So a session that comes back
// after the daemon or the machine restarts recovers its pending cards.
func (t *askTracker) hasAsksOf(session string) bool { // with t.mu held
	for _, s := range t.open {
		if s == session {
			return true
		}
	}
	return false
}

func (t *askTracker) reseed(st *store.Store, id, prev string) {
	t.mu.Lock()
	// Live session already seeded and a prev that adds nothing (rename already applied:
	// prev is neither alive nor has asks under its name; e.g. the stored previous_id that
	// repeats on every hello): nothing new to read.
	skip := t.known[id] && (prev == "" || !t.known[prev] && !t.hasAsksOf(prev))
	t.mu.Unlock()
	if skip {
		return
	}
	open, err := st.SessionOpenAsks(id)
	if err != nil {
		log.Printf("hub: open asks of %s: %v", id, err)
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.known[id] = true
	if prev != "" {
		delete(t.known, prev)
	}
	for a, s := range t.open {
		if (s == id || (prev != "" && s == prev)) && open[a] == "" {
			delete(t.open, a)
		}
	}
	for a := range open {
		if !t.resolved[a] && !t.claimed[a] {
			t.open[a] = id
		}
	}
}

func (t *askTracker) observe(env proto.Envelope, st *store.Store) {
	switch env.Type {
	case "session_gone":
		t.mu.Lock()
		delete(t.known, env.Session)
		t.mu.Unlock()
		t.prune(st)
		return
	case "session_upsert":
		var si proto.SessionInfo
		if json.Unmarshal(env.Payload, &si) == nil && si.ID != "" {
			t.reseed(st, si.ID, si.PreviousID)
		}
		return
	case "machine_status":
		var m store.Machine
		if json.Unmarshal(env.Payload, &m) == nil && !m.Online {
			t.prune(st)
		}
		return
	case "event":
	default:
		return
	}
	var ev proto.Event
	if json.Unmarshal(env.Payload, &ev) != nil {
		return
	}
	switch ev.Kind {
	case proto.KindAsk:
		var a proto.Ask
		if json.Unmarshal(ev.Data, &a) == nil && a.AskID != "" {
			t.mu.Lock()
			t.open[a.AskID] = ev.Session
			t.mu.Unlock()
		}
	case proto.KindAskResolved:
		var a proto.AskResolved
		if json.Unmarshal(ev.Data, &a) == nil {
			t.mu.Lock()
			t.markResolved(a.AskID)
			t.mu.Unlock()
		}
	}
}

// claim closes askId if it is open in that session; only one caller gets it.
func (t *askTracker) claim(askID, session string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if s, ok := t.open[askID]; !ok || s != session {
		return false
	}
	delete(t.open, askID)
	t.claimed[askID] = true
	return true
}

func (t *askTracker) reopen(askID, session string) {
	t.mu.Lock()
	delete(t.claimed, askID)
	if !t.resolved[askID] {
		t.open[askID] = session
	}
	t.mu.Unlock()
}

func (s *Server) sendCommand(si proto.SessionInfo, cmd proto.Command) bool {
	p, _ := json.Marshal(cmd)
	return s.hub.SendToMachine(si.Machine, proto.Envelope{Type: "command", Machine: si.Machine, Session: si.ID, Payload: p})
}

// sessionLive: session id exists and is not closed.
func (s *Server) sessionLive(id string) bool {
	si, err := s.st.Session(id)
	return err == nil && si.State != proto.StateClosed
}

func apiErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) routes() {
	dev := func(pattern string, f http.HandlerFunc) { s.mux.Handle(pattern, s.requireDevice(f)) }
	dev("GET /api/machines", s.handleMachines)
	dev("GET /api/sessions", s.handleSessions)
	dev("GET /api/usage", s.handleUsage)
	dev("POST /api/devices/push", s.handleAddPush)
	dev("DELETE /api/devices/push", s.handleDeletePush)
	dev("GET /api/sessions/{id}/events", s.handleEvents)
	dev("GET /api/sessions/{id}/history", s.handleHistory)
	dev("POST /api/sessions/{id}/prompt", s.handlePrompt)
	dev("POST /api/sessions/{id}/files", s.handleUpload)
	dev("POST /api/sessions/{id}/seen", s.handleSeen)
	dev("GET /api/sessions/{id}/plugins/{plugin}", s.handlePluginState)
	dev("POST /api/sessions/{id}/plugin", s.handlePluginCommand)
	dev("GET /api/sessions/{id}/commands", s.handleCommands)
	dev("POST /api/sessions/{id}/command", s.handleRunCommand)
	dev("POST /api/sessions/{id}/model", s.handleSetModel)
	dev("POST /api/sessions/{id}/decide", s.handleDecide)
	dev("POST /api/sessions/{id}/abort", s.handleSimple("abort"))
	dev("POST /api/sessions/{id}/close", s.handleSimple("close"))
	dev("POST /api/sessions/{id}/ticket", s.handleLinkTicket)
	dev("DELETE /api/sessions/{id}/ticket", s.handleUnlinkTicket)
	dev("POST /api/launch", s.handleLaunch)
	dev("POST /api/tickets/{id}/launch", s.handleTicketLaunch)
	dev("GET /api/projects/suggestions", s.handleSuggestions)
	dev("POST /api/workspaces", s.handleCreateWorkspace)
	dev("POST /api/projects", s.handleCreateProject)
	s.projectRoutes(dev)
	s.briefingRoutes(dev)
	dev("POST /api/tickets/{id}/proposals", s.handleCreateProposal)
	dev("POST /api/proposals/{id}/approve", s.handleApproveProposal)
	dev("POST /api/proposals/{id}/reject", s.handleRejectProposal)
	dev("POST /api/projects/{id}/sync", s.handleSyncProject)
	dev("GET /api/machines/{m}/conversations", s.handleConversations)
	dev("POST /api/machines/{m}/terminals", s.handleTermOpen)
	dev("POST /api/machines/{m}/terminals/{pane}/watch", s.handleTermWatch)
	dev("POST /api/machines/{m}/terminals/{pane}/input", s.handleTermInput)
	dev("GET /api/machines/{m}/terminals/{pane}/read", s.handleTermRead)
	dev("DELETE /api/machines/{m}/terminals/{pane}", s.handleTermClose)
	dev("POST /api/machines/{m}/views", s.handleCreateView)
	// /v/ carries no device token: the link token is the auth. Server.Handler() routes every
	// /v/ path to handleView before the mux (viewHandler), so this registration is never
	// reached in practice; it only reserves the pattern ahead of "/".
	s.mux.HandleFunc("GET /v/{token}/{rest...}", s.handleView)
	s.mux.Handle("/", web.Handler())
	dev("GET /api/live", s.handleLive)
}

func (s *Server) handleMachines(w http.ResponseWriter, r *http.Request) {
	ms, err := s.st.ListMachines()
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if ms == nil {
		ms = []store.Machine{}
	}
	writeJSON(w, 200, ms)
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListSessions(r.URL.Query().Get("closed") == "1")
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if list == nil {
		list = []proto.SessionInfo{}
	}
	writeJSON(w, 200, list)
}

func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListUsage(s.hub.now().UnixMilli())
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if a := q.Get("after"); a != "" {
		s.handleEventsAfter(w, r, a)
		return
	}
	before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	limit, err := strconv.Atoi(q.Get("limit"))
	if err != nil || limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}
	evs, err := s.st.Events(r.PathValue("id"), before, limit)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if len(evs) == 0 && before == 0 {
		// No stored history: ask the machine to rebuild it from the transcript.
		// Not awaited; the result arrives through the live feed.
		if si, err := s.st.Session(r.PathValue("id")); err == nil {
			s.hub.requestBackfill(si.Machine, si.ID)
		}
	}
	if evs == nil {
		evs = []proto.Event{}
	}
	writeJSON(w, 200, evs)
}

// handleEventsAfter serves the delta sync: events with seq > after, ascending, at most 500.
func (s *Server) handleEventsAfter(w http.ResponseWriter, r *http.Request, a string) {
	after, err := strconv.ParseInt(a, 10, 64)
	if err != nil {
		apiErr(w, 400, "invalid after")
		return
	}
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit <= 0 || limit > maxDeltaEvents {
		limit = maxDeltaEvents
	}
	evs, err := s.st.EventsAfter(r.PathValue("id"), after, limit)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if evs == nil {
		evs = []proto.Event{}
	}
	writeJSON(w, 200, evs)
}

// target resolves the route's session and checks that commands can be sent to it.
func (s *Server) target(w http.ResponseWriter, r *http.Request) (proto.SessionInfo, bool) {
	si, err := s.st.Session(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "session not found")
		return si, false
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return si, false
	}
	if si.State == proto.StateClosed {
		apiErr(w, 409, "the session is closed")
		return si, false
	}
	if !s.hub.Connected(si.Machine) {
		apiErr(w, 409, "machine is offline")
		return si, false
	}
	return si, true
}

func (s *Server) dispatch(w http.ResponseWriter, si proto.SessionInfo, cmd proto.Command) bool {
	if !s.sendCommand(si, cmd) {
		apiErr(w, 409, "machine is offline")
		return false
	}
	return true
}

func (s *Server) handlePrompt(w http.ResponseWriter, r *http.Request) {
	var b struct{ Text, Mode string }
	if !decode(w, r, &b) {
		return
	}
	if b.Text == "" {
		apiErr(w, 400, "the message is empty")
		return
	}
	switch b.Mode {
	case "":
		b.Mode = "queue"
	case "now", "queue", "interrupt":
	default:
		apiErr(w, 400, "invalid mode")
		return
	}
	si, ok := s.target(w, r)
	if !ok || !s.dispatch(w, si, proto.Command{Type: "prompt", Text: b.Text, Mode: b.Mode}) {
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) handleSimple(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		si, ok := s.target(w, r)
		if !ok || !s.dispatch(w, si, proto.Command{Type: kind}) {
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}
}

func (s *Server) handleDecide(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AskID    string            `json:"askId"`
		Decision string            `json:"decision"`
		Answers  map[string]string `json:"answers"`
		Reason   string            `json:"reason"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.AskID == "" {
		apiErr(w, 400, "missing askId")
		return
	}
	if b.Decision != "allow" && b.Decision != "deny" {
		apiErr(w, 400, "invalid decision")
		return
	}
	si, ok := s.target(w, r)
	if !ok {
		return
	}
	if !s.asks.claim(b.AskID, si.ID) {
		apiErr(w, 409, "already answered")
		return
	}
	cmd := proto.Command{Type: "decide", AskID: b.AskID, Decision: b.Decision, Answers: b.Answers, Reason: b.Reason}
	if !s.sendCommand(si, cmd) {
		s.asks.reopen(b.AskID, si.ID)
		apiErr(w, 409, "machine is offline")
		return
	}
	data, _ := json.Marshal(proto.AskResolved{AskID: b.AskID, By: "device:" + AuthName(r.Context())})
	ev := proto.Event{Session: si.ID, TS: time.Now().UnixMilli(), Kind: proto.KindAskResolved, Data: data}
	seq, err := s.st.AppendEvent(ev)
	if err != nil {
		// Without seq it is not published (apps order by seq); the ask is left resolved
		// here so it is neither kept claimed nor reopened by a reseed.
		log.Printf("hub: save ask_resolved of %s: %v", si.ID, err)
		s.asks.resolve(b.AskID)
		w.WriteHeader(http.StatusAccepted)
		return
	}
	ev.Seq = seq
	p, _ := json.Marshal(ev)
	s.hub.publish(proto.Envelope{Type: "event", Machine: si.Machine, Session: si.ID, Payload: p})
	w.WriteHeader(http.StatusAccepted)
}

// launchPromptMax caps the optional first prompt of /api/launch (the app builds about 1,500 characters).
const launchPromptMax = 8000

// handleLaunch asks a machine to open a new session; the result arrives through /api/live.
func (s *Server) handleLaunch(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Machine        string `json:"machine"`
		Dir            string `json:"dir"`
		Continue       bool   `json:"continue"`
		PermissionMode string `json:"permissionMode"`
		Resume         string `json:"resume"`
		Label          string `json:"label"`
		ProjectID      string `json:"projectId"`
		// Prompt is an optional first message (the app's "Continue where I left off").
		Prompt string `json:"prompt"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Dir == "" {
		apiErr(w, 400, "missing folder")
		return
	}
	b.Prompt = strings.TrimSpace(b.Prompt)
	if utf8.RuneCountInString(b.Prompt) > launchPromptMax {
		apiErr(w, 400, fmt.Sprintf("the first prompt can be at most %d characters", launchPromptMax))
		return
	}
	if b.Machine == "" || !s.hub.Connected(b.Machine) {
		apiErr(w, 409, "machine is offline")
		return
	}
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	// without an explicit label, the new workspace takes the project's name
	if b.Label == "" && b.ProjectID != "" {
		if p, err := s.st.GetProject(b.ProjectID); err == nil {
			b.Label = p.Name
		}
	}
	req := proto.LaunchRequest{ReqID: hex.EncodeToString(id), Dir: b.Dir, Continue: b.Continue, PermissionMode: b.PermissionMode,
		Resume: b.Resume, Label: b.Label, Prompt: b.Prompt, Trust: true}
	p, _ := json.Marshal(req)
	// the pending entry binds the session that registers with this reqId (launch_session). Without
	// a ticket addPending does not deduplicate and always registers it: its result does not matter.
	s.hub.addPending(req.ReqID, pendingLaunch{machine: b.Machine, root: b.Dir})
	if !s.hub.SendToMachine(b.Machine, proto.Envelope{Type: "launch", Machine: b.Machine, Payload: p}) {
		s.hub.dropPending(req.ReqID)
		apiErr(w, 409, "machine is offline")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"reqId": req.ReqID})
}
