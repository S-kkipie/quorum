package hub

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/hub/web"
	"github.com/S-kkipie/quorum/internal/proto"
)

// askTracker recuerda los askId abiertos (eventos ask) y los cierra al ver ask_resolved.
// Gana el primer decide: cerrar es atómico bajo el candado.
type askTracker struct {
	mu       sync.Mutex
	open     map[string]string // askId -> sesión
	resolved map[string]bool   // resueltos recientes (acotado), para que reopen no los reviva
	order    []string
	claimed  map[string]bool // reclamados por un decide en curso (reseed no los reabre)
	// known: sesiones vivas cuyo estado de asks ya se sembró; un session_upsert de una
	// de ellas sin previousId no vuelve a consultar el store.
	known map[string]bool
}

const maxResolved = 1024

func newAskTracker() *askTracker {
	return &askTracker{open: map[string]string{}, resolved: map[string]bool{}, claimed: map[string]bool{}, known: map[string]bool{}}
}

func (t *askTracker) markResolved(id string) { // con t.mu tomado
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

// resolve da por resuelto askId (p. ej. si no se pudo guardar su ask_resolved).
//
// Caso aceptado: resolved vive solo en memoria. Si el hub se reinicia después de un
// decide cuyo ask_resolved no se pudo guardar, OpenAsks/reseed reabren ese ask desde
// el store y la app vuelve a mostrar la tarjeta. Contestarla otra vez manda un decide
// que el mod ignora (ese askId ya no espera), así que no hay efecto doble; la tarjeta
// se va con el próximo ask_resolved o al cerrarse la sesión.
func (t *askTracker) resolve(askID string) {
	t.mu.Lock()
	t.markResolved(askID)
	t.mu.Unlock()
}

// prune descarta los asks cuya sesión ya no existe o está cerrada (una sola consulta).
func (t *askTracker) prune(st *store.Store) {
	live, err := st.LiveSessionIDs()
	if err != nil {
		log.Printf("hub: podar asks: %v", err)
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

// reseed rehace desde el store los asks abiertos de la sesión id (y descarta los de
// prev, su id anterior: sus eventos ya se movieron a id). Así una sesión que vuelve
// tras reiniciar el daemon o la máquina recupera sus tarjetas pendientes.
func (t *askTracker) hasAsksOf(session string) bool { // con t.mu tomado
	for _, s := range t.open {
		if s == session {
			return true
		}
	}
	return false
}

func (t *askTracker) reseed(st *store.Store, id, prev string) {
	t.mu.Lock()
	// Sesión viva ya sembrada y un prev que no aporta nada (renombre ya aplicado:
	// prev no está vivo ni tiene asks a su nombre; p. ej. el previous_id guardado que
	// repite cada hello): nada nuevo que leer.
	skip := t.known[id] && (prev == "" || !t.known[prev] && !t.hasAsksOf(prev))
	t.mu.Unlock()
	if skip {
		return
	}
	open, err := st.SessionOpenAsks(id)
	if err != nil {
		log.Printf("hub: asks abiertos de %s: %v", id, err)
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

// claim cierra askId si está abierto en esa sesión; solo un llamador lo consigue.
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

// sessionLive: la sesión id existe y no está cerrada.
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
	dev("GET /api/sessions/{id}/events", s.handleEvents)
	dev("POST /api/sessions/{id}/prompt", s.handlePrompt)
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
	dev("POST /api/tickets/{id}/proposals", s.handleCreateProposal)
	dev("POST /api/proposals/{id}/approve", s.handleApproveProposal)
	dev("POST /api/proposals/{id}/reject", s.handleRejectProposal)
	dev("POST /api/projects/{id}/sync", s.handleSyncProject)
	s.mux.Handle("/", web.Handler())
	dev("GET /api/live", s.handleLive)
}

func (s *Server) handleMachines(w http.ResponseWriter, r *http.Request) {
	ms, err := s.st.ListMachines()
	if err != nil {
		apiErr(w, 500, "error interno")
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
		apiErr(w, 500, "error interno")
		return
	}
	if list == nil {
		list = []proto.SessionInfo{}
	}
	writeJSON(w, 200, list)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
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
		apiErr(w, 500, "error interno")
		return
	}
	if len(evs) == 0 && before == 0 {
		// Sin historial guardado: pide a la máquina que lo rearme desde el transcript.
		// No se espera; el resultado llega por el feed en vivo.
		if si, err := s.st.Session(r.PathValue("id")); err == nil {
			s.hub.requestBackfill(si.Machine, si.ID)
		}
	}
	if evs == nil {
		evs = []proto.Event{}
	}
	writeJSON(w, 200, evs)
}

// target resuelve la sesión de la ruta y comprueba que se le pueda mandar órdenes.
func (s *Server) target(w http.ResponseWriter, r *http.Request) (proto.SessionInfo, bool) {
	si, err := s.st.Session(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "sesión no encontrada")
		return si, false
	}
	if err != nil {
		apiErr(w, 500, "error interno")
		return si, false
	}
	if si.State == proto.StateClosed {
		apiErr(w, 409, "la sesión está cerrada")
		return si, false
	}
	if !s.hub.Connected(si.Machine) {
		apiErr(w, 409, "la máquina está fuera de línea")
		return si, false
	}
	return si, true
}

func (s *Server) dispatch(w http.ResponseWriter, si proto.SessionInfo, cmd proto.Command) bool {
	if !s.sendCommand(si, cmd) {
		apiErr(w, 409, "la máquina está fuera de línea")
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
		apiErr(w, 400, "el mensaje está vacío")
		return
	}
	switch b.Mode {
	case "":
		b.Mode = "queue"
	case "now", "queue", "interrupt":
	default:
		apiErr(w, 400, "modo inválido")
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
		apiErr(w, 400, "falta askId")
		return
	}
	if b.Decision != "allow" && b.Decision != "deny" {
		apiErr(w, 400, "decisión inválida")
		return
	}
	si, ok := s.target(w, r)
	if !ok {
		return
	}
	if !s.asks.claim(b.AskID, si.ID) {
		apiErr(w, 409, "ya se respondió")
		return
	}
	cmd := proto.Command{Type: "decide", AskID: b.AskID, Decision: b.Decision, Answers: b.Answers, Reason: b.Reason}
	if !s.sendCommand(si, cmd) {
		s.asks.reopen(b.AskID, si.ID)
		apiErr(w, 409, "la máquina está fuera de línea")
		return
	}
	data, _ := json.Marshal(proto.AskResolved{AskID: b.AskID, By: "device:" + AuthName(r.Context())})
	ev := proto.Event{Session: si.ID, TS: time.Now().UnixMilli(), Kind: proto.KindAskResolved, Data: data}
	seq, err := s.st.AppendEvent(ev)
	if err != nil {
		// Sin seq no se publica (las apps ordenan por seq); el ask queda resuelto
		// aquí para que no siga reclamado ni un reseed lo reabra.
		log.Printf("hub: guardar ask_resolved de %s: %v", si.ID, err)
		s.asks.resolve(b.AskID)
		w.WriteHeader(http.StatusAccepted)
		return
	}
	ev.Seq = seq
	p, _ := json.Marshal(ev)
	s.hub.publish(proto.Envelope{Type: "event", Machine: si.Machine, Session: si.ID, Payload: p})
	w.WriteHeader(http.StatusAccepted)
}

// handleLaunch pide a una máquina abrir una sesión nueva; el resultado llega por /api/live.
func (s *Server) handleLaunch(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Machine        string `json:"machine"`
		Dir            string `json:"dir"`
		Continue       bool   `json:"continue"`
		PermissionMode string `json:"permissionMode"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Dir == "" {
		apiErr(w, 400, "falta la carpeta")
		return
	}
	if b.Machine == "" || !s.hub.Connected(b.Machine) {
		apiErr(w, 409, "la máquina está fuera de línea")
		return
	}
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	req := proto.LaunchRequest{ReqID: hex.EncodeToString(id), Dir: b.Dir, Continue: b.Continue, PermissionMode: b.PermissionMode}
	p, _ := json.Marshal(req)
	if !s.hub.SendToMachine(b.Machine, proto.Envelope{Type: "launch", Machine: b.Machine, Payload: p}) {
		apiErr(w, 409, "la máquina está fuera de línea")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"reqId": req.ReqID})
}
