package hub

import (
	"encoding/json"
	"errors"
	"log"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/S-kkipie/quorum/internal/hub/connectors"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

func (s *Server) projectRoutes(dev func(string, http.HandlerFunc)) {
	dev("GET /api/workspaces", s.handleListWorkspaces)
	dev("PATCH /api/workspaces/{id}", s.handlePatchWorkspace)
	dev("DELETE /api/workspaces/{id}", s.handleDeleteWorkspace)
	dev("GET /api/projects", s.handleListProjects)
	dev("GET /api/projects/{id}", s.handleGetProject)
	dev("PATCH /api/projects/{id}", s.handlePatchProject)
	dev("DELETE /api/projects/{id}", s.handleDeleteProject)
	dev("PUT /api/projects/{id}/token", s.handlePutToken)
	dev("GET /api/projects/{id}/tickets", s.handleProjectTickets)
	dev("GET /api/projects/{id}/checkouts", s.handleProjectCheckouts)
	dev("GET /api/tickets/{id}", s.handleGetTicket)
	dev("GET /api/proposals", s.handleListProposals)
}

func (h *Hub) publishWorkspace(w proto.Workspace) {
	pl, _ := json.Marshal(w)
	h.publish(proto.Envelope{Type: "workspace_upsert", Payload: pl})
}

func (h *Hub) publishProject(p proto.Project) {
	pl, _ := json.Marshal(p)
	h.publish(proto.Envelope{Type: "project_upsert", Payload: pl})
}

func (h *Hub) publishGoneID(typ, id string) {
	pl, _ := json.Marshal(map[string]string{"id": id})
	h.publish(proto.Envelope{Type: typ, Payload: pl})
}

func (s *Server) fail(w http.ResponseWriter, err error, notFound string) {
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, notFound)
		return
	}
	log.Printf("hub: api: %v", err)
	apiErr(w, 500, "internal error")
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	ws, err := s.st.ListWorkspaces()
	if err != nil {
		s.fail(w, err, "")
		return
	}
	writeJSON(w, 200, ws)
}

func (s *Server) handlePatchWorkspace(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name         *string `json:"name"`
		Color        *string `json:"color"`
		WhoasProfile *string `json:"whoasProfile"`
	}
	if !decode(w, r, &b) {
		return
	}
	var cur *proto.Workspace
	list, err := s.st.ListWorkspaces()
	if err != nil {
		s.fail(w, err, "")
		return
	}
	for i := range list {
		if list[i].ID == r.PathValue("id") {
			cur = &list[i]
		}
	}
	if cur == nil {
		apiErr(w, 404, "workspace not found")
		return
	}
	if b.Name != nil {
		n := strings.TrimSpace(*b.Name)
		if n == "" {
			apiErr(w, 400, "missing workspace name")
			return
		}
		cur.Name = n
	}
	if b.Color != nil {
		cur.Color = *b.Color
	}
	if b.WhoasProfile != nil {
		cur.WhoasProfile = *b.WhoasProfile
	}
	if err := s.st.UpdateWorkspace(*cur); err != nil {
		s.fail(w, err, "workspace not found")
		return
	}
	s.hub.publishWorkspace(*cur)
	writeJSON(w, 200, cur)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.st.DeleteWorkspace(id)
	if errors.Is(err, store.ErrNotEmpty) {
		apiErr(w, 409, "the workspace has projects")
		return
	}
	if err != nil {
		s.fail(w, err, "workspace not found")
		return
	}
	s.hub.publishGoneID("workspace_gone", id)
	w.WriteHeader(204)
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	ps, err := s.st.ListProjects()
	if err != nil {
		s.fail(w, err, "")
		return
	}
	if ws := r.URL.Query().Get("workspace"); ws != "" {
		ps = slices.DeleteFunc(ps, func(p proto.Project) bool { return p.WorkspaceID != ws })
	}
	writeJSON(w, 200, ps)
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	p, err := s.st.GetProject(r.PathValue("id"))
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	writeJSON(w, 200, p)
}

// defaultIntervalMin: sync interval if a connector is enabled without specifying one.
const defaultIntervalMin = 5

func validConnector(c proto.ConnectorConfig) string {
	if c.Kind != "none" && !slices.Contains(connectors.Kinds(), c.Kind) {
		return "connector kind not supported"
	}
	if c.Kind != "none" && (c.IntervalMin < 1 || c.IntervalMin > 60) {
		return "the interval must be between 1 and 60 minutes"
	}
	return ""
}

