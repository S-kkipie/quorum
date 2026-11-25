package hub

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	offlineGrace = 60 * time.Second
	writeTimeout = 5 * time.Second
	helloTimeout = 10 * time.Second
	readLimit    = 8 << 20
)

// Broadcaster receives every envelope the hub accepts from a machine (Task 7
// connects it to the live stream to the apps).
type Broadcaster interface{ Publish(proto.Envelope) }

type noopBroadcaster struct{}

func (noopBroadcaster) Publish(proto.Envelope) {}

type stopper interface{ Stop() bool }

type machineConn struct {
	name string
	ws   *websocket.Conn
	wmu  sync.Mutex // serializes writes
}

// writeTimeoutFor scales the write deadline with the message size (5 s + 1 s
// per MiB): a large batch (backfill of up to 4 MiB) does not cut off a slow but healthy client.
func writeTimeoutFor(env proto.Envelope) time.Duration {
	return writeTimeout + time.Duration(len(env.Payload))*time.Second/(1<<20)
}

// machinePing: how often the hub pings each machine; two pings without a pong
// close the connection (and the normal grace period starts). In nanoseconds; tests shorten it.
var machinePing atomic.Int64

func init() { machinePing.Store(int64(30 * time.Second)) }

// defaultAfterFunc creates the offline timers; tests replace it before
// NewServer to control the startup grace period.
var defaultAfterFunc = func(d time.Duration, f func()) stopper { return time.AfterFunc(d, f) }

func (c *machineConn) write(ctx context.Context, env proto.Envelope) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, writeTimeoutFor(env))
	defer cancel()
	return wsjson.Write(ctx, c.ws, env)
}

// Hub holds the machines' WS connections.
type Hub struct {
	st        *store.Store
	afterFunc func(d time.Duration, f func()) stopper // injectable in tests

	smu    sync.Mutex // serializes machine state changes (expire vs hello)
	mu     sync.Mutex
	conns  map[string]*machineConn
	timers map[string]stopper
	gen    uint64 // identifies each offline timer
	gens   map[string]uint64
	bc     Broadcaster
	// backfills remembers when each session's history was requested (in-memory dedupe).
	backfills map[string]time.Time
	// suggested: last (branch, project) used to look up tickets per session.
	sugg map[string]string
	// touch tells the summarizer that a project changed (nil in tests).
	touch func(projectID string)
	// seenSess: session -> project it was already reported for (only a new session in the project counts).
	seenSess map[string]string
	// doneTimers: session -> end_seq whose done attention grace timer is armed.
	doneTimers map[string]int64
	// upsertLocks: session id -> *sync.Mutex held from reading a session's unread to publishing it,
	// so a seen that lands meanwhile is always published after (never undone by) a stale upsert.
	upsertLocks sync.Map
	upsertHook  atomic.Pointer[func(id string)] // tests: runs between the unread read and the publish
	// pusher sends each attention to the phones (nil: push is off).
	pusher atomic.Pointer[Pusher]

	pmu sync.Mutex // serializes the creation/update of drafts
	// pending: launches from a ticket waiting for the session to register (by reqId).
	pending map[string]pendingLaunch
	now     func() time.Time
	rpcState
}

// Connected says whether the machine has a live connection.
func (h *Hub) Connected(machine string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conns[machine] != nil
}

func newHub(st *store.Store) *Hub {
	return &Hub{
		st:         st,
		conns:      map[string]*machineConn{},
		timers:     map[string]stopper{},
		gens:       map[string]uint64{},
		bc:         noopBroadcaster{},
		backfills:  map[string]time.Time{},
		sugg:       map[string]string{},
		seenSess:   map[string]string{},
		doneTimers: map[string]int64{},
		pending:    map[string]pendingLaunch{},
		now:        time.Now,
		afterFunc:  defaultAfterFunc,
	}
}

func (h *Hub) SetBroadcaster(b Broadcaster) {
	if b == nil {
		b = noopBroadcaster{}
	}
	h.mu.Lock()
	h.bc = b
	h.mu.Unlock()
}

func (h *Hub) publish(env proto.Envelope) {
	h.mu.Lock()
	b := h.bc
	h.mu.Unlock()
	b.Publish(env)
}

// SendToMachine sends env to the machine; false if it is not connected or the write fails.
func (h *Hub) SendToMachine(machine string, env proto.Envelope) bool {
	h.mu.Lock()
	c := h.conns[machine]
	h.mu.Unlock()
	if c == nil {
		return false
	}
	if err := c.write(context.Background(), env); err != nil {
		return false
	}
	return true
}

