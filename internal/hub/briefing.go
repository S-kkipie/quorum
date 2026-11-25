package hub

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// The project briefing ("catch me up", Plan 13): GET /api/projects/{id}/briefing assembles it from stored data;
// project_briefing_changed {projectId} tells open apps to refetch, coalesced per project over 2 s.
const (
	briefingCoalesce  = 2 * time.Second
	maxNewSince       = 20
	maxMeetingItems   = 20
	maxClosedSessions = 10
	meetingWindowDays = 14
	maxDetail         = 140
	maxPinnedText     = 500
)

func (s *Server) briefingRoutes(dev func(string, http.HandlerFunc)) {
	dev("GET /api/projects/{id}/briefing", s.handleBriefing)
	dev("POST /api/projects/{id}/visit", s.handleVisit)
	dev("POST /api/projects/{id}/pinned", s.handleAddPinned)
	dev("DELETE /api/projects/{id}/pinned/{noteId}", s.handleDeletePinned)
}

// ---- Events ----

// briefingChanged schedules one project_briefing_changed for the project: every call within the next 2 s
// joins the same envelope.
func (h *Hub) briefingChanged(projectID string) {
	if projectID == "" {
		return
	}
	h.bmu.Lock()
	if h.bpending == nil {
		h.bpending = map[string]bool{}
	}
	if h.bpending[projectID] {
		h.bmu.Unlock()
		return
	}
	h.bpending[projectID] = true
	h.bmu.Unlock()
	h.afterFunc(briefingCoalesce, func() {
		h.bmu.Lock()
		delete(h.bpending, projectID)
		h.bmu.Unlock()
		pl, _ := json.Marshal(map[string]string{"projectId": projectID})
		h.publish(proto.Envelope{Type: "project_briefing_changed", Payload: pl})
	})
}

// sessionEnded: a session ended a turn or closed. Its project's briefing changed and its "where you left off"
// is due for regeneration (service sessions never count).
func (h *Hub) sessionEnded(si proto.SessionInfo) {
	if si.ProjectID == "" || si.Role == proto.RoleService {
		return
	}
	h.briefingChanged(si.ProjectID)
	if h.leftOff != nil {
		h.leftOff(si.ProjectID)
	}
}

// sessionEndedID is sessionEnded for a stored session id.
func (h *Hub) sessionEndedID(id string) {
	if si, err := h.st.Session(id); err == nil {
		h.sessionEnded(si)
	}
}

// onSynced runs after each successful sync: only a sync that changed something (change-log rows or meeting
// notes) is a briefing change, and only a change touching the owner's tickets regenerates "where you left off"
// (a sync that only moved updated_at writes no change rows, so it does neither).
func (s *Server) onSynced(projectID string, changes []proto.TicketChange, notesChanged bool) {
	if len(changes) == 0 && !notesChanged {
		return
	}
	s.hub.briefingChanged(projectID)
	if len(changes) > 0 && s.touchesOwner(projectID, changes) {
		s.sum.TouchLeftOff(projectID)
	}
}

// touchesOwner: a change row is about one of the owner's tickets (assigned now, or assigned to or away from them).
func (s *Server) touchesOwner(projectID string, changes []proto.TicketChange) bool {
	p, err := s.st.GetProject(projectID)
	if err != nil {
		return false
	}
	person := store.ProjectPerson(p)
	if person == "" {
		return false
	}
	ts, err := s.st.ListTickets(projectID)
	if err != nil {
		return false
	}
	assignee := make(map[string]string, len(ts))
	for _, t := range ts {
		assignee[t.ExternalID] = t.Assignee
	}
	for _, c := range changes {
		if store.IsPerson(assignee[c.ExternalID], person) ||
			(c.Kind == "assigned" && (store.IsPerson(c.From, person) || store.IsPerson(c.To, person))) {
			return true
		}
	}
	return false
}

// ---- Handlers ----

func (s *Server) handleBriefing(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	b, err := s.briefing(id, s.hub.now())
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	// "where you left off" is generated only when looked at: the current text goes out now, a new one
	// arrives through project_briefing_changed.
	s.sum.RequestLeftOff(id)
	writeJSON(w, 200, b)
}

func (s *Server) handleVisit(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	seen, prev, rolled, err := s.st.Visit(id, s.hub.now().UnixMilli())
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	if rolled {
		s.hub.briefingChanged(id)
	}
	writeJSON(w, 200, map[string]int64{"seenAt": seen, "prevSeenAt": prev})
}

