package daemon

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	outBuffer   = 1024
	outBlockMax = time.Second
)

// Registry holds the local sessions, the command subscribers and the
// outgoing queue to the hub.
type Registry struct {
	machine string
	out     chan proto.Envelope

	// emu orders session changes with their envelope: a concurrent Upsert and Gone
	// reach the hub in the same order in which they changed the registry.
	emu      sync.Mutex
	mu       sync.Mutex
	sessions map[string]proto.SessionInfo
	subs     map[string]*sub
	onGone   func(id string) // under mu; see SetOnGone
	// commands holds each live session's last command list (re-sent after every hello)
	commands map[string]proto.SessionCommands
	// index remembers every session's transcript, also after it ends (see transcriptindex.go)
	index *transcriptIndex
	// misses: session ids last searched for on disk without a hit (see transcriptOf)
	misses map[string]time.Time
}

type sub struct{ ch chan proto.Command }

func NewRegistry(machine string) *Registry {
	return &Registry{
		machine:  machine,
		out:      make(chan proto.Envelope, outBuffer),
		sessions: map[string]proto.SessionInfo{},
		subs:     map[string]*sub{},
		commands: map[string]proto.SessionCommands{},
		index:    loadTranscriptIndex("", maxIndexedTranscripts),
		misses:   map[string]time.Time{},
	}
}

// SetTranscriptIndex replaces the (memory-only) transcript index; call it before use.
func (r *Registry) SetTranscriptIndex(x *transcriptIndex) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.index = x
}

// FlushTranscriptIndex writes the transcript index now if a change is pending (shutdown).
func (r *Registry) FlushTranscriptIndex() {
	r.mu.Lock()
	idx := r.index
	r.mu.Unlock()
	idx.flush()
}

// transcriptOf returns the transcript path and config dir of session id: the live session's,
// or the one remembered for an ended or renamed session.
// A session neither live nor indexed (it ended before the index existed) is looked for as
// <configDir>/projects/*/<id>.jsonl under the live sessions' config dirs and ~/.claude; a hit is
// remembered in the index, a miss for missTTL (no search on every page request).
func (r *Registry) transcriptOf(id string) (path, configDir string, ok bool) {
	r.mu.Lock()
	si, live := r.sessions[id]
	idx := r.index
	var dirs []string
	if !live {
		seen := map[string]bool{}
		for _, s := range r.sessions {
			if s.ConfigDir != "" && !seen[s.ConfigDir] {
				seen[s.ConfigDir] = true
				dirs = append(dirs, s.ConfigDir)
			}
		}
	}
	r.mu.Unlock()
	if live {
		return si.TranscriptPath, si.ConfigDir, true
	}
	if e, found := idx.lookup(id); found {
		return e.Path, e.ConfigDir, true
	}
	if r.missed(id) {
		return "", "", false
	}
	if p, cd, found := findTranscript(id, dirs); found {
		idx.record(id, p, cd)
		return p, cd, true
	}
	r.miss(id)
	return "", "", false
}

// missTTL is how long a session id not found on disk is not searched for again.
const missTTL = 10 * time.Minute

// maxMisses bounds the remembered misses (past it, the expired ones go, then all).
const maxMisses = 1000

// missNow is the clock of the miss cache (tests).
var missNow = time.Now

func (r *Registry) missed(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	at, ok := r.misses[id]
	if ok && missNow().Sub(at) < missTTL {
		return true
	}
	if ok {
		delete(r.misses, id)
	}
	return false
}

