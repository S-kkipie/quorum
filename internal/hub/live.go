package hub

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	clientBuffer    = 256
	clientReadLimit = 64 << 10
	// maxPending: what is kept for a client while it receives its snapshot.
	maxPending = 4096
)

type queued struct {
	seq uint64
	env proto.Envelope
}

type liveClient struct {
	ws   *websocket.Conn
	send chan proto.Envelope // nil while waiting
	// waiting: its snapshot is still being written; what is published is kept in pending (with its
	// number) and not in send, so a large snapshot does not make it count as slow.
	waiting bool
	pending []queued
	// frames: the latest picture (term_frame) of each pane, per machine+"\x00"+pane.
	// It never goes through send or pending: a new picture overwrites the old one and never
	// makes the client count as slow. frameSig wakes the writer (capacity 1).
	frames   map[string]proto.Envelope
	frameSig chan struct{}
}

func newLiveClient(ws *websocket.Conn) *liveClient {
	return &liveClient{ws: ws, waiting: true, frameSig: make(chan struct{}, 1)}
}

// frameKey: machine and pane of a term_frame.
func frameKey(env proto.Envelope) string {
	var tf struct {
		Pane string `json:"pane"`
	}
	_ = json.Unmarshal(env.Payload, &tf)
	return env.Machine + "\x00" + tf.Pane
}

// takeFrames hands over and empties the client's latest pending pictures.
func (l *Live) takeFrames(c *liveClient) []proto.Envelope {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(c.frames) == 0 {
		return nil
	}
	out := make([]proto.Envelope, 0, len(c.frames))
	for _, e := range c.frames {
		out = append(out, e)
	}
	c.frames = nil
	return out
}

// Live distributes the published envelopes to the apps connected via /api/live.
type Live struct {
	srv     *Server
	mu      sync.Mutex
	clients map[*liveClient]struct{}
	seq     uint64 // number of each published envelope (under mu)
}

// inSnapshot: types whose current state the snapshot already carries; a copy queued before
// reading it is stale and resending it after it would resurrect state (e.g. a renamed session).
func inSnapshot(t string) bool {
	return t == "session_upsert" || t == "machine_status" || t == "workspace_upsert" || t == "project_upsert"
}

// isAskEnv: an ask event; the snapshot carries every still-open one, so a copy queued before it
// was read would arrive twice.
func isAskEnv(env proto.Envelope) bool {
	if env.Type != "event" {
		return false
	}
	var ev struct {
		Kind proto.EventKind `json:"kind"`
	}
	return json.Unmarshal(env.Payload, &ev) == nil && ev.Kind == proto.KindAsk
}

func newLive(s *Server) *Live {
	return &Live{srv: s, clients: map[*liveClient]struct{}{}}
}

// Publish feeds the ask tracker and broadcasts to all clients without blocking.
func (l *Live) Publish(env proto.Envelope) {
	var si proto.SessionInfo
	if env.Type == "session_upsert" && json.Unmarshal(env.Payload, &si) == nil && si.PreviousID != "" {
		if si.PreviousID == si.ID || l.srv.sessionLive(si.PreviousID) {
			// The previous id lives on its own (e.g. `claude --resume` of the old id
			// after /clear): there is no rename to apply or to report to the apps.
			si.PreviousID = ""
			env.Payload, _ = json.Marshal(si)
		}
	}
	if env.Type == "term_frame" {
		// coalescing: only the latest picture per pane; never more than one is queued.
		key := frameKey(env)
		l.mu.Lock()
		for c := range l.clients {
			if c.frames == nil {
				c.frames = map[string]proto.Envelope{}
			}
			c.frames[key] = env
			if c.frameSig != nil {
				select {
				case c.frameSig <- struct{}{}:
				default:
				}
			}
		}
		l.mu.Unlock()
		return
	}
	l.srv.asks.observe(env, l.srv.st)
	l.mu.Lock()
	l.seq++
	var slow []*liveClient
	for c := range l.clients {
		if c.waiting {
			if len(c.pending) >= maxPending {
				slow = append(slow, c)
			} else {
				c.pending = append(c.pending, queued{l.seq, env})
			}
			continue
		}
		select {
		case c.send <- env:
		default:
			slow = append(slow, c)
		}
	}
	for _, c := range slow {
		delete(l.clients, c)
		if c.ws != nil {
			go c.ws.CloseNow()
		}
	}
	l.mu.Unlock()
}

