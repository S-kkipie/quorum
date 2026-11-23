package daemon

import (
	"context"
	"log"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Cerrar una sesión desde la app termina Claude pero deja su pestaña de herdr con
// una shell ociosa. Si Quorum lanzó esa sesión en herdr, el daemon cierra también
// la pestaña cuando la sesión se va (o tras sessionCloseWait si nunca se va), y
// solo si el panel sigue siendo el mismo (mismo terminal_id) y no hay un agente
// trabajando en él. Las sesiones que terminan solas no cierran nada.

// sessionCloseWait es el plazo para que la sesión se vaya tras el pedido de
// cierre; variable para tests.
var sessionCloseWait = 15 * time.Second

// pendingClose es un cierre de pestaña pendiente; sus campos van bajo Host.cmu.
type pendingClose struct {
	pane  string
	tid   string // terminal_id del panel al pedir el cierre
	ready bool   // tid ya leído
	gone  bool   // la sesión ya se fue
	timer *time.Timer
}

// trackSessions engancha el Host a los Gone del registro.
func (h *Host) trackSessions(reg *Registry) {
	if h == nil || reg == nil {
		return
	}
	reg.SetOnGone(h.sessionGone)
}

// closeRequested anota el cierre pendiente de la sesión id si Quorum la lanzó en
// herdr. No bloquea: el terminal_id se lee aparte.
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
		return // no la lanzó Quorum en herdr: su pestaña no es nuestra
	}
	p := &pendingClose{pane: si.HerdrPane}
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
			log.Printf("sesiones: no se cerrará la pestaña de %s (sin terminal_id de %s: %v)", id, p.pane, err)
			return
		}
		p.tid, p.ready = tid, true
		gone := p.gone
		if !gone {
			p.timer = time.AfterFunc(sessionCloseWait, func() { h.closeTab(id, p) })
		}
		h.cmu.Unlock()
		if gone {
			h.closeTab(id, p)
		}
	}()
}

// sessionGone se llama tras cada Gone del registro; no bloquea.
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

// closeTab cierra el panel de p (una sola vez) si sigue siendo el mismo terminal
// y no hay un agente trabajando en él.
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

	ctx, cancel := context.WithTimeout(context.Background(), 2*termCallWait)
	defer cancel()
	panes, err := h.Herdr.ListPanes(ctx, "")
	if err != nil {
		log.Printf("sesiones: no se pudo revisar la pestaña de %s: %v", id, err)
		return
	}
	for _, x := range panes {
		if x.ID != p.pane {
			continue
		}
		switch {
		case x.TerminalID != p.tid:
			return // herdr reusó el id: ya es otro panel
		case x.Agent != "" && (x.AgentStatus == "working" || x.AgentStatus == "blocked"):
			log.Printf("sesiones: la pestaña de %s sigue con un agente activo; no se cierra", id)
			return
		}
		if err := h.Herdr.ClosePane(ctx, p.pane); err != nil {
			log.Printf("sesiones: no se pudo cerrar la pestaña de %s: %v", id, err)
		}
		return
	}
	// el panel ya no existe: nada que cerrar
}