func (r *Registry) miss(id string) {
	if !sessionIDRe.MatchString(id) {
		return // never searched: nothing to remember
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := missNow()
	if len(r.misses) >= maxMisses {
		for k, at := range r.misses {
			if now.Sub(at) >= missTTL {
				delete(r.misses, k)
			}
		}
		if len(r.misses) >= maxMisses {
			r.misses = map[string]time.Time{}
		}
	}
	r.misses[id] = now
}

// Out delivers what has to be sent to the hub. It is a buffered channel (1024).
// If full: assistant_delta events (rebuildable from the final message)
// are dropped; the rest wait up to 1 s (deadline shared per batch) and, if the
// hub still does not consume, are dropped so as not to hang the HTTP handlers.
func (r *Registry) Out() <-chan proto.Envelope { return r.out }

// EmitEnvelope queues a generic envelope (e.g. launch_result) toward the hub.
func (r *Registry) EmitEnvelope(e proto.Envelope) { r.emit(e, false, time.Now().Add(outBlockMax)) }

// EmitDroppable queues an envelope that may be lost (e.g. term_frame):
// if the queue is full it is dropped without waiting.
func (r *Registry) EmitDroppable(e proto.Envelope) { r.emit(e, true, time.Time{}) }

func (r *Registry) emit(e proto.Envelope, droppable bool, deadline time.Time) {
	select {
	case r.out <- e:
		return
	default:
	}
	if droppable {
		return
	}
	t := time.NewTimer(time.Until(deadline))
	defer t.Stop()
	select {
	case r.out <- e:
	case <-t.C:
	}
}

func (r *Registry) Upsert(si proto.SessionInfo) {
	si.Machine = r.machine
	r.emu.Lock()
	defer r.emu.Unlock()
	r.mu.Lock()
	// Rename (/clear, /resume): the previous id disappears and its attach ends.
	// If both ids were already alive here, previousId is stale (resume of the
	// previous id) and is ignored, as the hub does.
	renamed := ""
	var prevInfo proto.SessionInfo
	if prev := si.PreviousID; prev != "" && prev != si.ID {
		_, prevLive := r.sessions[prev]
		_, idLive := r.sessions[si.ID]
		switch {
		case prevLive && idLive:
			si.PreviousID = ""
		case prevLive:
			renamed = prev
			prevInfo = r.sessions[prev]
			delete(r.sessions, prev)
			delete(r.commands, prev)
			if s, ok := r.subs[prev]; ok {
				close(s.ch)
				delete(r.subs, prev)
			}
		}
	}
	// If this id comes back (e.g. `claude --resume` of the old id after /clear), no
	// other session is already replacing it: the hello must not send that rename again.
	for id, other := range r.sessions {
		if id != si.ID && other.PreviousID == si.ID {
			other.PreviousID = ""
			r.sessions[id] = other
		}
	}
	r.sessions[si.ID] = si
	idx := r.index
	r.mu.Unlock()
	if renamed != "" {
		idx.record(renamed, prevInfo.TranscriptPath, prevInfo.ConfigDir)
	}
	idx.record(si.ID, si.TranscriptPath, si.ConfigDir)
	p, _ := json.Marshal(si)
	dl := time.Now().Add(outBlockMax)
	r.emit(proto.Envelope{Type: "session_upsert", Machine: r.machine, Session: si.ID, Payload: p}, false, dl)
	if renamed != "" {
		// After the upsert: if the hub applied the rename the old id no longer exists and
		// nothing happens; if it did not, this way no phantom open session is left.
		r.emit(proto.Envelope{Type: "session_gone", Machine: r.machine, Session: renamed}, false, dl)
	}
}

// Emit publishes an event of session id, filling in Session and TS.
func (r *Registry) Emit(id string, ev proto.Event) {
	r.emitEvent(id, ev, time.Now().Add(outBlockMax))
}

// EmitBatch publishes several events with a single total deadline (outBlockMax).
func (r *Registry) EmitBatch(id string, evs []proto.Event) {
	dl := time.Now().Add(outBlockMax)
	for _, ev := range evs {
		r.emitEvent(id, ev, dl)
	}
}

func (r *Registry) emitEvent(id string, ev proto.Event, dl time.Time) {
	ev.Session = id
	if ev.TS == 0 {
		ev.TS = time.Now().UnixMilli()
	}
	p, _ := json.Marshal(ev)
	r.emit(proto.Envelope{Type: "event", Machine: r.machine, Session: id, Payload: p}, ev.Kind == proto.KindAssistantDelta, dl)
}

func (r *Registry) Gone(id string) {
	r.emu.Lock()
	defer r.emu.Unlock()
	r.mu.Lock()
	delete(r.sessions, id)
	delete(r.commands, id)
	if s, ok := r.subs[id]; ok {
		close(s.ch)
		delete(r.subs, id)
	}
	hook := r.onGone
	r.mu.Unlock()
	r.emit(proto.Envelope{Type: "session_gone", Machine: r.machine, Session: id}, false, time.Now().Add(outBlockMax))
	if hook != nil {
		hook(id)
	}
}

// SetCommands stores a live session's command list and queues its session_commands envelope;
// false when the session is not registered here.
func (r *Registry) SetCommands(id string, sc proto.SessionCommands) bool {
	sc.Session = id
	r.emu.Lock()
	defer r.emu.Unlock()
	r.mu.Lock()
	if _, ok := r.sessions[id]; !ok {
		r.mu.Unlock()
		return false
	}
	r.commands[id] = sc
	r.mu.Unlock()
	p, _ := json.Marshal(sc)
	r.emit(proto.Envelope{Type: "session_commands", Machine: r.machine, Session: id, Payload: p}, false, time.Now().Add(outBlockMax))
	return true
}

// AllCommands returns the stored command lists of the live sessions.
func (r *Registry) AllCommands() []proto.SessionCommands {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]proto.SessionCommands, 0, len(r.commands))
	for _, c := range r.commands {
		out = append(out, c)
	}
	return out
}

// SetOnGone registers the (fast, non-blocking) function called after each
// Gone; a new one replaces the previous one.
func (r *Registry) SetOnGone(fn func(id string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onGone = fn
}

func (r *Registry) Snapshot() []proto.SessionInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]proto.SessionInfo, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s)
	}
	return out
}

// Subscribe registers the session's single command subscriber; a new one
// closes and replaces the previous one. cancel only affects its own subscription.
func (r *Registry) Subscribe(id string) (<-chan proto.Command, func()) {
	s := &sub{ch: make(chan proto.Command, 16)}
	r.mu.Lock()
	if old, ok := r.subs[id]; ok {
		close(old.ch)
	}
	r.subs[id] = s
	r.mu.Unlock()
	return s.ch, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.subs[id] == s {
			delete(r.subs, id)
			close(s.ch)
		}
	}
}

// Send delivers c to the session's subscriber; false if there is none or it is saturated.
func (r *Registry) Send(id string, c proto.Command) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subs[id]
	if !ok {
		return false
	}
	select {
	case s.ch <- c:
		return true
	default:
		return false
	}
}
