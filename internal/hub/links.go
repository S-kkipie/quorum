package hub

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

var (
	branchNumRe   = regexp.MustCompile(`(?i)(?:^|[/_-])(?:gh-|#)?(\d+)(?:[/_-]|$)`)
	branchIdentRe = regexp.MustCompile(`(?i)[A-Z]+-\d+`)
	mentionRe     = regexp.MustCompile(`#(\d+)\b`)
)

// ticketRefs extrae de la rama los ids candidatos: números (ExternalID) e identificadores
// tipo ACME-12 (título "[ACME-12] ...").
func ticketRefs(branch string) []string {
	var out []string
	for _, m := range branchNumRe.FindAllStringSubmatch(branch, -1) {
		out = append(out, m[1])
	}
	out = append(out, branchIdentRe.FindAllString(branch, -1)...)
	return out
}

// findTicket resuelve ref (41, #41, GH-41, ACME-12) a un ticket del proyecto.
func findTicket(ts []proto.Ticket, ref string) (proto.Ticket, bool) {
	ref = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ref), "#"))
	if ref == "" {
		return proto.Ticket{}, false
	}
	for _, t := range ts {
		if t.ExternalID == ref {
			return t, true
		}
	}
	prefix := "[" + strings.ToLower(ref) + "]"
	for _, t := range ts {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(t.Title)), prefix) {
			return t, true
		}
	}
	return proto.Ticket{}, false
}

func (h *Hub) publishLink(machine string, l proto.SessionTicket) {
	p, _ := json.Marshal(l)
	h.publish(proto.Envelope{Type: "session_ticket", Machine: machine, Session: l.SessionID, Payload: p})
}

// suggest crea (y publica) vínculos sugeridos de la sesión para las refs que existan en su proyecto.
func (h *Hub) suggest(si proto.SessionInfo, refs []string) {
	if si.Role == proto.RoleService || si.ProjectID == "" || len(refs) == 0 {
		return
	}
	ts, err := h.st.ListTickets(si.ProjectID)
	if err != nil {
		return
	}
	for _, ref := range refs {
		t, ok := findTicket(ts, ref)
		if !ok {
			continue
		}
		created, err := h.st.SuggestSessionTicket(si.ID, t.ID)
		if err != nil {
			log.Printf("hub: sugerir ticket de %s: %v", si.ID, err)
			continue
		}
		if created {
			h.publishLink(si.Machine, proto.SessionTicket{SessionID: si.ID, TicketID: t.ID})
		}
	}
}

// publishLinks reenvía a las apps los vínculos de la sesión (p. ej. tras un renombre).
func (h *Hub) forgetSuggested(id string) {
	h.mu.Lock()
	delete(h.sugg, id)
	delete(h.seenSess, id)
	h.mu.Unlock()
}

func (h *Hub) publishLinks(machine, session string) {
	ls, err := h.st.SessionTickets(session)
	if err != nil {
		log.Printf("hub: vínculos de %s: %v", session, err)
		return
	}
	for _, l := range ls {
		h.publishLink(machine, l)
	}
}

func (h *Hub) suggestFromBranch(si proto.SessionInfo) {
	key := si.Branch + "\x00" + si.ProjectID
	h.mu.Lock()
	same := h.sugg[si.ID] == key
	h.sugg[si.ID] = key
	h.mu.Unlock()
	if same {
		return
	}
	if si.Branch != "" {
		h.suggest(si, ticketRefs(si.Branch))
	}
}

// suggestProject vuelve a buscar el ticket de la rama de cada sesión viva del proyecto:
// tras adoptar checkouts (la sesión ya estaba abierta) y cuando una sincronización cambia
// los tickets (el de la rama puede no existir aún al crear el proyecto).
func (h *Hub) suggestProject(projectID string) {
	if projectID == "" {
		return
	}
	ss, err := h.st.ListSessions(false)
	if err != nil {
		return
	}
	for _, si := range ss {
		if si.ProjectID == projectID && si.Branch != "" {
			h.suggest(si, ticketRefs(si.Branch))
		}
	}
}

func (h *Hub) suggestFromTurnEnd(ev proto.Event) {
	var te proto.TurnEnd
	if json.Unmarshal(ev.Data, &te) != nil || te.Answer == "" {
		return
	}
	var refs []string
	for _, m := range mentionRe.FindAllStringSubmatch(te.Answer, -1) {
		refs = append(refs, m[1])
	}
	if len(refs) == 0 {
		return
	}
	if si, err := h.st.Session(ev.Session); err == nil {
		h.suggest(si, refs)
	}
}