func (l *Live) snapshot() []proto.Envelope {
	var out []proto.Envelope
	machineOf := map[string]string{}
	if ms, err := l.srv.st.ListMachines(); err == nil {
		for _, m := range ms {
			p, _ := json.Marshal(m)
			out = append(out, proto.Envelope{Type: "machine_status", Machine: m.Name, Payload: p})
		}
	}
	if ss, err := l.srv.st.ListSessions(false); err == nil {
		for _, si := range ss {
			machineOf[si.ID] = si.Machine
			p, _ := json.Marshal(si)
			out = append(out, proto.Envelope{Type: "session_upsert", Machine: si.Machine, Session: si.ID, Payload: p})
		}
	}
	if ws, err := l.srv.st.ListWorkspaces(); err == nil {
		for _, w := range ws {
			p, _ := json.Marshal(w)
			out = append(out, proto.Envelope{Type: "workspace_upsert", Payload: p})
		}
	}
	if ps, err := l.srv.st.ListProjects(); err == nil {
		for _, pr := range ps {
			p, _ := json.Marshal(pr)
			out = append(out, proto.Envelope{Type: "project_upsert", Payload: p})
		}
	}
	if evs, err := l.srv.st.OpenAskEvents(); err == nil {
		for _, e := range evs {
			p, _ := json.Marshal(e)
			out = append(out, proto.Envelope{Type: "event", Session: e.Session, Machine: machineOf[e.Session], Payload: p})
		}
	}
	return out
}

// add registers the client and returns the snapshot it must receive before its queue,
// with the publication number current when it was read. The client is registered first and
// the snapshot is read afterwards, outside the lock (DB queries do not slow
// every Publish); what is published in the meantime stays in pending.
func (l *Live) add(ws *websocket.Conn) (*liveClient, []proto.Envelope, uint64) {
	c := newLiveClient(ws)
	l.mu.Lock()
	l.clients[c] = struct{}{}
	l.mu.Unlock()
	l.mu.Lock()
	snapSeq := l.seq // everything published up to here is already in the store the snapshot reads
	l.mu.Unlock()
	return c, l.snapshot(), snapSeq
}

// ready finishes the client's snapshot: drops from pending the stale copies
// (number <= snapSeq) of what the snapshot already carries, and moves the rest to a channel with
// room for everything. Returns the channel (nil if the client is gone).
func (l *Live) ready(c *liveClient, snapSeq uint64) chan proto.Envelope {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.clients[c]; !ok {
		return nil
	}
	var keep []proto.Envelope
	for _, q := range c.pending {
		if q.seq <= snapSeq && (inSnapshot(q.env.Type) || isAskEnv(q.env)) {
			continue
		}
		keep = append(keep, q.env)
	}
	c.send = make(chan proto.Envelope, clientBuffer+len(keep))
	for _, e := range keep {
		c.send <- e
	}
	c.pending, c.waiting = nil, false
	return c.send
}

func (l *Live) remove(c *liveClient) {
	l.mu.Lock()
	delete(l.clients, c)
	l.mu.Unlock()
}

func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(clientReadLimit)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c, snap, snapSeq := s.live.add(ws)
	defer ws.CloseNow()
	go s.watchToken(ctx, "device", func() { ws.Close(websocket.StatusPolicyViolation, "token revoked"); cancel() })
	defer s.live.remove(c)
	go func() {
		defer cancel()
		write := func(env proto.Envelope) bool {
			wctx, wc := context.WithTimeout(ctx, writeTimeoutFor(env))
			defer wc()
			return wsjson.Write(wctx, ws, env) == nil
		}
		for _, env := range snap {
			if !write(env) {
				return
			}
		}
		send := s.live.ready(c, snapSeq)
		if send == nil {
			return
		}
		for {
			select {
			case env := <-send:
				if !write(env) {
					return
				}
			case <-c.frameSig:
				// first the normal already-queued ones (in order), then the latest pictures
				for drained := false; !drained; {
					select {
					case env := <-send:
						if !write(env) {
							return
						}
					default:
						drained = true
					}
				}
				for _, env := range s.live.takeFrames(c) {
					if !write(env) {
						return
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		var m struct {
			Type string `json:"type"`
		}
		if err := wsjson.Read(ctx, ws, &m); err != nil {
			return
		}
		log.Printf("hub: app message ignored: %q", m.Type)
	}
}
