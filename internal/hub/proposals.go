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
	errNotPending   = "the proposal is no longer pending"
	maxProposalBody = 64 * 1024
)

func (h *Hub) publishProposal(p proto.Proposal) {
	pl, _ := json.Marshal(p)
	h.publish(proto.Envelope{Type: "proposal_upsert", Payload: pl})
}

// draftFromTurnEnd drafts (without writing to the ticket source) a comment proposal
// when a session with a confirmed ticket finishes a turn. Only turn_end events of the
// main thread get here (subagents emit agent_end).
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
	body := "Progress (Quorum, " + si.Machine + "):\n" + ans
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
		log.Printf("hub: proposals of %s: %v", ticketID, err)
		return
	}
	for _, p := range ps {
		if p.Kind != "comment" || p.Status != "pending" {
			continue
		}
		if err := h.st.UpdateProposalBody(p.ID, body); errors.Is(err, store.ErrNotFound) {
			continue // no longer pending (it is being sent)
		} else if err != nil {
			log.Printf("hub: update proposal %s: %v", p.ID, err)
			return
		}
		if up, err := h.st.GetProposal(p.ID); err == nil {
			h.publishProposal(up)
		}
		return
	}
	p, err := h.st.CreateProposal(proto.Proposal{TicketID: ticketID, Kind: "comment", Body: body})
	if err != nil {
		log.Printf("hub: create proposal of %s: %v", ticketID, err)
		return
	}
	h.publishProposal(p)
}

// handleCreateProposal: the owner proposes a manual status change.
func (s *Server) handleCreateProposal(w http.ResponseWriter, r *http.Request) {
	t, err := s.st.Ticket(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "ticket not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
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
		apiErr(w, 400, "invalid proposal kind")
		return
	}
	if !store.ValidStatus(b.Status) {
		apiErr(w, 400, "invalid status")
		return
	}
	p, err := s.st.CreateProposal(proto.Proposal{TicketID: t.ID, Kind: "status", Body: b.Status})
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	s.hub.publishProposal(p)
	writeJSON(w, 201, p)
}

func (s *Server) handleRejectProposal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.claimProposal(w, id, "rejected"); !ok {
		return
	}
	s.respondProposal(w, id)
}

// claimProposal moves pending -> to atomically in the database (persistent); if the
// proposal does not exist or is no longer pending it responds with the error.
func (s *Server) claimProposal(w http.ResponseWriter, id, to string) (proto.Proposal, bool) {
	p, err := s.st.GetProposal(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "proposal not found")
		return p, false
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return p, false
	}
	if err := s.st.TransitionProposal(id, "pending", to); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 409, errNotPending)
		return p, false
	} else if err != nil {
		apiErr(w, 500, "internal error")
		return p, false
	}
	return p, true
}

func (s *Server) respondProposal(w http.ResponseWriter, id string) {
	p, err := s.st.GetProposal(id)
	if err != nil {
		apiErr(w, 500, "internal error")
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
		apiErr(w, 400, "the comment is too long")
		return
	}
	p, err := s.st.GetProposal(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "proposal not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	edited := ""
	if p.Kind == "comment" && strings.TrimSpace(b.Body) != "" {
		edited = b.Body
	}
	// The claim persists "sending" and the edited body in a single atomic statement.
	if err := s.st.ClaimProposalSend(id, edited); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 409, errNotPending)
		return
	} else if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	body := p.Body
	if edited != "" {
		body = edited
	}
	sendErr := s.sendProposal(context.WithoutCancel(r.Context()), p, body)
	status, msg := "approved", ""
	if sendErr != nil {
		status, msg = "failed", sendErr.Error()
	}
	if err := s.st.SetProposalStatus(id, status, msg); err != nil {
		time.Sleep(100 * time.Millisecond)
		if err2 := s.st.SetProposalStatus(id, status, msg); err2 != nil {
			log.Printf("hub: proposal %s: sending ended %q but could not be saved (%v); it stays in sending until the next start", id, status, err2)
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
				log.Printf("hub: sync %s after status change: %v", t.ProjectID, err)
			}
		}()
	}
}

// sendProposal writes to the ticket source; the returned error is already free of the token.
func (s *Server) sendProposal(parent context.Context, p proto.Proposal, body string) (err error) {
	t, err := s.st.Ticket(p.TicketID)
	if err != nil {
		return errors.New("ticket not found")
	}
	proj, err := s.st.GetProject(t.ProjectID)
	if err != nil {
		return errors.New("project not found")
	}
	token, terr := s.st.ConnectorToken(proj.ID)
	if terr != nil && !errors.Is(terr, store.ErrNotFound) {
		return errors.New("internal error")
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
	return fmt.Errorf("invalid proposal kind %q", p.Kind)
}
