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

// Registry guarda las sesiones locales, los suscriptores de comandos y la
// cola de salida hacia el hub.
type Registry struct {
	machine string
	out     chan proto.Envelope

	// emu ordena los cambios de sesión con su envelope: un Upsert y un Gone
	// concurrentes llegan al hub en el mismo orden en que cambiaron el registro.
	emu      sync.Mutex
	mu       sync.Mutex
	sessions map[string]proto.SessionInfo
	subs     map[string]*sub
}

type sub struct{ ch chan proto.Command }

func NewRegistry(machine string) *Registry {
	return &Registry{
		machine:  machine,
		out:      make(chan proto.Envelope, outBuffer),
		sessions: map[string]proto.SessionInfo{},
		subs:     map[string]*sub{},
	}
}

// Out entrega lo que hay que mandar al hub. Es un canal con buffer (1024).
// Si está lleno: los assistant_delta (reconstruibles desde el mensaje final)
// se descartan; el resto espera hasta 1 s (plazo compartido por lote) y, si el
// hub sigue sin consumir, se descarta para no colgar los handlers HTTP.
func (r *Registry) Out() <-chan proto.Envelope { return r.out }

// EmitEnvelope encola un envelope genérico (p. ej. launch_result) hacia el hub.
func (r *Registry) EmitEnvelope(e proto.Envelope) { r.emit(e, false, time.Now().Add(outBlockMax)) }

// EmitDroppable encola un envelope que se puede perder (p. ej. term_frame):
// si la cola está llena se descarta sin esperar.
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
	// Renombre (/clear, /resume): el id anterior desaparece y su attach termina.
	// Si ambos ids ya estaban vivos aquí, el previousId es viejo (resume del id
	// anterior) y se ignora, como hace el hub.
	renamed := ""
	if prev := si.PreviousID; prev != "" && prev != si.ID {
		_, prevLive := r.sessions[prev]
		_, idLive := r.sessions[si.ID]
		switch {
		case prevLive && idLive:
			si.PreviousID = ""
		case prevLive:
			renamed = prev
			delete(r.sessions, prev)
			if s, ok := r.subs[prev]; ok {
				close(s.ch)
				delete(r.subs, prev)
			}
		}
	}
	// Si este id vuelve (p. ej. `claude --resume` del id viejo tras /clear), ninguna
	// otra sesión está ya reemplazándolo: el hello no debe volver a mandar ese renombre.
	for id, other := range r.sessions {
		if id != si.ID && other.PreviousID == si.ID {
			other.PreviousID = ""
			r.sessions[id] = other
		}
	}
	r.sessions[si.ID] = si
	r.mu.Unlock()
	p, _ := json.Marshal(si)
	dl := time.Now().Add(outBlockMax)
	r.emit(proto.Envelope{Type: "session_upsert", Machine: r.machine, Session: si.ID, Payload: p}, false, dl)
	if renamed != "" {
		// Tras el upsert: si el hub aplicó el renombre el id viejo ya no existe y no
		// pasa nada; si no lo aplicó, así no queda una sesión fantasma abierta.
		r.emit(proto.Envelope{Type: "session_gone", Machine: r.machine, Session: renamed}, false, dl)
	}
}

// Emit publica un evento de la sesión id, completando Session y TS.
func (r *Registry) Emit(id string, ev proto.Event) {
	r.emitEvent(id, ev, time.Now().Add(outBlockMax))
}

// EmitBatch publica varios eventos con un único plazo total (outBlockMax).
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
	if s, ok := r.subs[id]; ok {
		close(s.ch)
		delete(r.subs, id)
	}
	r.mu.Unlock()
	r.emit(proto.Envelope{Type: "session_gone", Machine: r.machine, Session: id}, false, time.Now().Add(outBlockMax))
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

// Subscribe registra el único suscriptor de comandos de la sesión; uno nuevo
// cierra y reemplaza al anterior. cancel solo afecta a su propia suscripción.
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

// Send entrega c al suscriptor de la sesión; false si no hay o está saturado.
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