// confirmLink confirma el vínculo y publica los cambios (incluido el confirmado anterior, que pasa a sugerido).
func (h *Hub) confirmLink(si proto.SessionInfo, ticketID string) error {
	demoted, err := h.st.ConfirmSessionTicket(si.ID, ticketID)
	if err != nil {
		return err
	}
	for _, d := range demoted {
		h.publishLink(si.Machine, proto.SessionTicket{SessionID: si.ID, TicketID: d})
	}
	h.publishLink(si.Machine, proto.SessionTicket{SessionID: si.ID, TicketID: ticketID, Confirmed: true})
	h.touchProject(si.ProjectID)
	return nil
}

func (h *Hub) dismissLink(si proto.SessionInfo, ticketID string) error {
	if err := h.st.DismissSessionTicket(si.ID, ticketID); err != nil {
		return err
	}
	h.publishLink(si.Machine, proto.SessionTicket{SessionID: si.ID, TicketID: ticketID, Removed: true})
	h.touchProject(si.ProjectID)
	return nil
}

func (h *Hub) info(si proto.SessionInfo, text string) {
	data, _ := json.Marshal(map[string]string{"text": text})
	ev := proto.Event{Session: si.ID, TS: time.Now().UnixMilli(), Kind: proto.KindInfo, Data: data}
	seq, err := h.st.AppendEvent(ev)
	if err != nil {
		log.Printf("hub: info de %s: %v", si.ID, err)
		return
	}
	ev.Seq = seq
	p, _ := json.Marshal(ev)
	h.publish(proto.Envelope{Type: "event", Machine: si.Machine, Session: si.ID, Payload: p})
}

// onTicketCommand atiende `/quorum ticket <id>` del mod (vacío = desasociar el confirmado).
func (h *Hub) onTicketCommand(ev proto.Event) {
	si, err := h.st.Session(ev.Session)
	if err != nil || si.Role == proto.RoleService {
		return
	}
	var d struct {
		Ticket string `json:"ticket"`
	}
	_ = json.Unmarshal(ev.Data, &d)
	ref := strings.TrimSpace(d.Ticket)
	if ref == "" {
		ls, _ := h.st.SessionTickets(si.ID)
		for _, l := range ls {
			if l.Confirmed {
				if err := h.dismissLink(si, l.TicketID); err != nil {
					log.Printf("hub: desasociar %s: %v", si.ID, err)
				}
			}
		}
		return
	}
	var ts []proto.Ticket
	if si.ProjectID != "" {
		ts, _ = h.st.ListTickets(si.ProjectID)
	}
	t, ok := findTicket(ts, ref)
	if !ok {
		h.info(si, "No encontré el ticket "+ref+" en este proyecto")
		return
	}
	if err := h.confirmLink(si, t.ID); err != nil {
		log.Printf("hub: asociar %s: %v", si.ID, err)
	}
}

func (s *Server) handleLinkTicket(w http.ResponseWriter, r *http.Request) {
	si, err := s.st.Session(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "sesión no encontrada")
		return
	}
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	if si.Role == proto.RoleService {
		apiErr(w, 409, "sesión de servicio")
		return
	}
	var b struct {
		TicketID string `json:"ticketId"`
	}
	if !decode(w, r, &b) {
		return
	}
	var ts []proto.Ticket
	if si.ProjectID != "" {
		ts, _ = s.st.ListTickets(si.ProjectID)
	}
	ok := false
	for _, t := range ts {
		if t.ID == b.TicketID {
			ok = true
		}
	}
	if !ok {
		apiErr(w, 404, "el ticket no es de este proyecto")
		return
	}
	if err := s.hub.confirmLink(si, b.TicketID); err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	writeJSON(w, 200, proto.SessionTicket{SessionID: si.ID, TicketID: b.TicketID, Confirmed: true})
}

func (s *Server) handleUnlinkTicket(w http.ResponseWriter, r *http.Request) {
	si, err := s.st.Session(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "sesión no encontrada")
		return
	}
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	tid := r.URL.Query().Get("ticketId")
	if tid == "" {
		apiErr(w, 400, "falta ticketId")
		return
	}
	known := false
	ls, err := s.st.SessionTickets(si.ID)
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	for _, l := range ls {
		known = known || l.TicketID == tid
	}
	if !known && si.ProjectID != "" {
		ts, err := s.st.ListTickets(si.ProjectID)
		if err != nil {
			apiErr(w, 500, "error interno")
			return
		}
		for _, t := range ts {
			known = known || t.ID == tid
		}
	}
	if !known {
		apiErr(w, 404, "el ticket no es de este proyecto")
		return
	}
	if err := s.hub.dismissLink(si, tid); err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