func (s *Server) handlePatchProject(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name        *string `json:"name"`
		WorkspaceID *string `json:"workspaceId"`
		RepoURL     *string `json:"repoURL"`
		Connector   *struct {
			Kind        *string            `json:"kind"`
			Settings    *map[string]string `json:"settings"`
			IntervalMin *int               `json:"intervalMin"`
		} `json:"connector"`
	}
	if !decode(w, r, &b) {
		return
	}
	cur, err := s.st.GetProject(r.PathValue("id"))
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	oldRepo := store.NormalizeRepoURL(cur.RepoURL)
	oldConn := cur.Connector
	oldConn.Settings = maps.Clone(cur.Connector.Settings)
	if b.Name != nil {
		n := strings.TrimSpace(*b.Name)
		if n == "" {
			apiErr(w, 400, "missing project name")
			return
		}
		cur.Name = n
	}
	if b.WorkspaceID != nil {
		if *b.WorkspaceID == "" {
			apiErr(w, 400, "missing workspace")
			return
		}
		cur.WorkspaceID = *b.WorkspaceID
	}
	if b.RepoURL != nil {
		cur.RepoURL = store.StripRepoUserinfo(*b.RepoURL)
	}
	if c := b.Connector; c != nil {
		if c.Kind != nil {
			cur.Connector.Kind = *c.Kind
		}
		if c.Settings != nil {
			cur.Connector.Settings = *c.Settings
			if cur.Connector.Settings == nil {
				cur.Connector.Settings = map[string]string{}
			}
		}
		if c.IntervalMin != nil {
			cur.Connector.IntervalMin = *c.IntervalMin
		}
		if cur.Connector.Kind == "" {
			cur.Connector.Kind = "none"
		}
		if c.IntervalMin == nil && cur.Connector.Kind != "none" && cur.Connector.IntervalMin == 0 {
			cur.Connector.IntervalMin = defaultIntervalMin
		}
		if msg := validConnector(cur.Connector); msg != "" {
			apiErr(w, 400, msg)
			return
		}
	}
	reset := connectorIdentityChanged(oldConn, cur.Connector)
	var rs store.ConnectorReset
	if reset {
		// a sync in progress against the old source must not store anything
		err = s.sync.Invalidate(cur.ID, func() (e error) {
			rs, e = s.st.UpdateProjectResetConnector(cur)
			return e
		})
	} else {
		err = s.st.UpdateProject(cur)
	}
	if err != nil {
		msg := "workspace not found"
		if _, e := s.st.GetProject(cur.ID); errors.Is(e, store.ErrNotFound) {
			msg = "project not found"
		}
		s.fail(w, err, msg)
		return
	}
	if store.NormalizeRepoURL(cur.RepoURL) != oldRepo {
		s.hub.relinkCheckouts(cur)
	}
	out, err := s.st.GetProject(cur.ID)
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	s.hub.publishProject(out)
	if reset {
		s.hub.afterConnectorReset(out, rs)
		if out.Connector.Kind != "none" {
			go func() {
				if err := s.sync.SyncNow(out.ID); err != nil {
					log.Printf("hub: sync %s after changing the connector: %v", out.ID, err)
				}
			}()
		}
	}
	writeJSON(w, 200, out)
}

// identityKeys are the settings that identify the ticket source: if they change,
// the stored ExternalIDs no longer point to the same thing.
var identityKeys = []string{"repo", "baseURL", "companyId", "projectId", "command"}

func connectorIdentityChanged(a, b proto.ConnectorConfig) bool {
	ka, kb := a.Kind, b.Kind
	if ka == "" {
		ka = "none"
	}
	if kb == "" {
		kb = "none"
	}
	if ka != kb {
		return true
	}
	for _, k := range identityKeys {
		if strings.TrimSpace(a.Settings[k]) != strings.TrimSpace(b.Settings[k]) {
			return true
		}
	}
	return false
}

// afterConnectorReset notifies the apps of what the connector change deleted.
func (h *Hub) afterConnectorReset(p proto.Project, rs store.ConnectorReset) {
	pl, _ := json.Marshal(struct {
		ProjectID string         `json:"projectId"`
		Tickets   []proto.Ticket `json:"tickets"`
	}{p.ID, []proto.Ticket{}})
	h.publish(proto.Envelope{Type: "tickets", Payload: pl})
	for _, l := range rs.Links {
		machine := ""
		if si, err := h.st.Session(l.SessionID); err == nil {
			machine = si.Machine
		}
		h.publishLink(machine, l)
	}
	for _, id := range rs.Proposals {
		if pr, err := h.st.GetProposal(id); err == nil {
			h.publishProposal(pr)
		}
	}
	if h.touch != nil {
		h.touch(p.ID)
	}
}