const backfillEvery = 60 * time.Second

// requestBackfill asks the machine for the session's history from its transcript.
// At most once per backfillEvery and session; false if nothing was sent.
func (h *Hub) requestBackfill(machine, session string) bool {
	if !h.Connected(machine) {
		return false
	}
	h.mu.Lock()
	now := h.now()
	if t, ok := h.backfills[session]; ok && now.Sub(t) < backfillEvery {
		h.mu.Unlock()
		return false
	}
	for id, t := range h.backfills { // bounds the map
		if now.Sub(t) >= backfillEvery {
			delete(h.backfills, id)
		}
	}
	// Marked before sending: two simultaneous requests do not send two backfills.
	h.backfills[session] = now
	h.mu.Unlock()
	if !h.SendToMachine(machine, proto.Envelope{Type: "backfill", Machine: machine, Session: session}) {
		h.mu.Lock()
		if h.backfills[session] == now {
			delete(h.backfills, session)
		}
		h.mu.Unlock()
		return false
	}
	return true
}

func (s *Server) handleMachineWS(w http.ResponseWriter, r *http.Request) {
	name := AuthName(r.Context())
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.watchToken(ctx, "machine", func() { ws.Close(websocket.StatusPolicyViolation, "token revoked") })
	s.hub.serve(ctx, name, ws)
}

func (h *Hub) serve(ctx context.Context, name string, ws *websocket.Conn) {
	defer ws.CloseNow()
	ctx, cancel0 := context.WithCancel(ctx)
	defer cancel0()
	var first proto.Envelope
	hctx, cancel := context.WithTimeout(ctx, helloTimeout)
	err := wsjson.Read(hctx, ws, &first)
	cancel()
	if err != nil || first.Type != "hello" {
		ws.Close(websocket.StatusPolicyViolation, "expected hello")
		return
	}
	var hello proto.MachineHello
	if json.Unmarshal(first.Payload, &hello) != nil {
		ws.Close(websocket.StatusUnsupportedData, "invalid hello")
		return
	}
	c := &machineConn{name: name, ws: ws}
	h.smu.Lock()
	h.attach(c)
	defer h.failWaiters(c)
	defer h.detach(c)
	ok := h.onHello(name, hello)
	h.smu.Unlock()
	if !ok {
		ws.Close(websocket.StatusInternalError, "internal error")
		return
	}
	go pingLoop(ctx, ws)
	for {
		var env proto.Envelope
		if err := wsjson.Read(ctx, ws, &env); err != nil {
			return
		}
		h.onMessage(c, env)
	}
}

// pingLoop pings the machine every machinePing; after two consecutive pings without a
// pong it closes the connection, so "online" does not depend only on TCP keepalive.
func pingLoop(ctx context.Context, ws *websocket.Conn) {
	every := time.Duration(machinePing.Load())
	t := time.NewTicker(every)
	defer t.Stop()
	missed := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pctx, cancel := context.WithTimeout(ctx, every)
		err := ws.Ping(pctx)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			missed = 0
			continue
		}
		if missed++; missed >= 2 {
			ws.CloseNow()
			return
		}
	}
}

// attach registers c, replacing (and closing) any previous connection and
// cancelling the pending offline timer.
func (h *Hub) attach(c *machineConn) {
	h.mu.Lock()
	old := h.conns[c.name]
	h.conns[c.name] = c
	if t := h.timers[c.name]; t != nil {
		t.Stop()
		delete(h.timers, c.name)
		delete(h.gens, c.name)
	}
	h.mu.Unlock()
	if old != nil {
		// The orderly close waits for the peer: do not block the new connection.
		go old.ws.Close(websocket.StatusNormalClosure, "replaced by another connection")
	}
}

// detach removes c (if it is still current) and starts the 60 s grace period.
func (h *Hub) detach(c *machineConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[c.name] != c {
		return // replaced: the new connection rules
	}
	delete(h.conns, c.name)
	h.startGraceLocked(c.name)
}

// startGraceLocked starts name's offline grace period (with h.mu held).
func (h *Hub) startGraceLocked(name string) {
	h.gen++
	gen := h.gen
	h.gens[name] = gen
	h.timers[name] = h.afterFunc(offlineGrace, func() { h.expire(name, gen) })
}

