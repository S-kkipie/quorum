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
	// maxPending: lo que se guarda para un cliente mientras recibe su snapshot.
	maxPending = 4096
)

type queued struct {
	seq uint64
	env proto.Envelope
}

type liveClient struct {
	ws   *websocket.Conn
	send chan proto.Envelope // vale nil mientras waiting
	// waiting: aún se escribe su snapshot; lo publicado se guarda en pending (con su
	// número) y no en send, así un snapshot grande no lo deja por lento.
	waiting bool
	pending []queued
	// frames: la última foto (term_frame) de cada panel, por máquina+"\x00"+panel.
	// Nunca pasa por send ni pending: una foto nueva pisa la anterior y jamás deja
	// al cliente por lento. frameSig avisa al escritor (capacidad 1).
	frames   map[string]proto.Envelope
	frameSig chan struct{}
}

func newLiveClient(ws *websocket.Conn) *liveClient {
	return &liveClient{ws: ws, waiting: true, frameSig: make(chan struct{}, 1)}
}

// frameKey: máquina y panel de un term_frame.
func frameKey(env proto.Envelope) string {
	var tf struct {
		Pane string `json:"pane"`
	}
	_ = json.Unmarshal(env.Payload, &tf)
	return env.Machine + "\x00" + tf.Pane
}

// takeFrames entrega y vacía las últimas fotos pendientes del cliente.
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

// Live reparte los envelopes publicados a las apps conectadas por /api/live.
type Live struct {
	srv     *Server
	mu      sync.Mutex
	clients map[*liveClient]struct{}
	seq     uint64 // número de cada envelope publicado (bajo mu)
}

// inSnapshot: tipos cuyo estado vigente ya trae el snapshot; una copia encolada antes
// de leerlo es vieja y reenviarla tras él resucitaría estado (p. ej. una sesión renombrada).
func inSnapshot(t string) bool {
	return t == "session_upsert" || t == "machine_status" || t == "workspace_upsert" || t == "project_upsert"
}

func newLive(s *Server) *Live {
	return &Live{srv: s, clients: map[*liveClient]struct{}{}}
}

// Publish alimenta el rastreador de asks y difunde a todos los clientes sin bloquear.
func (l *Live) Publish(env proto.Envelope) {
	var si proto.SessionInfo
	if env.Type == "session_upsert" && json.Unmarshal(env.Payload, &si) == nil && si.PreviousID != "" {
		if si.PreviousID == si.ID || l.srv.sessionLive(si.PreviousID) {
			// El id anterior vive por su cuenta (p. ej. `claude --resume` del id viejo
			// tras /clear): no hay renombre que aplicar ni que contar a las apps.
			si.PreviousID = ""
			env.Payload, _ = json.Marshal(si)
		}
	}
	if env.Type == "term_frame" {
		// coalescing: solo la última foto por panel; nunca se encola más de una.
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
	if ms, err := l.srv.st.ListMachines(); err == nil {
		for _, m := range ms {
			p, _ := json.Marshal(m)
			out = append(out, proto.Envelope{Type: "machine_status", Machine: m.Name, Payload: p})
		}
	}
	if ss, err := l.srv.st.ListSessions(false); err == nil {
		for _, si := range ss {
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
	return out
}

// add registra el cliente y devuelve el snapshot que debe recibir antes que su cola,
// con el número de publicación vigente al leerlo. El cliente se registra primero y
// el snapshot se lee después, fuera del candado (las consultas a la BD no frenan
// cada Publish); lo publicado entretanto queda en pending.
func (l *Live) add(ws *websocket.Conn) (*liveClient, []proto.Envelope, uint64) {
	c := newLiveClient(ws)
	l.mu.Lock()
	l.clients[c] = struct{}{}
	l.mu.Unlock()
	l.mu.Lock()
	snapSeq := l.seq // todo lo publicado hasta aquí ya está en el store que lee el snapshot
	l.mu.Unlock()
	return c, l.snapshot(), snapSeq
}

// ready termina el snapshot del cliente: descarta de pending las copias viejas
// (número <= snapSeq) de lo que el snapshot ya trae, y pasa el resto a un canal con
// sitio para todo. Devuelve el canal (nil si el cliente ya no está).
func (l *Live) ready(c *liveClient, snapSeq uint64) chan proto.Envelope {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.clients[c]; !ok {
		return nil
	}
	var keep []proto.Envelope
	for _, q := range c.pending {
		if q.seq <= snapSeq && inSnapshot(q.env.Type) {
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
	go s.watchToken(ctx, "device", func() { ws.Close(websocket.StatusPolicyViolation, "token revocado"); cancel() })
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
				// primero lo normal ya encolado (en orden), luego las últimas fotos
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
		log.Printf("hub: mensaje de app ignorado: %q", m.Type)
	}
}