// relinkCheckouts unlinks the project's checkouts whose remote no longer matches
// and adopts those that now do.
func (h *Hub) relinkCheckouts(p proto.Project) {
	norm := store.NormalizeRepoURL(p.RepoURL)
	if cos, err := h.st.ListCheckouts(p.ID); err == nil {
		hit := map[suggestionRoot]bool{}
		for _, c := range cos {
			if store.NormalizeRepoURL(c.RepoURL) != norm {
				if h.st.SetCheckoutProject(c.ID, "") == nil {
					hit[suggestionRoot{c.Machine, c.Root}] = true
				}
			}
		}
		h.republishSessions(hit)
	}
	if norm != "" {
		h.adoptCheckouts(p)
	}
}

func (h *Hub) republishSessions(hit map[suggestionRoot]bool) {
	if len(hit) == 0 {
		return
	}
	ss, err := h.st.ListSessions(false)
	if err != nil {
		return
	}
	for _, si := range ss {
		if hit[suggestionRoot{si.Machine, si.Root}] {
			pl, _ := json.Marshal(si)
			h.publish(proto.Envelope{Type: "session_upsert", Machine: si.Machine, Session: si.ID, Payload: pl})
		}
	}
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	hit := map[suggestionRoot]bool{}
	if cos, err := s.st.ListCheckouts(id); err == nil {
		for _, c := range cos {
			hit[suggestionRoot{c.Machine, c.Root}] = true
		}
	}
	if err := s.st.DeleteProject(id); err != nil {
		s.fail(w, err, "project not found")
		return
	}
	s.sum.Forget(id)
	s.hub.publishGoneID("project_gone", id)
	s.hub.republishSessions(hit)
	w.WriteHeader(204)
}

func (s *Server) handlePutToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &b) {
		return
	}
	id := r.PathValue("id")
	if err := s.st.SetConnectorToken(id, b.Token); err != nil {
		s.fail(w, err, "project not found")
		return
	}
	if p, err := s.st.GetProject(id); err == nil {
		s.hub.publishProject(p) // hasToken changed
	}
	w.WriteHeader(204)
}

// ticketView: the ticket with its associated sessions (and, in the detail, its proposals).
type ticketView struct {
	proto.Ticket
	Sessions  []ticketSession   `json:"sessions"`
	Proposals *[]proto.Proposal `json:"proposals,omitempty"`
}

type ticketSession struct {
	SessionID string `json:"sessionId"`
	Confirmed bool   `json:"confirmed"`
}

func toSessions(ls []proto.SessionTicket) []ticketSession {
	out := make([]ticketSession, 0, len(ls))
	for _, l := range ls {
		out = append(out, ticketSession{l.SessionID, l.Confirmed})
	}
	return out
}

func (s *Server) handleProjectTickets(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.st.GetProject(id); err != nil {
		s.fail(w, err, "project not found")
		return
	}
	ts, err := s.st.ListTickets(id)
	if err != nil {
		s.fail(w, err, "")
		return
	}
	links, err := s.st.TicketLinks(id)
	if err != nil {
		s.fail(w, err, "")
		return
	}
	out := make([]ticketView, 0, len(ts))
	for _, t := range ts {
		out = append(out, ticketView{Ticket: t, Sessions: toSessions(links[t.ID])})
	}
	writeJSON(w, 200, out)
}

// handleProjectCheckouts: the project's stored checkouts (machine, root, remote, branch).
func (s *Server) handleProjectCheckouts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.st.GetProject(id); err != nil {
		s.fail(w, err, "project not found")
		return
	}
	cos, err := s.st.ListCheckouts(id)
	if err != nil {
		s.fail(w, err, "")
		return
	}
	if cos == nil {
		cos = []proto.Checkout{}
	}
	writeJSON(w, 200, cos)
}

func (s *Server) handleGetTicket(w http.ResponseWriter, r *http.Request) {
	t, err := s.st.Ticket(r.PathValue("id"))
	if err != nil {
		s.fail(w, err, "ticket not found")
		return
	}
	ls, err := s.st.TicketSessions(t.ID)
	if err != nil {
		s.fail(w, err, "")
		return
	}
	ps, err := s.st.ListProposals(t.ID)
	if err != nil {
		s.fail(w, err, "")
		return
	}
	writeJSON(w, 200, ticketView{Ticket: t, Sessions: toSessions(ls), Proposals: &ps})
}

const (
	defaultProposalLimit = 200
	maxProposalLimit     = 1000
)

// handleListProposals: ?ticket=, ?status= and ?limit= (200 by default), newest first.
func (s *Server) handleListProposals(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.ProposalFilter{TicketID: q.Get("ticket"), Status: q.Get("status"), Limit: defaultProposalLimit}
	if f.Status != "" && !store.ValidProposalStatus(f.Status) {
		apiErr(w, 400, "invalid proposal status")
		return
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			apiErr(w, 400, "invalid limit")
			return
		}
		f.Limit = min(n, maxProposalLimit)
	}
	ps, err := s.st.QueryProposals(f)
	if err != nil {
		s.fail(w, err, "")
		return
	}
	writeJSON(w, 200, ps)
}
