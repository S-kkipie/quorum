package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// doneGrace: how long an unread done waits before its attention is published. The open session view
// marks it seen within this window (it debounces seen by 2 s), so a session that ends in front of the
// owner never fires; it also absorbs the mod's background -> idle re-check.
var doneGrace = 5 * time.Second

// checkAttention publishes the needs_you attention on a transition into needs_you and schedules the
// done one when the session is unread done. The announced marks live in the store, so a re-sent state,
// a daemon re-hello or a hub restart never announces the same thing twice.
func (h *Hub) checkAttention(machine, id string) {
	if ok, err := h.st.ClaimNeedsYou(id); err != nil {
		log.Printf("hub: attention of %s: %v", id, err)
	} else if ok {
		h.publishAttention(machine, id, "needs_you")
	}
	h.scheduleDone(machine, id)
}

// scheduleDone arms the grace timer of a done attention, one per end_seq: an end that comes while an
// older end's timer is pending gets its own full grace (the older timer cannot claim it).
func (h *Hub) scheduleDone(machine, id string) {
	end, err := h.st.DoneDue(id)
	if err != nil {
		log.Printf("hub: attention of %s: %v", id, err)
		return
	}
	if end == 0 {
		return
	}
	h.mu.Lock()
	if h.doneTimers[id] == end {
		h.mu.Unlock()
		return
	}
	h.doneTimers[id] = end
	h.mu.Unlock()
	h.afterFunc(doneGrace, func() {
		h.mu.Lock()
		if h.doneTimers[id] == end {
			delete(h.doneTimers, id)
		}
		h.mu.Unlock()
		// still this end, idle, unread and unannounced? (seen, a new turn or a close cancel it)
		if ok, err := h.st.ClaimDone(id, end); err != nil {
			log.Printf("hub: attention of %s: %v", id, err)
		} else if ok {
			h.publishAttention(machine, id, "done")
		}
	})
}

// publishAttention publishes the attention with its notification text and pushes it to the phones.
func (h *Hub) publishAttention(machine, id, kind string) {
	var name string
	if si, err := h.st.Session(id); err == nil {
		name = attentionName(si)
	}
	var ask *proto.Event
	if kind == "needs_you" {
		var err error
		if ask, err = h.st.SessionOpenAsk(id); err != nil {
			log.Printf("hub: attention of %s: %v", id, err)
		}
	}
	title, body := attentionText(name, machine, kind, ask)
	p, _ := json.Marshal(proto.Attention{Session: id, Kind: kind, At: h.now().UnixMilli(), Title: title, Body: body})
	h.publish(proto.Envelope{Type: "attention", Machine: machine, Session: id, Payload: p})
	h.push(id, kind, title, body)
}

func (h *Hub) setPusher(p Pusher) { h.pusher.Store(&p) }

func (h *Hub) getPusher() Pusher {
	if p := h.pusher.Load(); p != nil {
		return *p
	}
	return nil
}

// push sends the attention to every registered phone, asynchronously (the pusher bounds the call
// with its own timeout). The data payload is exactly {session, kind}.
func (h *Hub) push(id, kind, title, body string) {
	p := h.getPusher()
	if p == nil {
		return
	}
	go func() {
		toks, err := h.st.PushTokens()
		if err != nil {
			log.Printf("hub: push: tokens: %v", err)
			return
		}
		if len(toks) == 0 {
			return
		}
		targets := make([]PushTarget, len(toks))
		for i, t := range toks {
			targets[i] = PushTarget{Device: t.Device, Token: t.Token}
		}
		p.Push(context.Background(), targets, title, body, map[string]string{"session": id, "kind": kind})
	}()
}

// publishStored publishes the session as the store has it (with the hub's unread). Read and publish
// hold the session's upsert lock, so of two racing publishes the later read is the later publish.
func (h *Hub) publishStored(id string) {
	defer h.lockUpsert(id)()
	si, err := h.st.Session(id)
	if err != nil {
		return
	}
	p, _ := json.Marshal(si)
	h.publish(proto.Envelope{Type: "session_upsert", Machine: si.Machine, Session: id, Payload: p})
}

// fromDevice: the user event carries device=true (the mod emits it for prompts sent from a device).
func fromDevice(data json.RawMessage) bool {
	var d struct {
		Device bool `json:"device"`
	}
	return json.Unmarshal(data, &d) == nil && d.Device
}

// afterEvent updates the seen/done marks for a stored event: a turn_end may make the session unread
// (the idle state can arrive before it); a prompt typed in the terminal, or a turn the person stopped
// in Claude Code, marks it seen.
func (h *Hub) afterEvent(machine string, ev proto.Event) {
	switch {
	case ev.Kind == proto.KindTurnEnd && stoppedHere(ev.Data):
		// the person pressed Stop in Claude Code: they saw this turn end
		h.seenAt(ev.Session, ev.Seq)
	case ev.Kind == proto.KindTurnEnd:
		if si, err := h.st.Session(ev.Session); err == nil && si.Unread {
			h.publishStored(ev.Session)
		}
		h.scheduleDone(machine, ev.Session)
	case ev.Kind == proto.KindUser && !fromDevice(ev.Data):
		h.seenAt(ev.Session, ev.Seq)
	}
}

// seenAt moves the session's seen mark to seq and publishes it when that cleared an unread.
func (h *Hub) seenAt(id string, seq int64) {
	before, err := h.st.Session(id)
	if err != nil {
		return
	}
	if moved, err := h.st.SetSeen(id, seq); err != nil {
		log.Printf("hub: seen of %s: %v", id, err)
	} else if moved && before.Unread {
		h.publishStored(id)
	}
}

// stoppedHere: the turn_end carries stopped=true (the person pressed Stop in Claude Code).
func stoppedHere(data json.RawMessage) bool {
	var d struct {
		Stopped bool `json:"stopped"`
	}
	return json.Unmarshal(data, &d) == nil && d.Stopped
}

// handleSeen: POST /api/sessions/{id}/seen {seq}. The session was looked at on a device up to seq
// (capped at its latest event, never backwards); the change reaches every device as session_upsert.
func (s *Server) handleSeen(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Seq int64 `json:"seq"`
	}
	if !decode(w, r, &b) {
		return
	}
	id := r.PathValue("id")
	if _, err := s.st.Session(id); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "session not found")
		return
	} else if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	moved, err := s.st.SetSeen(id, b.Seq)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if moved {
		s.hub.publishStored(id)
	}
	w.WriteHeader(http.StatusNoContent)
}
