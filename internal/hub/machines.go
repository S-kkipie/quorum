package hub

import (
	"context"
	"encoding/json"
	"log"
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

// Broadcaster recibe cada envelope que el hub acepta de una máquina (la Task 7
// lo conecta con la transmisión en vivo a las apps).
type Broadcaster interface{ Publish(proto.Envelope) }

type noopBroadcaster struct{}

func (noopBroadcaster) Publish(proto.Envelope) {}

type stopper interface{ Stop() bool }

type machineConn struct {
	name string
	ws   *websocket.Conn
	wmu  sync.Mutex // serializa escrituras
}

// writeTimeoutFor escala el plazo de escritura con el tamaño del mensaje (5 s + 1 s
// por MiB): un lote grande (backfill de hasta 4 MiB) no corta a un cliente lento pero sano.
func writeTimeoutFor(env proto.Envelope) time.Duration {
	return writeTimeout + time.Duration(len(env.Payload))*time.Second/(1<<20)
}

// machinePing: cada cuánto el hub hace ping a cada máquina; dos pings sin pong
// cierran la conexión (y empieza la gracia normal). En nanosegundos; los tests lo acortan.
var machinePing atomic.Int64

func init() { machinePing.Store(int64(30 * time.Second)) }

// defaultAfterFunc crea los temporizadores de baja; los tests lo reemplazan antes de
// NewServer para controlar la gracia de arranque.
var defaultAfterFunc = func(d time.Duration, f func()) stopper { return time.AfterFunc(d, f) }

func (c *machineConn) write(ctx context.Context, env proto.Envelope) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, writeTimeoutFor(env))
	defer cancel()
	return wsjson.Write(ctx, c.ws, env)
}

// Hub lleva las conexiones WS de las máquinas.
type Hub struct {
	st        *store.Store
	afterFunc func(d time.Duration, f func()) stopper // inyectable en tests

	smu    sync.Mutex // serializa los cambios de estado de máquina (expire vs hello)
	mu     sync.Mutex
	conns  map[string]*machineConn
	timers map[string]stopper
	gen    uint64 // identifica cada temporizador de baja
	gens   map[string]uint64
	bc     Broadcaster
	// backfills recuerda cuándo se pidió el historial de cada sesión (dedupe en memoria).
	backfills map[string]time.Time
	// sugerido: última (rama, proyecto) con la que se buscaron tickets por sesión.
	sugg map[string]string
	// touch avisa al resumidor de que cambió un proyecto (nil en tests).
	touch func(projectID string)
	// seenSess: sesión -> proyecto con el que ya se avisó (solo una sesión nueva en el proyecto cuenta).
	seenSess map[string]string

	pmu sync.Mutex // serializa la creación/actualización de borradores
	// pending: lanzamientos desde un ticket esperando que la sesión se registre (por reqId).
	pending map[string]pendingLaunch
	now     func() time.Time
}

// Connected indica si la máquina tiene una conexión viva.
func (h *Hub) Connected(machine string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conns[machine] != nil
}

func newHub(st *store.Store) *Hub {
	return &Hub{
		st:        st,
		conns:     map[string]*machineConn{},
		timers:    map[string]stopper{},
		gens:      map[string]uint64{},
		bc:        noopBroadcaster{},
		backfills: map[string]time.Time{},
		sugg:      map[string]string{},
		seenSess:  map[string]string{},
		pending:   map[string]pendingLaunch{},
		now:       time.Now,
		afterFunc: defaultAfterFunc,
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

// SendToMachine manda env a la máquina; false si no está conectada o falla la escritura.
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

// requestBackfill pide a la máquina el historial de la sesión desde su transcript.
// Como mucho una vez por backfillEvery y sesión; false si no se envió.
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
	for id, t := range h.backfills { // acota el mapa
		if now.Sub(t) >= backfillEvery {
			delete(h.backfills, id)
		}
	}
	// Se marca antes de enviar: dos pedidos simultáneos no mandan dos backfill.
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
	go s.watchToken(ctx, "machine", func() { ws.Close(websocket.StatusPolicyViolation, "token revocado") })
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
		ws.Close(websocket.StatusPolicyViolation, "se esperaba hello")
		return
	}
	var hello proto.MachineHello
	if json.Unmarshal(first.Payload, &hello) != nil {
		ws.Close(websocket.StatusUnsupportedData, "hello inválido")
		return
	}
	c := &machineConn{name: name, ws: ws}
	h.smu.Lock()
	h.attach(c)
	defer h.detach(c)
	ok := h.onHello(name, hello)
	h.smu.Unlock()
	if !ok {
		ws.Close(websocket.StatusInternalError, "error interno")
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

// pingLoop hace ping a la máquina cada machinePing; tras dos pings seguidos sin
// pong cierra la conexión, así "en línea" no depende solo del keepalive de TCP.
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

// attach registra c, reemplazando (y cerrando) cualquier conexión previa y
// cancelando el temporizador de baja pendiente.
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
		// El cierre ordenado espera al par: no bloquear a la conexión nueva.
		go old.ws.Close(websocket.StatusNormalClosure, "reemplazada por otra conexión")
	}
}

