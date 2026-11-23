package hub

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// attachCheckout registers the session's checkout (machine, root) according to the repo
// the mod reports, associates it with the project whose RepoURL matches and fills in what
// the hub computes (ProjectID is always the hub's, never the mod's). Without a repo it does not touch the
// existing checkout; it only reflects what is already there.
func (h *Hub) attachCheckout(machine string, si *proto.SessionInfo) {
	reported := store.StripRepoUserinfo(si.RepoURL)
	si.ProjectID = ""
	if si.Root == "" {
		return
	}
	if store.NormalizeRepoURL(reported) != "" {
		c := proto.Checkout{Machine: machine, Root: si.Root, RepoURL: reported, Branch: si.Branch}
		norm := store.NormalizeRepoURL(reported)
		if ps, err := h.st.ListProjects(); err == nil {
			for _, p := range ps {
				if p.RepoURL != "" && store.NormalizeRepoURL(p.RepoURL) == norm {
					c.ProjectID = p.ID
					break
				}
			}
		}
		prev, prevErr := h.st.CheckoutForRoot(machine, si.Root)
		stored, err := h.st.UpsertCheckout(c)
		if err != nil {
			log.Printf("hub: checkout de %s:%s: %v", machine, si.Root, err)
		} else if c.ProjectID != "" && stored.ProjectID == c.ProjectID {
			if prevErr != nil || prev.ProjectID != c.ProjectID {
				h.touchProject(c.ProjectID) // new association
			}
		} else if c.ProjectID == "" && stored.ProjectID != "" {
			// The remote changed: if the old project no longer matches, it is unlinked.
			if p, err := h.st.GetProject(stored.ProjectID); err == nil && p.RepoURL != "" && store.NormalizeRepoURL(p.RepoURL) != norm {
				_ = h.st.SetCheckoutProject(stored.ID, "")
			}
		}
	}
	si.RepoURL, si.Branch = "", ""
	if c, err := h.st.CheckoutForRoot(machine, si.Root); err == nil {
		si.RepoURL, si.Branch, si.ProjectID = c.RepoURL, c.Branch, c.ProjectID
		h.touchNewSession(*si)
	}
}

type suggestionRoot struct {
	Machine string `json:"machine"`
	Root    string `json:"root"`
}

type suggestion struct {
	RepoURL  string           `json:"repoURL"`
	Roots    []suggestionRoot `json:"roots"`
	Sessions int              `json:"sessions"`
}

func (s *Server) handleSuggestions(w http.ResponseWriter, r *http.Request) {
	cos, err := s.st.AllCheckouts()
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	live, err := s.st.ListSessions(false)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	count := map[suggestionRoot]int{}
	for _, si := range live {
		count[suggestionRoot{si.Machine, si.Root}]++
	}
	by := map[string]*suggestion{}
	for _, c := range cos {
		if c.ProjectID != "" || c.RepoURL == "" {
			continue
		}
		k := store.NormalizeRepoURL(c.RepoURL)
		sg := by[k]
		if sg == nil {
			sg = &suggestion{RepoURL: c.RepoURL, Roots: []suggestionRoot{}}
			by[k] = sg
		}
		r := suggestionRoot{c.Machine, c.Root}
		sg.Roots = append(sg.Roots, r)
		sg.Sessions += count[r]
	}
	out := make([]suggestion, 0, len(by))
	for _, sg := range by {
		out = append(out, *sg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RepoURL < out[j].RepoURL })
	writeJSON(w, 200, out)
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var b struct{ Name string }
	if !decode(w, r, &b) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" {
		apiErr(w, 400, "missing workspace name")
		return
	}
	ws, err := s.st.CreateWorkspace(proto.Workspace{Name: b.Name})
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	s.hub.publishWorkspace(ws)
	writeJSON(w, 201, ws)
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var b struct {
		WorkspaceID string `json:"workspaceId"`
		Name        string `json:"name"`
		RepoURL     string `json:"repoURL"` // also accepts repoUrl (case-insensitive decoding)
		Connector   *struct {
			Kind        string            `json:"kind"`
			Settings    map[string]string `json:"settings"`
			IntervalMin *int              `json:"intervalMin"`
		} `json:"connector"`
	}
	if !decode(w, r, &b) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.WorkspaceID == "" {
		apiErr(w, 400, "missing workspace")
		return
	}
	if b.Name == "" {
		apiErr(w, 400, "missing project name")
		return
	}
	np := proto.Project{WorkspaceID: b.WorkspaceID, Name: b.Name, RepoURL: store.StripRepoUserinfo(b.RepoURL)}
	if c := b.Connector; c != nil {
		np.Connector = proto.ConnectorConfig{Kind: c.Kind, Settings: c.Settings}
		if np.Connector.Kind == "" {
			np.Connector.Kind = "none"
		}
		if c.IntervalMin != nil {
			np.Connector.IntervalMin = *c.IntervalMin
		} else if np.Connector.Kind != "none" {
			np.Connector.IntervalMin = defaultIntervalMin
		}
		if msg := validConnector(np.Connector); msg != "" {
			apiErr(w, 400, msg)
			return
		}
	}
	p, err := s.st.CreateProject(np)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "workspace not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if store.NormalizeRepoURL(p.RepoURL) != "" {
		s.hub.adoptCheckouts(p)
	}
	if out, err := s.st.GetProject(p.ID); err == nil {
		p = out
	}
	s.hub.publishProject(p)
	writeJSON(w, 201, p)
}

// adoptCheckouts associates with the newly created project the checkouts with the same remote
// and notifies the apps of the affected sessions (now with projectId).
func (h *Hub) adoptCheckouts(p proto.Project) {
	cos, err := h.st.AllCheckouts()
	if err != nil {
		log.Printf("hub: checkouts de %s: %v", p.ID, err)
		return
	}
	norm := store.NormalizeRepoURL(p.RepoURL)
	if norm == "" {
		return
	}
	hit := map[suggestionRoot]bool{}
	for _, c := range cos {
		if c.ProjectID == "" && store.NormalizeRepoURL(c.RepoURL) == norm {
			if err := h.st.SetCheckoutProject(c.ID, p.ID); err != nil {
				log.Printf("hub: link checkout %s: %v", c.ID, err)
				continue
			}
			hit[suggestionRoot{c.Machine, c.Root}] = true
			h.touchProject(p.ID)
		}
	}
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
	h.suggestProject(p.ID)
}

// handleSyncProject starts an immediate sync (202); the result arrives through /api/live.
func (s *Server) handleSyncProject(w http.ResponseWriter, r *http.Request) {
	p, err := s.st.GetProject(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "project not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if p.Connector.Kind == "" || p.Connector.Kind == "none" {
		apiErr(w, 400, "the project has no connector")
		return
	}
	go func() {
		if err := s.sync.SyncNow(p.ID); err != nil {
			log.Printf("hub: sync %s: %v", p.ID, err)
		}
	}()
	writeJSON(w, 202, map[string]bool{"ok": true})
}
