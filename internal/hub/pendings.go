package hub

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	maxPendingText   = 300
	maxPendingDetail = 4000
	maxPendingNote   = 2000
	maxClientKey     = 64
)

func (s *Server) pendingRoutes(dev func(string, http.HandlerFunc)) {
	dev("GET /api/projects/{id}/pendings", s.handleListPendings)
	dev("POST /api/projects/{id}/pendings", s.handleAddPending)
	dev("PATCH /api/pendings/{id}", s.handlePatchPending)
	dev("DELETE /api/pendings/{id}", s.handleDeletePending)
	dev("POST /api/meetings/{id}/pendings", s.handleMeetingPending)
}

const (
	noProjectMsg      = "This session has no Quorum project; link the folder to a project in Quorum first"
	pendingCapMsg     = "This project already has 50 open pending items from agents; ask the owner to close some first"
	machineListMax    = 50
	machineDetailRune = 200
)

// machinePendingRoutes are the agents' tools' path: machine-token auth, scoped to the session's project.
func (s *Server) machinePendingRoutes() {
	m := func(pattern string, h http.HandlerFunc) { s.mux.Handle(pattern, s.requireMachine(h)) }
	m("GET /api/machine/sessions/{sid}/pendings", s.handleMachineListPendings)
	m("POST /api/machine/sessions/{sid}/pendings", s.handleMachineAddPending)
	m("POST /api/machine/sessions/{sid}/pendings/{id}/done", s.handleMachineDonePending)
}

// machineProject resolves the session's project on every call (the folder can be linked after the
// session started). It writes the error and returns ok=false when the session or project is missing.
func (s *Server) machineProject(w http.ResponseWriter, r *http.Request) (sid string, p proto.Project, ok bool) {
	sid = r.PathValue("sid")
	owned, err := s.hub.sessionOwnedBy(AuthName(r.Context()), sid)
	if err != nil {
		s.fail(w, err, "unknown session")
		return
	}
	if !owned {
		apiErr(w, 404, "unknown session")
		return
	}
	si, err := s.st.Session(sid)
	if err != nil {
		s.fail(w, err, "unknown session")
		return
	}
	if si.ProjectID == "" {
		apiErr(w, 409, noProjectMsg)
		return
	}
	p, err = s.st.GetProject(si.ProjectID)
	if err != nil {
		s.fail(w, err, noProjectMsg)
		return
	}
	return sid, p, true
}

func (s *Server) handleMachineListPendings(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.machineProject(w, r)
	if !ok {
		return
	}
	list, err := s.st.Pendings(p.ID, r.URL.Query().Get("status") == "all")
	if err != nil {
		s.fail(w, err, "unknown session")
		return
	}
	if len(list) > machineListMax {
		list = list[:machineListMax]
	}
	items := make([]proto.Pending, 0, len(list))
	for _, it := range list {
		if rs := []rune(it.Detail); len(rs) > machineDetailRune {
			it.Detail = string(rs[:machineDetailRune]) + "…"
		}
		items = append(items, it)
	}
	writeJSON(w, 200, map[string]any{"projectId": p.ID, "projectName": p.Name, "items": items})
}

// handleMachineAddPending answers 200 for both a new item and a deduplicated one; created tells them apart.
func (s *Server) handleMachineAddPending(w http.ResponseWriter, r *http.Request) {
	sid, p, ok := s.machineProject(w, r)
	if !ok {
		return
	}
	var b struct {
		Text      string `json:"text"`
		Detail    string `json:"detail"`
		ClientKey string `json:"clientKey"`
	}
	if !decode(w, r, &b) {
		return
	}
	text := strings.TrimSpace(b.Text)
	if !validText(w, text) || !checkLen(w, b.Detail, maxPendingDetail, "detail is longer than 4000 characters") ||
		!checkLen(w, b.ClientKey, maxClientKey, "clientKey is longer than 64 characters") {
		return
	}
	it, created, err := s.st.AddPending(proto.Pending{ProjectID: p.ID, Text: text, Detail: b.Detail, Source: "agent", SourceRef: sid}, b.ClientKey, s.hub.now().UnixMilli())
	if errors.Is(err, store.ErrPendingCap) {
		apiErr(w, 429, pendingCapMsg)
		return
	}
	if err != nil {
		s.fail(w, err, "unknown session")
		return
	}
	if created {
		s.hub.briefingChanged(p.ID)
	}
	writeJSON(w, 200, map[string]any{"item": it, "created": created})
}

func (s *Server) handleMachineDonePending(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.machineProject(w, r)
	if !ok {
		return
	}
	var b struct {
		Note string `json:"note"`
	}
	// the body is optional: an empty one means no note
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&b); err != nil && !errors.Is(err, io.EOF) {
		apiErr(w, 400, "invalid request")
		return
	}
	if !checkLen(w, b.Note, maxPendingNote, "note is longer than 2000 characters") {
		return
	}
	id := r.PathValue("id")
	cur, err := s.st.Pending(id)
	if err != nil || cur.ProjectID != p.ID {
		s.pendingErr(w, orNotFound(err), "unknown pending item")
		return
	}
	done := "done"
	patch := store.PendingPatch{Status: &done}
	if b.Note != "" {
		patch.Note = &b.Note
	}
	it, err := s.st.UpdatePending(id, patch, s.hub.now().UnixMilli())
	if err != nil {
		s.pendingErr(w, err, "unknown pending item")
		return
	}
	s.hub.briefingChanged(p.ID)
	writeJSON(w, 200, map[string]any{"item": it})
}