// detach quita c (si sigue siendo la vigente) y arranca la gracia de 60 s.
func (h *Hub) detach(c *machineConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[c.name] != c {
		return // reemplazada: la nueva conexión manda
	}
	delete(h.conns, c.name)
	h.startGraceLocked(c.name)
}

// startGraceLocked arranca la gracia de baja de name (con h.mu tomado).
func (h *Hub) startGraceLocked(name string) {
	h.gen++
	gen := h.gen
	h.gens[name] = gen
	h.timers[name] = h.afterFunc(offlineGrace, func() { h.expire(name, gen) })
}

// startupGrace: tras reiniciar el hub nadie está conectado. Cada máquina con sesiones
// abiertas recibe la gracia normal: si vuelve a tiempo, nada se cierra; si no, sus
// sesiones se cierran (y sus asks se podan) como en cualquier caída.
func (h *Hub) startupGrace() {
	ss, err := h.st.ListSessions(false)
	if err != nil {
		log.Printf("hub: sesiones abiertas al arrancar: %v", err)
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
	if err := h.st.UpsertMachine(name, m.OS, m.Env, m.Version, false); err != nil {
		log.Printf("hub: baja de %s: %v", name, err)
		return
	}
	closed, err := h.st.MarkMachineSessionsClosed(name)
	if err != nil {
		log.Printf("hub: cerrar sesiones de %s: %v", name, err)
	}
	h.publishGone(name, closed)
	h.publishStatus(name)
}

// publishGone avisa a las apps de las sesiones que el hub cerró por su cuenta.
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
	hello.Machine = name // manda el nombre autenticado
	keep := make([]string, 0, len(hello.Sessions))
	// Un previousId que también viene vivo en el hello es un renombre viejo (resume
	// del id anterior): aplicarlo fusionaría dos sesiones vivas.
	inHello := make(map[string]bool, len(hello.Sessions))
	for _, si := range hello.Sessions {
		inHello[si.ID] = true
	}
	for i := range hello.Sessions {
		if inHello[hello.Sessions[i].PreviousID] {
			hello.Sessions[i].PreviousID = ""
		}
	}
	if err := h.st.UpsertMachine(name, hello.OS, hello.Env, hello.Version, true); err != nil {
		log.Printf("hub: hello de %s: %v", name, err)
		return false
	}
	for i := range hello.Sessions {
		hello.Sessions[i].Machine = name
		hello.Sessions[i].ProjectID = ""
		if err := h.st.UpsertSession(hello.Sessions[i]); err != nil {
			log.Printf("hub: sesión %s de %s ignorada: %v", hello.Sessions[i].ID, name, err)
			continue
		}
		keep = append(keep, hello.Sessions[i].ID)
		h.attachCheckout(name, &hello.Sessions[i])
	}
	closed, err := h.st.CloseMachineSessionsExcept(name, keep)
	if err != nil {
		log.Printf("hub: cerrar sesiones viejas de %s: %v", name, err)
	}
	h.publishGone(name, closed)
	// Las apps no escuchan hello: cada sesión aceptada (no las ajenas rechazadas)
	// se publica como session_upsert, con lo que guardó el store.
	for _, id := range keep {
		si, err := h.st.Session(id)
		if err != nil {
			continue
		}
		p, _ := json.Marshal(si)
		h.publish(proto.Envelope{Type: "session_upsert", Machine: name, Session: id, Payload: p})
		h.suggestFromBranch(si)
	}
	h.publishStatus(name)
	return true
}

// owns indica si la sesión id puede ser tocada por name: nueva o suya.
func (h *Hub) owns(name, id string) bool {
	owner, exists, err := h.st.SessionOwner(id)
	if err != nil {
		log.Printf("hub: dueño de %s: %v", id, err)
		return false
	}
	if exists && owner != name {
		log.Printf("hub: %s intentó tocar la sesión %s de %s; ignorado", name, id, owner)
		return false
	}
	return true
}