func (s *Server) handleAddPinned(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &b) {
		return
	}
	text := strings.TrimSpace(b.Text)
	if text == "" {
		apiErr(w, 400, "the note is empty")
		return
	}
	if utf8.RuneCountInString(text) > maxPinnedText {
		apiErr(w, 400, "the note is over 500 characters")
		return
	}
	id := r.PathValue("id")
	n, err := s.st.AddPinned(id, text, s.hub.now().UnixMilli())
	if err != nil {
		s.fail(w, err, "project not found")
		return
	}
	s.hub.briefingChanged(id)
	writeJSON(w, 201, n)
}

func (s *Server) handleDeletePinned(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.st.DeletePinned(id, r.PathValue("noteId")); err != nil {
		s.fail(w, err, "note not found")
		return
	}
	s.hub.briefingChanged(id)
	w.WriteHeader(204)
}

// ---- Assembly ----

// briefing builds the project's briefing at now (ErrNotFound for an unknown project).
func (s *Server) briefing(projectID string, now time.Time) (proto.Briefing, error) {
	b := proto.Briefing{NewSince: []proto.BriefingItem{}, MyTickets: []proto.Ticket{}, Sessions: []proto.SessionInfo{},
		Meetings: proto.BriefingMeetings{Decisions: []proto.MeetingItem{}, OpenPoints: []proto.MeetingItem{}, Actions: []proto.MeetingItem{}}}
	p, err := s.st.GetProject(projectID)
	if err != nil {
		return b, err
	}
	if b.SeenAt, b.PrevSeenAt, err = s.st.Visits(projectID); err != nil {
		return b, err
	}
	person := store.ProjectPerson(p)
	text, n, at, err := s.st.WhereLeftOff(projectID)
	if err != nil {
		return b, err
	}
	if text != "" {
		b.WhereLeftOff = &proto.WhereLeftOff{Text: text, At: at, Sessions: n}
	}
	if b.Pinned, err = s.st.Pinned(projectID); err != nil {
		return b, err
	}
	tickets, err := s.st.ListTickets(projectID)
	if err != nil {
		return b, err
	}
	b.MyTickets = myTickets(tickets, person)

	from := now.AddDate(0, 0, -meetingWindowDays).Format(time.DateOnly)
	notes, err := s.st.MeetingNotes(projectID, from)
	if err != nil {
		return b, err
	}
	b.Meetings = meetings(notes, from, person)

	sessions, ends, err := s.projectSessions(projectID)
	if err != nil {
		return b, err
	}
	b.Sessions = listedSessions(sessions)

	if b.PrevSeenAt > 0 {
		changes, err := s.st.TicketChanges(projectID, b.PrevSeenAt)
		if err != nil {
			return b, err
		}
		newNotes, err := s.st.NotesSeenSince(projectID, b.PrevSeenAt)
		if err != nil {
			return b, err
		}
		var items []proto.BriefingItem
		items = append(items, sessionItems(sessions, ends, b.PrevSeenAt)...)
		items = append(items, ticketItems(changes, tickets, person)...)
		items = append(items, noteItems(newNotes)...)
		sort.SliceStable(items, func(i, j int) bool { return items[i].At > items[j].At })
		if len(items) > maxNewSince {
			items = items[:maxNewSince]
		}
		b.NewSince = append(b.NewSince, items...)
	}
	return b, nil
}

// projectSessions returns the project's work sessions (live and closed; membership by SessionInfo.ProjectID),
// most recently updated first, with when each last finished.
func (s *Server) projectSessions(projectID string) ([]proto.SessionInfo, map[string]store.SessionEnd, error) {
	all, err := s.st.ListSessions(true)
	if err != nil {
		return nil, nil, err
	}
	var out []proto.SessionInfo
	ids := []string{}
	for _, si := range all {
		if si.ProjectID == projectID && si.Role != proto.RoleService {
			out = append(out, si)
			ids = append(ids, si.ID)
		}
	}
	ends, err := s.st.SessionEnds(ids)
	return out, ends, err
}

// listedSessions: every live session, then the 10 most recent closed ones.
func listedSessions(ss []proto.SessionInfo) []proto.SessionInfo {
	out := []proto.SessionInfo{}
	var closed []proto.SessionInfo
	for _, si := range ss {
		if si.State == proto.StateClosed {
			closed = append(closed, si)
		} else {
			out = append(out, si)
		}
	}
	if len(closed) > maxClosedSessions {
		closed = closed[:maxClosedSessions]
	}
	return append(out, closed...)
}

