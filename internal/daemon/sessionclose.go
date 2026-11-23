package daemon

import (
	"context"
	"log"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Cerrar una sesión desde la app termina Claude pero deja su pestaña de herdr con
// una shell ociosa. Si Quorum lanzó esa sesión en herdr y la sesión se va tras el
// pedido de cierre, el daemon cierra también la pestaña, solo si el panel sigue
// siendo el mismo (mismo terminal_id) y no hay un agente activo en él. Si la
// sesión no se va en sessionCloseWait, el pedido se olvida sin cerrar nada (el
// dueño podría estar usando esa shell). Las sesiones que terminan solas no
// cierran nada.

// Plazos; variables para tests (se leen al pedir el cierre, antes de arrancar
// goroutines).
var (
	sessionCloseWait   = 15 * time.Second // para que la sesión se vaya tras el pedido
	sessionClosePoll   = time.Second      // sondeo de pane.list tras el Gone
	sessionCloseWindow = 10 * time.Second // cuánto se sondea antes de rendirse
)

// pendingClose es un cierre de pestaña pendiente; sus campos mutables van bajo Host.cmu.
type pendingClose struct {
	pane         string
	wait         time.Duration
	poll, window time.Duration

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
			log.Printf("sesiones: no se cerrará la pestaña de %s (sin terminal_id de %s: %v)", id, p.pane, err)
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

// dropClose olvida el pedido si la sesión no se fue a tiempo.
func (h *Host) dropClose(id string, p *pendingClose) {
	h.cmu.Lock()
	defer h.cmu.Unlock()
	if h.closing[id] == p && !p.gone {
		delete(h.closing, id)
		log.Printf("sesiones: %s no terminó tras el pedido de cierre; su pestaña se queda", id)
	}
}

// closeTab (una sola vez por pedido, tras el Gone) sondea pane.list durante la
// ventana y cierra el panel en cuanto sigue siendo el mismo terminal y no tiene
// un agente activo. Si el panel desaparece o cambió de terminal, no hace nada.
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
				log.Printf("sesiones: no se pudo cerrar la pestaña de %s: %v", id, err)
			}
			cancel()
			return
		case tabDrop:
			return
		}
		if time.Now().Add(p.poll).After(deadline) {
			log.Printf("sesiones: la pestaña de %s sigue ocupada; no se cierra", id)
			return
		}
		time.Sleep(p.poll)
	}
}

type tabVerdict int

const (
	tabWait  tabVerdict = iota // agente activo, estado dudoso o pane.list falló
	tabClose                   // mismo terminal y sin agente activo
	tabDrop                    // el panel ya no existe o es otro terminal
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
			return tabDrop // herdr reusó el id: ya es otro panel
		case x.Agent == "", x.AgentStatus == "idle", x.AgentStatus == "done":
			return tabClose
		default:
			return tabWait // working, blocked, unknown...
		}
	}
	return tabDrop
}