// sessionOwnedBy: la sesión existe y es de name.
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
		return // conexión reemplazada: ya no manda
	}
	env.Machine = name
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
		_, existed, _ := h.st.SessionOwner(si.ID) // solo una sesión nueva puede cumplir un lanzamiento
		repo, branch := si.RepoURL, si.Branch
		// El store decide si el renombre aplica (no lo hace si el id viejo volvió vivo)
		// y valida que prev sea de esta máquina.
		applied, err := h.st.SaveSession(si)
		if err != nil {
			log.Printf("hub: upsert %s: %v", si.ID, err)
			return
		}
		si.PreviousID = applied
		si.RepoURL, si.Branch = repo, branch
		h.attachCheckout(name, &si)
		env.Session = si.ID
		env.Payload, _ = json.Marshal(si)
		// un renombre (/clear: id nuevo con PreviousID aplicado) sigue la sesión vieja, no es un lanzamiento
		if !existed && applied == "" {
			defer h.matchPending(si) // tras publicar y tras suggestFromBranch (LIFO)
		}
		defer h.suggestFromBranch(si) // tras publicar el session_upsert
		if applied != "" {
			h.forgetSuggested(applied)
			// registrado después: corre antes que suggestFromBranch (LIFO), sin duplicar session_ticket
			defer h.publishLinks(name, si.ID) // los vínculos viajaron con el renombre
		}
	case "session_gone":
		if !h.owns(name, env.Session) {
			return
		}
		h.forgetSuggested(env.Session)
		if err := h.st.CloseSession(name, env.Session); err != nil {
			log.Printf("hub: gone %s: %v", env.Session, err)
			return
		}
	case "backfill_result":
		var evs []proto.Event
		if json.Unmarshal(env.Payload, &evs) != nil || len(evs) == 0 {
			return
		}
		if exists, err := h.sessionOwnedBy(name, env.Session); err != nil || !exists {
			return // solo la dueña de una sesión conocida rellena su historial
		}
		inserted, err := h.st.PrependEvents(env.Session, evs)
		if err != nil {
			log.Printf("hub: historial de %s: %v", env.Session, err)
			return
		}
		if !inserted {
			return
		}
		stored, err := h.st.Events(env.Session, 1, len(evs)) // Seq < 1: solo lo rellenado
		if err != nil || len(stored) == 0 {
			return
		}
		for i, j := 0, len(stored)-1; i < j; i, j = i+1, j-1 { // ascendente
			stored[i], stored[j] = stored[j], stored[i]
		}
		// Un solo envelope "events": cientos de "event" sueltos desbordarían el
		// búfer de cada app conectada y el hub la desconectaría.
		p, _ := json.Marshal(stored)
		h.publish(proto.Envelope{Type: "events", Machine: name, Session: env.Session, Payload: p})
		return // el resultado en sí no se difunde
	case "event":
		var ev proto.Event
		if json.Unmarshal(env.Payload, &ev) != nil {
			return
		}
		if !h.owns(name, ev.Session) {
			return
		}
		if ev.Kind == proto.KindTicket {
			h.onTicketCommand(ev) // comando del mod: no se guarda como evento
			return
		}
		seq, err := h.st.AppendEvent(ev)
		if err != nil {
			log.Printf("hub: evento de %s: %v", ev.Session, err)
			return
		}
		ev.Seq = seq
		env.Session = ev.Session
		env.Payload, _ = json.Marshal(ev)
		if ev.Kind == proto.KindTurnEnd {
			defer h.suggestFromTurnEnd(ev)
			defer h.draftFromTurnEnd(ev)
			defer h.touchSession(ev.Session)
		}
	case "launch_result":
		var lr proto.LaunchResult
		if json.Unmarshal(env.Payload, &lr) == nil && !lr.OK {
			h.dropPending(lr.ReqID)
		}
		// se reenvía tal cual a las apps
	default:
		// tipos desconocidos (o que solo emite el hub, como machine_status) no se difunden
		return
	}
	h.publish(env)
}

func (h *Hub) touchProject(id string) {
	if h.touch != nil && id != "" {
		h.touch(id)
	}
}

// touchSession marca el proyecto de la sesión (si lo tiene) para resumirlo.
func (h *Hub) touchSession(id string) {
	if h.touch == nil {
		return
	}
	if si, err := h.st.Session(id); err == nil {
		h.touchProject(si.ProjectID)
	}
}

// touchNewSession avisa al resumidor solo cuando la sesión aparece por primera vez en el proyecto.
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