// myTickets: the person's open tickets by planned end, the ones without one last.
func myTickets(ts []proto.Ticket, person string) []proto.Ticket {
	out := []proto.Ticket{}
	for _, t := range ts {
		if store.OpenTicket(t) && store.IsPerson(t.Assignee, person) {
			t.Comments = nil // the briefing does not carry comment threads
			out = append(out, t)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].PlannedEnd, out[j].PlannedEnd
		switch {
		case a == b:
			return out[i].ExternalID < out[j].ExternalID
		case a == 0:
			return false
		case b == 0:
			return true
		}
		return a < b
	})
	return out
}

// sessionItems: the sessions whose last turn end or close is after since and that are not working now.
func sessionItems(ss []proto.SessionInfo, ends map[string]store.SessionEnd, since int64) []proto.BriefingItem {
	var out []proto.BriefingItem
	for _, si := range ss {
		if si.State == proto.StateWorking || si.State == proto.StateNeedsYou {
			continue // still going: it only shows in Sessions
		}
		e := ends[si.ID]
		at := max(e.EndAt, e.ClosedAt)
		if at <= since {
			continue
		}
		detail := excerpt(e.Answer, maxDetail)
		if detail == "" {
			detail = "Turn finished"
			if si.State == proto.StateClosed {
				detail = "Session closed"
			}
		}
		out = append(out, proto.BriefingItem{Kind: "session", Title: sessionTitle(si), Detail: detail, At: at, Ref: si.ID})
	}
	return out
}

// sessionTitle mirrors the app's: the recap, the name, or the folder.
func sessionTitle(si proto.SessionInfo) string {
	if t := excerpt(si.Recap, maxDetail); t != "" {
		return t
	}
	if si.Name != "" {
		return si.Name
	}
	if base := filepath.Base(strings.TrimRight(filepath.ToSlash(firstNonEmpty(si.Root, si.Cwd)), "/")); base != "." && base != "/" && base != "" {
		return base
	}
	return clip(si.ID, 8)
}

// ticketItems: the change-log rows about the person's tickets — new ones assigned to them, status changes of
// theirs, and tickets assigned to them. Several status rows of one ticket read as one "first → last" line.
func ticketItems(changes []proto.TicketChange, ts []proto.Ticket, person string) []proto.BriefingItem {
	if person == "" {
		return nil
	}
	byExt := make(map[string]proto.Ticket, len(ts))
	for _, t := range ts {
		byExt[t.ExternalID] = t
	}
	type agg struct {
		isNew, assigned           bool
		from, to, assignedFrom    string
		newAt, statusAt, assignAt int64
	}
	order := []string{}
	m := map[string]*agg{}
	for _, c := range changes { // oldest first
		t, ok := byExt[c.ExternalID]
		if !ok {
			continue
		}
		mine := store.IsPerson(t.Assignee, person)
		a := m[c.ExternalID]
		if a == nil {
			a = &agg{}
		}
		switch c.Kind {
		case "new":
			if !mine {
				continue
			}
			a.isNew, a.newAt = true, c.At
		case "status":
			if !mine {
				continue
			}
			if a.statusAt == 0 {
				a.from = c.From
			}
			a.to, a.statusAt = c.To, c.At
		case "assigned":
			if !store.IsPerson(c.To, person) || !mine {
				continue
			}
			a.assigned, a.assignedFrom, a.assignAt = true, c.From, c.At
		default:
			continue
		}
		if m[c.ExternalID] == nil {
			m[c.ExternalID] = a
			order = append(order, c.ExternalID)
		}
	}
	var out []proto.BriefingItem
	for _, ext := range order {
		a, t := m[ext], byExt[ext]
		item := proto.BriefingItem{Kind: "ticket", Title: t.Title, Ref: t.ID}
		switch {
		case a.isNew:
			item.Detail, item.At = "New ticket for you · "+statusLabel(t), max(a.newAt, a.statusAt, a.assignAt)
		case a.assigned:
			item.Detail, item.At = "Assigned to you", max(a.assignAt, a.statusAt)
			if a.assignedFrom != "" {
				item.Detail += " (was " + a.assignedFrom + ")"
			}
			if a.statusAt != 0 && a.from != a.to {
				item.Detail += " · " + statusName(a.from) + " → " + statusName(a.to)
			}
		case a.statusAt != 0 && a.from != a.to:
			to := statusName(a.to)
			if a.to == t.Status {
				to = statusLabel(t) // "Parked" when the source says so
			}
			item.Detail, item.At = statusName(a.from)+" → "+to, a.statusAt
		default:
			continue // a status that went back where it was
		}
		out = append(out, item)
	}
	return out
}