func orNotFound(err error) error {
	if err == nil {
		return store.ErrNotFound
	}
	return err
}

// pendingErr maps store errors: a missing row is 404.
func (s *Server) pendingErr(w http.ResponseWriter, err error, notFound string) {
	if errors.Is(err, sql.ErrNoRows) {
		err = store.ErrNotFound
	}
	s.fail(w, err, notFound)
}

// checkLen reports a 400 when v is over max code points.
func checkLen(w http.ResponseWriter, v string, max int, msg string) bool {
	if utf8.RuneCountInString(v) > max {
		apiErr(w, 400, msg)
		return false
	}
	return true
}

func validText(w http.ResponseWriter, text string) bool {
	if text == "" {
		apiErr(w, 400, "text is required")
		return false
	}
	return checkLen(w, text, maxPendingText, "text is longer than 300 characters")
}

func validStatus(st string) bool { return st == "open" || st == "done" || st == "dropped" }

func (s *Server) handleListPendings(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.st.GetProject(id); err != nil {
		s.fail(w, err, "project not found")
		return
	}
	list, err := s.st.Pendings(id, r.URL.Query().Get("status") == "all")
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) handleAddPending(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Text      string `json:"text"`
		Detail    string `json:"detail"`
		ClientKey string `json:"clientKey"`
	}
	if !decode(w, r, &b) {
		return
	}
	text := strings.TrimSpace(b.Text)
	if !validText(w, text) || !checkLen(w, b.Detail, maxPendingDetail, "detail is longer than 4000 characters") ||
		!checkLen(w, b.ClientKey, maxClientKey, "clientKey is longer than 64 characters") {
		return
	}
	id := r.PathValue("id")
	if _, err := s.st.GetProject(id); err != nil {
		s.fail(w, err, "project not found")
		return
	}
	p, created, err := s.st.AddPending(proto.Pending{ProjectID: id, Text: text, Detail: b.Detail, Source: "manual"}, b.ClientKey, s.hub.now().UnixMilli())
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	if !created {
		writeJSON(w, 200, p)
		return
	}
	s.hub.briefingChanged(id)
	writeJSON(w, 201, p)
}

func (s *Server) handlePatchPending(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Text   *string `json:"text"`
		Detail *string `json:"detail"`
		Note   *string `json:"note"`
		Status *string `json:"status"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Text != nil {
		t := strings.TrimSpace(*b.Text)
		b.Text = &t
		if !validText(w, t) {
			return
		}
	}
	if b.Detail != nil && !checkLen(w, *b.Detail, maxPendingDetail, "detail is longer than 4000 characters") {
		return
	}
	if b.Note != nil && !checkLen(w, *b.Note, maxPendingNote, "note is longer than 2000 characters") {
		return
	}
	if b.Status != nil && !validStatus(*b.Status) {
		apiErr(w, 400, "status must be open, done or dropped")
		return
	}
	p, err := s.st.UpdatePending(r.PathValue("id"), store.PendingPatch{Text: b.Text, Detail: b.Detail, Note: b.Note, Status: b.Status}, s.hub.now().UnixMilli())
	if err != nil {
		s.pendingErr(w, err, "pending not found")
		return
	}
	s.hub.briefingChanged(p.ProjectID)
	writeJSON(w, 200, p)
}

func (s *Server) handleDeletePending(w http.ResponseWriter, r *http.Request) {
	pid, err := s.st.DeletePending(r.PathValue("id"))
	if err != nil {
		s.pendingErr(w, err, "pending not found")
		return
	}
	s.hub.briefingChanged(pid)
	w.WriteHeader(204)
}

func (s *Server) handleMeetingPending(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &b) {
		return
	}
	text := strings.TrimSpace(b.Text)
	if !validText(w, text) {
		return
	}
	mid := r.PathValue("id")
	m, err := s.st.Meeting(mid)
	if err != nil {
		s.pendingErr(w, err, "meeting not found")
		return
	}
	if m.ProjectID == "" {
		apiErr(w, 400, "assign the meeting to a project first")
		return
	}
	exists := func(id string) { writeJSON(w, 409, map[string]string{"error": "already added", "id": id}) }
	if id, ok, err := s.st.MeetingPendingExists(mid, text); err != nil {
		s.fail(w, err, "meeting not found")
		return
	} else if ok {
		exists(id)
		return
	}
	p, created, err := s.st.AddPending(proto.Pending{ProjectID: m.ProjectID, Text: text, Source: "meeting", SourceRef: mid}, "", s.hub.now().UnixMilli())
	if err != nil {
		s.fail(w, err, "meeting not found")
		return
	}
	if !created {
		exists(p.ID)
		return
	}
	s.hub.briefingChanged(m.ProjectID)
	writeJSON(w, 201, p)
}
