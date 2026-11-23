package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/connectors"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	draftMaxRunes   = 1500
	approveTimeout  = 30 * time.Second
	errNotPending   = "la propuesta ya no está pendiente"
	maxProposalBody = 64 * 1024
)

func (h *Hub) publishProposal(p proto.Proposal) {
	pl, _ := json.Marshal(p)
	h.publish(proto.Envelope{Type: "proposal_upsert", Payload: pl})
}

// draftFromTurnEnd redacta (sin escribir en la ticketera) una propuesta de comentario
// cuando una sesión con ticket confirmado termina un turno. Solo turn_end del hilo
// principal llega aquí (los subagentes emiten agent_end).
func (h *Hub) draftFromTurnEnd(ev proto.Event) {
	var te proto.TurnEnd
	if json.Unmarshal(ev.Data, &te) != nil || strings.TrimSpace(te.Answer) == "" {
		return
	}
	si, err := h.st.Session(ev.Session)
	if err != nil || si.Role == proto.RoleService {
		return
	}
	ls, err := h.st.SessionTickets(si.ID)
	if err != nil {
		return
	}
	ans := te.Answer
	if r := []rune(ans); len(r) > draftMaxRunes {
		ans = string(r[:draftMaxRunes])
	}
	body := "Avance (Quorum, " + si.Machine + "):\n" + ans
	for _, l := range ls {
		if l.Confirmed {
			h.draftComment(l.TicketID, body)
		}
	}
}

func (h *Hub) draftComment(ticketID, body string) {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	ps, err := h.st.ListProposals(ticketID)
	if err != nil {
		log.Printf("hub: propuestas de %s: %v", ticketID, err)
		return
	}
	for _, p := range ps {
		if p.Kind != "comment" || p.Status != "pendiente" {
			continue
		}
		if err := h.st.UpdateProposalBody(p.ID, body); errors.Is(err, store.ErrNotFound) {
			continue // dejó de estar pendiente (se está enviando)
		} else if err != nil {
			log.Printf("hub: actualizar propuesta %s: %v", p.ID, err)
			return
		}
		if up, err := h.st.GetProposal(p.ID); err == nil {
			h.publishProposal(up)
		}
		return
	}
	p, err := h.st.CreateProposal(proto.Proposal{TicketID: ticketID, Kind: "comment", Body: body})
	if err != nil {
		log.Printf("hub: crear propuesta de %s: %v", ticketID, err)
		return
	}
	h.publishProposal(p)
}

// handleCreateProposal: el dueño propone un cambio de estado manual.
func (s *Server) handleCreateProposal(w http.ResponseWriter, r *http.Request) {
	t, err := s.st.Ticket(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "ticket no encontrado")
		return
	}
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	var b struct {
		Kind   string `json:"kind"`
		Status string `json:"status"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Kind != "status" {
		apiErr(w, 400, "tipo de propuesta inválido")
		return
	}
	if !store.ValidStatus(b.Status) {
		apiErr(w, 400, "estado inválido")
		return
	}
	p, err := s.st.CreateProposal(proto.Proposal{TicketID: t.ID, Kind: "status", Body: b.Status})
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	s.hub.publishProposal(p)
	writeJSON(w, 201, p)
}

func (s *Server) handleRejectProposal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.claimProposal(w, id, "rechazada"); !ok {
		return
	}
	s.respondProposal(w, id)
}

// claimProposal pasa pendiente -> to de forma atómica en la base (persistente); si la
// propuesta no existe o ya no está pendiente responde el error.
func (s *Server) claimProposal(w http.ResponseWriter, id, to string) (proto.Proposal, bool) {
	p, err := s.st.GetProposal(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "propuesta no encontrada")
		return p, false
	}
	if err != nil {
		apiErr(w, 500, "error interno")
		return p, false
	}
	if err := s.st.TransitionProposal(id, "pendiente", to); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 409, errNotPending)
		return p, false
	} else if err != nil {
		apiErr(w, 500, "error interno")
		return p, false
	}
	return p, true
}

func (s *Server) respondProposal(w http.ResponseWriter, id string) {
	p, err := s.st.GetProposal(id)
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	s.hub.publishProposal(p)
	writeJSON(w, 200, p)
}

func (s *Server) handleApproveProposal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b struct {
		Body string `json:"body"`
	}
	if r.ContentLength != 0 && !decode(w, r, &b) {
		return
	}
	if len(b.Body) > maxProposalBody {
		apiErr(w, 400, "el comentario es demasiado largo")
		return
	}
	p, err := s.st.GetProposal(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "propuesta no encontrada")
		return
	}
	if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	edited := ""
	if p.Kind == "comment" && strings.TrimSpace(b.Body) != "" {
		edited = b.Body
	}
	// El claim persiste "enviando" y el cuerpo editado en una sola sentencia atómica.
	if err := s.st.ClaimProposalSend(id, edited); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 409, errNotPending)
		return
	} else if err != nil {
		apiErr(w, 500, "error interno")
		return
	}
	body := p.Body
	if edited != "" {
		body = edited
	}
	sendErr := s.sendProposal(context.WithoutCancel(r.Context()), p, body)
	status, msg := "aprobada", ""
	if sendErr != nil {
		status, msg = "fallida", sendErr.Error()
	}
	if err := s.st.SetProposalStatus(id, status, msg); err != nil {
		time.Sleep(100 * time.Millisecond)
		if err2 := s.st.SetProposalStatus(id, status, msg); err2 != nil {
			log.Printf("hub: propuesta %s: el envío terminó %q pero no se pudo guardar (%v); queda en enviando hasta el próximo arranque", id, status, err2)
			p.Body, p.Status, p.Error = body, status, msg
			s.hub.publishProposal(p)
			writeJSON(w, 200, p)
			s.afterApprove(p, sendErr)
			return
		}
	}
	s.respondProposal(w, id)
	s.afterApprove(p, sendErr)
}

func (s *Server) afterApprove(p proto.Proposal, sendErr error) {
	if sendErr != nil || p.Kind != "status" {
		return
	}
	if t, err := s.st.Ticket(p.TicketID); err == nil {
		go func() {
			if err := s.sync.SyncNow(t.ProjectID); err != nil {
				log.Printf("hub: sincronizar %s tras cambio de estado: %v", t.ProjectID, err)
			}
		}()
	}
}

// sendProposal escribe en la ticketera; el error devuelto ya va sin el token.
func (s *Server) sendProposal(parent context.Context, p proto.Proposal, body string) (err error) {
	t, err := s.st.Ticket(p.TicketID)
	if err != nil {
		return errors.New("ticket no encontrado")
	}
	proj, err := s.st.GetProject(t.ProjectID)
	if err != nil {
		return errors.New("proyecto no encontrado")
	}
	token, terr := s.st.ConnectorToken(proj.ID)
	if terr != nil && !errors.Is(terr, store.ErrNotFound) {
		return errors.New("error interno")
	}
	defer func() {
		if err != nil {
			err = errors.New(connectors.Redact(err.Error(), token))
		}
	}()
	conn, err := connectors.New(proj.Connector, token, connectors.BuildEnv(s.st, proj.WorkspaceID))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, approveTimeout)
	defer cancel()
	switch p.Kind {
	case "comment":
		return conn.Comment(ctx, t.ExternalID, body)
	case "status":
		return conn.SetStatus(ctx, t.ExternalID, body)
	}
	return fmt.Errorf("tipo de propuesta inválido %q", p.Kind)
}