func statusName(s string) string {
	switch s {
	case "todo":
		return "To do"
	case "in_progress":
		return "In progress"
	case "in_review":
		return "In review"
	case "done":
		return "Done"
	case "blocked":
		return "Blocked"
	}
	return s
}

// statusLabel is the ticket's current status as shown, "Parked" for the Moontech parked status.
func statusLabel(t proto.Ticket) string {
	if t.Status == "blocked" && t.RawStatus == "aparcado" {
		return "Parked"
	}
	return statusName(t.Status)
}

// noteItems: the meeting notes the hub first stored after the previous visit (a seeded note never counts),
// at the time they were first seen.
func noteItems(ns []store.NewNote) []proto.BriefingItem {
	var out []proto.BriefingItem
	for _, n := range ns {
		detail := excerpt(n.Summary, maxDetail)
		if detail == "" {
			detail = "New meeting note"
		}
		out = append(out, proto.BriefingItem{Kind: "note", Title: firstNonEmpty(strings.TrimSpace(n.Title), "Meeting note"), Detail: detail, At: n.FirstSeenAt, Ref: n.ExternalID})
	}
	return out
}

// meetings splits the notes dated on or after from into bullets: each "- " line starts an item (an unbulleted
// line continues the previous one). Actions keep only the lines that start with "<person>:" (with or without
// the bullet, case-insensitive), without that prefix.
func meetings(ns []proto.MeetingNote, from, person string) proto.BriefingMeetings {
	m := proto.BriefingMeetings{Decisions: []proto.MeetingItem{}, OpenPoints: []proto.MeetingItem{}, Actions: []proto.MeetingItem{}}
	for _, n := range ns { // newest first
		if n.Date < from {
			continue
		}
		title := strings.TrimSpace(n.Title)
		for _, t := range bullets(n.Decisions) {
			m.Decisions = appendItem(m.Decisions, proto.MeetingItem{Text: t, NoteTitle: title, Date: n.Date})
		}
		for _, t := range bullets(n.OpenPoints) {
			m.OpenPoints = appendItem(m.OpenPoints, proto.MeetingItem{Text: t, NoteTitle: title, Date: n.Date})
		}
		for _, t := range personActions(n.Actions, person) {
			m.Actions = appendItem(m.Actions, proto.MeetingItem{Text: t, NoteTitle: title, Date: n.Date})
		}
	}
	return m
}

func appendItem(l []proto.MeetingItem, it proto.MeetingItem) []proto.MeetingItem {
	if len(l) >= maxMeetingItems || it.Text == "" {
		return l
	}
	return append(l, it)
}

// bullets returns the items of a "- " bulleted text.
func bullets(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case strings.HasPrefix(line, "- "):
			out = append(out, strings.TrimSpace(line[2:]))
		case line == "-":
		case len(out) == 0:
			out = append(out, line)
		default:
			out[len(out)-1] += " " + line
		}
	}
	return out
}

// personActions returns the person's action items: each line that starts with "<person>:" or "- <person>:"
// starts one (without that prefix); another "- " line, or an unbulleted line that starts with another short
// "<name>:", starts somebody else's; any other unbulleted line continues the item before it.
func personActions(text, person string) []string {
	var out []string
	keep := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if rest, ok := personAction(line, person); ok {
			out, keep = append(out, rest), true
			continue
		}
		if strings.HasPrefix(line, "-") || namedLine(line) {
			keep = false // somebody else's item, bulleted or not
			continue
		}
		if keep {
			out[len(out)-1] += " " + line
		}
	}
	return out
}

// namedLine: the line starts with a short name (1 to 3 words) and a colon, like "Ben:" or "Ben Smith:".
func namedLine(line string) bool {
	i := strings.IndexByte(line, ':')
	if i <= 0 {
		return false
	}
	n := len(strings.Fields(line[:i]))
	return n >= 1 && n <= 3
}

// personAction: the bullet starts with "<person>:" (case-insensitive); it returns the rest.
func personAction(item, person string) (string, bool) {
	person = strings.TrimSpace(person)
	if person == "" {
		return "", false
	}
	ir := []rune(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(item), "- ")))
	n := utf8.RuneCountInString(person)
	if len(ir) <= n || ir[n] != ':' || !strings.EqualFold(string(ir[:n]), person) {
		return "", false
	}
	rest := strings.TrimSpace(string(ir[n+1:]))
	return rest, rest != ""
}

// excerpt is s on one line, at most n runes (the last one "…" when cut).
func excerpt(s string, n int) string { return cutRunes(strings.Join(strings.Fields(s), " "), n) }

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