// startupGrace: after a hub restart nobody is connected. Each machine with open
// sessions gets the normal grace period: if it returns in time, nothing is closed; if not, its
// sessions are closed (and their asks pruned) as in any drop.
func (h *Hub) startupGrace() {
	ss, err := h.st.ListSessions(false)
	if err != nil {
		log.Printf("hub: open sessions at startup: %v", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, si := range ss {
		if h.conns[si.Machine] == nil && h.timers[si.Machine] == nil {
			h.startGraceLocked(si.Machine)
		}
	}
}

func (h *Hub) expire(name string, gen uint64) {
	h.smu.Lock()
	defer h.smu.Unlock()
	h.mu.Lock()
	if h.gens[name] != gen || h.timers[name] == nil || h.conns[name] != nil {
		h.mu.Unlock()
		return
	}
	delete(h.timers, name)
	delete(h.gens, name)
	h.mu.Unlock()
	m := h.machine(name)
	if err := h.st.UpsertMachine(name, m.OS, m.Env, m.Version, false, m.Caps); err != nil {
		log.Printf("hub: mark offline %s: %v", name, err)
		return
	}
	closed, err := h.st.MarkMachineSessionsClosed(name)
	if err != nil {
		log.Printf("hub: close sessions of %s: %v", name, err)
	}
	h.publishGone(name, closed)
	h.publishStatus(name)
}

// publishGone notifies the apps of the sessions the hub closed on its own.
func (h *Hub) publishGone(machine string, ids []string) {
	for _, id := range ids {
		h.forgetSuggested(id)
		h.publish(proto.Envelope{Type: "session_gone", Machine: machine, Session: id})
	}
}

func (h *Hub) machine(name string) store.Machine {
	ms, _ := h.st.ListMachines()
	for _, m := range ms {
		if m.Name == name {
			return m
		}
	}
	return store.Machine{Name: name}
}

func (h *Hub) publishStatus(name string) {
	p, _ := json.Marshal(h.machine(name))
	h.publish(proto.Envelope{Type: "machine_status", Machine: name, Payload: p})
}

func (h *Hub) onHello(name string, hello proto.MachineHello) bool {
	hello.Machine = name // send the authenticated name
	keep := make([]string, 0, len(hello.Sessions))
	// A previousId that also arrives alive in the hello is an old rename (resume
	// of the previous id): applying it would merge two live sessions.
	inHello := make(map[string]bool, len(hello.Sessions))
	for _, si := range hello.Sessions {
		inHello[si.ID] = true
	}
	for i := range hello.Sessions {
		if inHello[hello.Sessions[i].PreviousID] {
			hello.Sessions[i].PreviousID = ""
		}
	}
	if err := h.st.UpsertMachine(name, hello.OS, hello.Env, hello.Version, true, hello.Caps); err != nil {
		log.Printf("hub: hello de %s: %v", name, err)
		return false
	}
	for i := range hello.Sessions {
		hello.Sessions[i].Machine = name
		hello.Sessions[i].ProjectID = ""
		if err := h.st.UpsertSession(hello.Sessions[i]); err != nil {
			log.Printf("hub: session %s of %s ignored: %v", hello.Sessions[i].ID, name, err)
			continue
		}
		keep = append(keep, hello.Sessions[i].ID)
		h.attachCheckout(name, &hello.Sessions[i])
	}
	closed, err := h.st.CloseMachineSessionsExcept(name, keep)
	if err != nil {
		log.Printf("hub: close old sessions of %s: %v", name, err)
	}
	h.publishGone(name, closed)
	// The apps do not listen to hello: each accepted session (not the rejected foreign ones)
	// is published as session_upsert, with what the store saved.
	for _, id := range keep {
		si, err := h.st.Session(id)
		if err != nil {
			continue
		}
		p, _ := json.Marshal(si)
		h.publish(proto.Envelope{Type: "session_upsert", Machine: name, Session: id, Payload: p})
		h.suggestFromBranch(si)
		if si.LaunchReq != "" {
			h.matchPending(si, false) // the launched session may have arrived first in the hello
		}
		h.checkAttention(name, id) // only real transitions: the announced marks are stored
	}
	h.publishStatus(name)
	return true
}

// saveUsage records the rate limits a session reported under its account and publishes usage_upsert
// when they changed. It stores only the alias and the accountKey, never the account identity.
func (h *Hub) saveUsage(machine string, si proto.SessionInfo) {
	if len(si.RateLimits) == 0 || si.Account == "" || si.UsageAt <= 0 {
		return // no report, the account is still unresolved, or never measured
	}
	// Every session update re-sends the last rate limits: they are saved at the time they were
	// measured (never later than now), so a re-sent or older reading is ignored by the store.
	at := min(si.UsageAt, h.now().UnixMilli())
	key := store.UsageKey(machine, si)
	u, changed, err := h.st.SaveUsage(key, si.Account, si.RateLimits, at)
	if err != nil {
		log.Printf("hub: usage %s: %v", key, err)
		return
	}
	if changed {
		p, _ := json.Marshal(u)
		h.publish(proto.Envelope{Type: "usage_upsert", Machine: machine, Payload: p})
	}
	if si.AccountKey != "" {
		// the identity resolved: drop the machine/alias fallback row it supersedes
		fallback := machine + "/" + si.Account
		if removed, err := h.st.DeleteUsage(fallback); err != nil {
			log.Printf("hub: usage %s: %v", fallback, err)
		} else if removed {
			p, _ := json.Marshal(map[string]string{"key": fallback})
			h.publish(proto.Envelope{Type: "usage_gone", Machine: machine, Payload: p})
		}
	}
}

// owns says whether session id may be touched by name: new or its own.
func (h *Hub) owns(name, id string) bool {
	owner, exists, err := h.st.SessionOwner(id)
	if err != nil {
		log.Printf("hub: owner of %s: %v", id, err)
		return false
	}
	if exists && owner != name {
		log.Printf("hub: %s tried to touch session %s of %s; ignored", name, id, owner)
		return false
	}
	return true
}

// sessionOwnedBy: the session exists and belongs to name.
func (h *Hub) sessionOwnedBy(name, id string) (bool, error) {
	owner, exists, err := h.st.SessionOwner(id)
	return exists && owner == name, err
}

func (h *Hub) onMessage(c *machineConn, env proto.Envelope) {
	name := c.name
	h.mu.Lock()
	current := h.conns[name] == c
	h.mu.Unlock()
	if !current {
		return // connection replaced: it no longer rules
	}
	env.Machine = name
	var upsert *proto.SessionInfo // session_upsert: its unread is read fresh right before publishing
	switch env.Type {
	case "session_upsert":
		var si proto.SessionInfo
		if json.Unmarshal(env.Payload, &si) != nil {
			return
		}
		si.Machine = name
		if !h.owns(name, si.ID) {
			return
		}
		_, existed, _ := h.st.SessionOwner(si.ID) // only a new session fulfills a launch by folder
		repo, branch := si.RepoURL, si.Branch
		// The store decides whether the rename applies (it does not if the old id came back alive)
		// and validates that prev belongs to this machine.
		applied, err := h.st.SaveSession(si)
		if err != nil {
			log.Printf("hub: upsert %s: %v", si.ID, err)
			return
		}
		si.PreviousID = applied
		si.RepoURL, si.Branch = repo, branch
		si.Unread = false // computed by the hub right before publishing, never trusted from the mod
		upsert = &si
		defer h.checkAttention(name, si.ID) // after the session_upsert is published
		defer h.saveUsage(name, si)         // after the session_upsert is published
		h.attachCheckout(name, &si)
		env.Session = si.ID
		// By reqId any session fulfills it (also a resume with a new id); by folder only
		// a new one: a rename (/clear: PreviousID applied) follows the old session.
		if fresh := !existed && applied == ""; fresh || si.LaunchReq != "" {
			defer h.matchPending(si, fresh) // after publishing and after suggestFromBranch (LIFO)
		}
		defer h.suggestFromBranch(si) // after publishing the session_upsert
		if applied != "" {
			h.forgetSuggested(applied)
			// registered later: runs before suggestFromBranch (LIFO), without duplicating session_ticket
			defer h.publishLinks(name, si.ID) // the links traveled with the rename
		}
	case "session_gone":
		if !h.owns(name, env.Session) {
			return
		}
		h.forgetSuggested(env.Session)
		removed, err := h.st.CloseSession(name, env.Session)
		if err != nil {
			log.Printf("hub: gone %s: %v", env.Session, err)
			return
		}
		if removed {
			h.publish(proto.Envelope{Type: "session_removed", Machine: name, Session: env.Session})
			return
		}
	case "session_commands":
		h.saveSessionCommands(name, env)
		return // published by saveSessionCommands, and only when the list changed
	case "session_seen":
		// the owner focused this session's herdr pane: it was looked at up to its latest event
		if !h.owns(name, env.Session) {
			return
		}
		before, err := h.st.Session(env.Session)
		if err != nil {
			return // unknown session
		}
		if moved, err := h.st.SetSeen(env.Session, math.MaxInt64); err != nil {
			log.Printf("hub: seen of %s: %v", env.Session, err)
		} else if moved && before.Unread {
			h.publishStored(env.Session)
		}
	case "backfill_result":
		var evs []proto.Event
		if json.Unmarshal(env.Payload, &evs) != nil || len(evs) == 0 {
			return
		}
		if exists, err := h.sessionOwnedBy(name, env.Session); err != nil || !exists {
			return // only the owner of a known session fills in its history
		}
		inserted, err := h.st.PrependEvents(env.Session, evs)
		if err != nil {
			log.Printf("hub: history of %s: %v", env.Session, err)
			return
		}
		if !inserted {
			return
		}
		stored, err := h.st.Events(env.Session, 1, len(evs)) // Seq < 1: only the backfilled ones
		if err != nil || len(stored) == 0 {
			return
		}
		for i, j := 0, len(stored)-1; i < j; i, j = i+1, j-1 { // ascending
			stored[i], stored[j] = stored[j], stored[i]
		}
		// A single "events" envelope: hundreds of loose "event"s would overflow the
		// buffer of every connected app and the hub would disconnect it.
		p, _ := json.Marshal(stored)
		h.publish(proto.Envelope{Type: "events", Machine: name, Session: env.Session, Payload: p})
		return // the result itself is not broadcast
	case "event":
		var ev proto.Event
		if json.Unmarshal(env.Payload, &ev) != nil {
			return
		}
		if !h.owns(name, ev.Session) {
			return
		}
		if ev.Kind == proto.KindTicket {
			h.onTicketCommand(ev) // command from the mod: not stored as an event
			return
		}
		seq, err := h.st.AppendEvent(ev)
		if err != nil {
			log.Printf("hub: event of %s: %v", ev.Session, err)
			return
		}
		ev.Seq = seq
		env.Session = ev.Session
		env.Payload, _ = json.Marshal(ev)
		if seq > 0 {
			defer h.afterEvent(name, ev) // after the event is published
		}
		if ev.Kind == proto.KindTurnEnd {
			defer h.suggestFromTurnEnd(ev)
			defer h.draftFromTurnEnd(ev)
			defer h.touchSession(ev.Session)
		}
	case "caps":
		var caps proto.MachineCaps
		if json.Unmarshal(env.Payload, &caps) != nil {
			return
		}
		if err := h.st.SetMachineCaps(name, caps); err != nil {
			log.Printf("hub: caps de %s: %v", name, err)
			return
		}
		h.publishStatus(name)
		return
	case "rpc_result":
		var res proto.RPCResult
		if json.Unmarshal(env.Payload, &res) == nil {
			h.resolveRPC(name, res)
		}
		return // not broadcast
	case "term_frame":
		// a pane's screen: forwarded to the apps as is (Machine is already the authenticated one) and not stored
	case "launch_result":
		var lr proto.LaunchResult
		if json.Unmarshal(env.Payload, &lr) == nil && !lr.OK {
			h.dropPending(lr.ReqID)
		}
		// forwarded to the apps as is
	default:
		// unknown types (or ones only the hub emits, like machine_status) are not broadcast
		return
	}
	if upsert != nil {
		unlock := h.lockUpsert(upsert.ID)
		defer unlock() // runs before the deferred attention/usage work above
		if stored, err := h.st.Session(upsert.ID); err == nil {
			upsert.Unread = stored.Unread // a seen that landed meanwhile is not undone by a stale true
		}
		env.Payload, _ = json.Marshal(upsert)
		if hook := h.upsertHook.Load(); hook != nil {
			(*hook)(upsert.ID)
		}
	}
	h.publish(env)
}

// lockUpsert serializes reading a session's unread with publishing it (see upsertLocks).
func (h *Hub) lockUpsert(id string) (unlock func()) {
	m, _ := h.upsertLocks.LoadOrStore(id, new(sync.Mutex))
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (h *Hub) touchProject(id string) {
	if h.touch != nil && id != "" {
		h.touch(id)
	}
}

// touchSession marks the session's project (if it has one) for summarizing.
func (h *Hub) touchSession(id string) {
	if h.touch == nil {
		return
	}
	if si, err := h.st.Session(id); err == nil {
		h.touchProject(si.ProjectID)
	}
}

// touchNewSession notifies the summarizer only when the session first appears in the project.
func (h *Hub) touchNewSession(si proto.SessionInfo) {
	if h.touch == nil || si.ProjectID == "" || si.Role == proto.RoleService {
		return
	}
	h.mu.Lock()
	same := h.seenSess[si.ID] == si.ProjectID
	h.seenSess[si.ID] = si.ProjectID
	h.mu.Unlock()
	if !same {
		h.touch(si.ProjectID)
	}
}
