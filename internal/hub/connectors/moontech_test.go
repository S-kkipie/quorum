package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

const mtPass = "pw-Very$ecret"

// fakeMoontech is an httptest fake of the admin site's JSON API (made-up data only).
type fakeMoontech struct {
	mu         sync.Mutex
	srv        *httptest.Server
	logins     int
	session    string // valid cookie value; "" = no valid session
	expire     bool   // drop the session after the next authorized request
	deny       bool   // every API call answers 401, even after login
	down       bool   // every call answers 503
	notesDown  bool   // /api/notes answers 500 echoing the password
	authCode   int    // status for a missing or expired session (default 401)
	ticketsRaw string // when set, /api/tickets answers this body with 200
	notesRaw   string // when set, /api/notes answers this body with 200
	wrapped    bool   // answer {"tickets":[...]} instead of a bare array
	tickets    []map[string]any
	notes      []map[string]any
	lastBody   map[string]string
}

func newFakeMoontech(t *testing.T) *fakeMoontech {
	f := &fakeMoontech{}
	f.tickets = []map[string]any{
		{"id": 11, "title": "Ornamel · fix login", "detail": "the form loses focus", "status": "por_hacer", "person_name": "Ana", "product": "Acme",
			"planned_start": "2026-11-20", "planned_end": "2026-11-27T15:30:00Z", "note_title": "Weekly sync", "updated_at": "2026-11-21T10:00:00Z"},
		{"id": "12", "title": "  ornamel: export report", "detail": "", "status": "en_curso", "person_name": "Ben", "product": "acme",
			"planned_start": nil, "planned_end": nil, "updated_at": "2026-11-22 08:00:00"},
		{"id": 13, "title": "ORNAMEL parked item", "status": "aparcado", "person_name": "Ana", "product": "Acme"},
		{"id": 14, "title": "Ornamel done item", "status": "hecho", "person_name": "Ana", "product": "Acme"},
		{"id": 15, "title": "Other project task", "status": "por_hacer", "person_name": "Ana", "product": "Acme"},
		{"id": 16, "title": "Ornamel wrong product", "status": "por_hacer", "person_name": "Ana", "product": "Globex"},
	}
	f.notes = []map[string]any{
		{"id": 1, "title": "Ornamel weekly", "meeting_date": "2026-11-20", "summary": "s", "decisions": "- ship it", "open_points": "", "actions": "- Ana: review",
			"products": []string{"Acme", "Globex"}, "notion_url": "https://notes.example/1", "updated_at": "2026-11-20T12:00:00Z"},
		{"id": 2, "title": "General standup", "meeting_date": "2026-11-21", "summary": "", "decisions": "", "open_points": "", "actions": "- Ben: update ORNAMEL docs",
			"products": []string{"Acme"}},
		{"id": 3, "title": "Unrelated", "meeting_date": "2026-11-21", "summary": "nothing here", "products": []string{"Acme"}},
		{"id": 4, "title": "Ornamel in another product", "meeting_date": "2026-11-21", "products": []string{"Globex"}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.down {
			w.WriteHeader(503)
			return
		}
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.lastBody = b
		f.logins++
		if b["username"] != "ana" || b["password"] != mtPass {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"bad credentials for ` + b["password"] + `"}`))
			return
		}
		f.session = "sess-" + string(rune('a'+f.logins))
		http.SetCookie(w, &http.Cookie{Name: "session", Value: f.session, Path: "/", HttpOnly: true})
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	auth := func(w http.ResponseWriter, r *http.Request) bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.down {
			w.WriteHeader(503)
			return false
		}
		c, err := r.Cookie("session")
		if f.deny || err != nil || f.session == "" || c.Value != f.session {
			code := f.authCode
			if code == 0 {
				code = 401
			}
			w.WriteHeader(code)
			return false
		}
		if f.expire {
			f.expire = false
			f.session = ""
		}
		return true
	}
	mux.HandleFunc("GET /api/tickets", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.ticketsRaw != "" {
			_, _ = w.Write([]byte(f.ticketsRaw))
			return
		}
		if f.wrapped {
			_ = json.NewEncoder(w).Encode(map[string]any{"tickets": f.tickets})
			return
		}
		_ = json.NewEncoder(w).Encode(f.tickets)
	})
	mux.HandleFunc("GET /api/notes", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.notesRaw != "" {
			_, _ = w.Write([]byte(f.notesRaw))
			return
		}
		if f.notesDown {
			w.WriteHeader(500)
			_, _ = w.Write([]byte("boom " + mtPass))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"notes": f.notes})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMoontech) set(fn func(f *fakeMoontech)) { f.mu.Lock(); fn(f); f.mu.Unlock() }

func (f *fakeMoontech) loginCount() int { f.mu.Lock(); defer f.mu.Unlock(); return f.logins }

func mtCfg(base string, extra ...string) proto.ConnectorConfig {
	s := map[string]string{"baseUrl": base, "product": "Acme", "titlePrefix": " ornamel ", "person": "Ana", "username": "ana"}
	for i := 0; i+1 < len(extra); i += 2 {
		s[extra[i]] = extra[i+1]
	}
	return proto.ConnectorConfig{Kind: "moontech", Settings: s}
}

func newMT(t *testing.T, f *fakeMoontech, extra ...string) *moontechConnector {
	c, err := New(mtCfg(f.srv.URL, extra...), mtPass, nil)
	require.NoError(t, err)
	return c.(*moontechConnector)
}

func TestMoontechLoginBody(t *testing.T) {
	require.Equal(t, map[string]string{"username": "u", "password": "p"}, loginBody("u", "p"))
}

func TestMoontechListMapsAndFilters(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		f := newFakeMoontech(t)
		f.wrapped = wrapped
		c := newMT(t, f)
		ts, err := c.List(context.Background(), 0)
		require.NoError(t, err)
		require.Equal(t, map[string]string{"username": "ana", "password": mtPass}, f.lastBody)
		by := map[string]proto.Ticket{}
		for _, x := range ts {
			by[x.ExternalID] = x
		}
		require.Len(t, by, 4, "product and prefix filters (case and spacing ignored)")
		a := by["11"]
		require.Equal(t, "Ornamel · fix login", a.Title)
		require.Equal(t, "the form loses focus", a.Body)
		require.Equal(t, "todo", a.Status)
		require.Equal(t, "por_hacer", a.RawStatus)
		require.Equal(t, "Ana", a.Assignee)
		require.Equal(t, "Weekly sync", a.NoteTitle)
		require.Equal(t, f.srv.URL+"/ticket", a.URL)
		require.Equal(t, "2026-11-20", time.UnixMilli(a.PlannedStart).UTC().Format("2006-01-02"))
		require.Equal(t, time.Date(2026, 11, 27, 15, 30, 0, 0, time.UTC).UnixMilli(), a.PlannedEnd)
		require.Equal(t, time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC).UnixMilli(), a.UpdatedAt)
		b := by["12"]
		require.Equal(t, "in_progress", b.Status)
		require.Zero(t, b.PlannedStart)
		require.Zero(t, b.PlannedEnd)
		require.Equal(t, time.Date(2026, 11, 22, 8, 0, 0, 0, time.UTC).UnixMilli(), b.UpdatedAt)
		require.Equal(t, "blocked", by["13"].Status)
		require.Equal(t, "aparcado", by["13"].RawStatus)
		require.Equal(t, "done", by["14"].Status)
	}
}

func TestMoontechNoPrefixKeepsWholeProduct(t *testing.T) {
	f := newFakeMoontech(t)
	ts, err := newMT(t, f, "titlePrefix", "").List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, ts, 5)
	ns, err := newMT(t, f, "titlePrefix", "").ListNotes(context.Background())
	require.NoError(t, err)
	require.Len(t, ns, 3)
}

func TestMoontechPrefixWithPunctuation(t *testing.T) {
	f := newFakeMoontech(t)
	ts, err := newMT(t, f, "titlePrefix", "Ornamel:").List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, ts, 4)
}

func TestMoontechListNotesFilters(t *testing.T) {
	f := newFakeMoontech(t)
	ns, err := newMT(t, f).ListNotes(context.Background())
	require.NoError(t, err)
	by := map[string]proto.MeetingNote{}
	for _, n := range ns {
		by[n.ExternalID] = n
	}
	require.Len(t, by, 2, "product filter, and the prefix may be mentioned in the actions")
	n := by["1"]
	require.Equal(t, "Ornamel weekly", n.Title)
	require.Equal(t, "2026-11-20", n.Date)
	require.Equal(t, "- ship it", n.Decisions)
	require.Equal(t, "- Ana: review", n.Actions)
	require.Equal(t, "https://notes.example/1", n.URL)
	require.Equal(t, time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC).UnixMilli(), n.UpdatedAt)
	require.Contains(t, by, "2")
	require.Equal(t, f.srv.URL+"/notes", by["2"].URL)
}

func TestMoontechReloginOnce(t *testing.T) {
	f := newFakeMoontech(t)
	c := newMT(t, f)
	_, err := c.List(context.Background(), 0)
	require.NoError(t, err)
	require.Equal(t, 1, f.loginCount())
	// The session expires mid-session: one new login, then success.
	f.set(func(f *fakeMoontech) { f.session = "" })
	ts, err := c.List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, ts, 4)
	require.Equal(t, 2, f.loginCount())

	// A 401 again after the new login is an error, with one login only.
	f.set(func(f *fakeMoontech) { f.deny = true })
	_, err = c.ListNotes(context.Background())
	require.ErrorContains(t, err, "not authorized")
	require.Equal(t, 3, f.loginCount())
	require.NotContains(t, err.Error(), mtPass)
}

func TestMoontechBadLoginAndDownRedacted(t *testing.T) {
	f := newFakeMoontech(t)
	c, err := New(mtCfg(f.srv.URL), "wrong-"+mtPass, nil)
	require.NoError(t, err)
	_, err = c.List(context.Background(), 0)
	require.ErrorContains(t, err, "login")
	require.NotContains(t, err.Error(), mtPass)

	f.set(func(f *fakeMoontech) { f.down = true })
	_, err = newMT(t, f).List(context.Background(), 0)
	require.ErrorContains(t, err, "503")

	f.srv.Close()
	_, err = newMT(t, f).List(context.Background(), 0)
	require.Error(t, err)
	require.NotContains(t, err.Error(), mtPass)
}

func TestMoontechReadOnly(t *testing.T) {
	f := newFakeMoontech(t)
	c := newMT(t, f)
	require.ErrorContains(t, c.Comment(context.Background(), "11", "hi"), "read-only source")
	require.ErrorContains(t, c.SetStatus(context.Background(), "11", "done"), "read-only source")
	require.Zero(t, f.loginCount())
}

func TestMoontechSettings(t *testing.T) {
	_, err := New(proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{"product": "Acme"}}, mtPass, nil)
	require.ErrorContains(t, err, "username")
	_, err = New(proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{"username": "ana"}}, mtPass, nil)
	require.ErrorContains(t, err, "product")
	_, err = New(mtCfg("ftp://x"), mtPass, nil)
	require.ErrorContains(t, err, "http")
	c, err := New(proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{"product": "Acme", "username": "ana"}}, mtPass, nil)
	require.NoError(t, err)
	require.Equal(t, "https://moontecx-admin.pages.dev", c.(*moontechConnector).baseURL)
	require.Contains(t, Kinds(), "moontech")
}

// --- syncer with a moontech source ---

type synced struct {
	changes      []proto.TicketChange
	notesChanged bool
}

func newMTSync(t *testing.T, f *fakeMoontech) (*store.Store, *Syncer, proto.Project, func() []synced) {
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	ws, err := st.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := st.CreateProject(proto.Project{WorkspaceID: ws.ID, Name: "p", Connector: mtCfg(f.srv.URL)})
	require.NoError(t, err)
	require.NoError(t, st.SetConnectorToken(p.ID, mtPass))
	sy := NewSyncer(st, func(proto.Envelope) {})
	var mu sync.Mutex
	var calls []synced
	sy.OnSynced = func(id string, ch []proto.TicketChange, nc bool) {
		require.Equal(t, p.ID, id)
		mu.Lock()
		calls = append(calls, synced{ch, nc})
		mu.Unlock()
	}
	get := func() []synced { mu.Lock(); defer mu.Unlock(); return append([]synced(nil), calls...) }
	return st, sy, p, get
}

func captureLog(t *testing.T) *bytes.Buffer {
	var buf bytes.Buffer
	var mu sync.Mutex
	prev := log.Writer()
	log.SetOutput(writerFunc(func(b []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return buf.Write(b) }))
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

type writerFunc func([]byte) (int, error)

func (w writerFunc) Write(b []byte) (int, error) { return w(b) }

func TestSyncMoontechOnSyncedAndNotes(t *testing.T) {
	f := newFakeMoontech(t)
	st, sy, p, calls := newMTSync(t, f)
	require.NoError(t, sy.SyncNow(p.ID))
	ts, _ := st.ListTickets(p.ID)
	require.Len(t, ts, 4)
	by := map[string]proto.Ticket{}
	for _, x := range ts {
		by[x.ExternalID] = x
	}
	require.Equal(t, "blocked", by["13"].Status, "the syncer keeps aparcado as blocked")
	ns, _ := st.MeetingNotes(p.ID, "")
	require.Len(t, ns, 2)
	c := calls()
	require.Len(t, c, 1)
	require.True(t, c[0].notesChanged)
	for _, ch := range c[0].changes {
		require.NotEqual(t, "new", ch.Kind, "the first sync seeds without new entries")
	}

	// Nothing changed: OnSynced reports no changes.
	require.NoError(t, sy.SyncNow(p.ID))
	c = calls()
	require.Len(t, c, 2)
	require.Empty(t, c[1].changes)
	require.False(t, c[1].notesChanged)

	// A status change and a new ticket.
	f.set(func(f *fakeMoontech) {
		f.tickets[0]["status"] = "en_curso"
		f.tickets = append(f.tickets, map[string]any{"id": 17, "title": "Ornamel new one", "status": "por_hacer", "person_name": "Ana", "product": "Acme"})
	})
	require.NoError(t, sy.SyncNow(p.ID))
	c = calls()
	require.Len(t, c, 3)
	kinds := map[string]string{}
	for _, ch := range c[2].changes {
		kinds[ch.ExternalID] = ch.Kind
	}
	require.Equal(t, map[string]string{"11": "status", "17": "new"}, kinds)
	require.False(t, c[2].notesChanged)
}

func TestSyncMoontechDownKeepsState(t *testing.T) {
	f := newFakeMoontech(t)
	st, sy, p, calls := newMTSync(t, f)
	buf := captureLog(t)
	require.NoError(t, sy.SyncNow(p.ID))
	before, _ := st.ListTickets(p.ID)
	notesBefore, _ := st.MeetingNotes(p.ID, "")

	f.set(func(f *fakeMoontech) { f.down = true })
	err := sy.SyncNow(p.ID)
	require.Error(t, err)
	require.NotContains(t, err.Error(), mtPass)
	after, _ := st.ListTickets(p.ID)
	require.ElementsMatch(t, before, after)
	notesAfter, _ := st.MeetingNotes(p.ID, "")
	require.ElementsMatch(t, notesBefore, notesAfter)
	require.Len(t, calls(), 1, "a failed sync records no changes")
	pr, _ := st.GetProject(p.ID)
	require.NotEmpty(t, pr.SyncError)
	require.NotContains(t, pr.SyncError, mtPass)

	// The session expired while the site was down; the next sync logs in again and recovers.
	f.set(func(f *fakeMoontech) { f.down = false; f.session = "" })
	require.NoError(t, sy.SyncNow(p.ID))
	c := calls()
	require.Len(t, c, 2)
	require.Empty(t, c[1].changes, "no phantom changes after recovery")
	require.False(t, c[1].notesChanged)
	pr, _ = st.GetProject(p.ID)
	require.Empty(t, pr.SyncError)
	require.NotContains(t, buf.String(), mtPass)
}

func TestSyncMoontechNotesFailureKeepsNotesSavesTickets(t *testing.T) {
	f := newFakeMoontech(t)
	st, sy, p, calls := newMTSync(t, f)
	buf := captureLog(t)
	require.NoError(t, sy.SyncNow(p.ID))
	f.set(func(f *fakeMoontech) {
		f.notesDown = true
		f.tickets[1]["status"] = "hecho"
	})
	require.NoError(t, sy.SyncNow(p.ID), "a notes failure does not fail the sync")
	ns, _ := st.MeetingNotes(p.ID, "")
	require.Len(t, ns, 2, "previous notes stay")
	ts, _ := st.ListTickets(p.ID)
	for _, x := range ts {
		if x.ExternalID == "12" {
			require.Equal(t, "done", x.Status, "tickets are still saved")
		}
	}
	c := calls()
	require.Len(t, c, 2)
	require.Len(t, c[1].changes, 1)
	require.False(t, c[1].notesChanged)
	require.Contains(t, buf.String(), "notes")
	require.NotContains(t, buf.String(), mtPass)
	require.True(t, strings.Contains(buf.String(), "***"), "the echoed password is redacted")
}

func TestMoontechRelogin403(t *testing.T) {
	f := newFakeMoontech(t)
	f.authCode = 403
	c := newMT(t, f)
	_, err := c.List(context.Background(), 0)
	require.NoError(t, err)
	f.set(func(f *fakeMoontech) { f.session = "" })
	_, err = c.List(context.Background(), 0)
	require.NoError(t, err, "a 403 on an expired session logs in again")
	require.Equal(t, 2, f.loginCount())
	f.set(func(f *fakeMoontech) { f.deny = true })
	_, err = c.ListNotes(context.Background())
	require.ErrorContains(t, err, "not authorized")
	require.Equal(t, 3, f.loginCount())
}

func TestMoontechUnexpectedObjectIsError(t *testing.T) {
	f := newFakeMoontech(t)
	f.ticketsRaw = `{"error":"oops ` + mtPass + `"}`
	f.notesRaw = `{"items":[]}`
	c := newMT(t, f)
	_, err := c.List(context.Background(), 0)
	require.ErrorContains(t, err, "unexpected response")
	require.NotContains(t, err.Error(), mtPass)
	_, err = c.ListNotes(context.Background())
	require.ErrorContains(t, err, "unexpected response")

	// The expected key with null is an empty list.
	f.set(func(f *fakeMoontech) { f.ticketsRaw = `{"tickets":null}`; f.notesRaw = `{"notes":null}` })
	ts, err := c.List(context.Background(), 0)
	require.NoError(t, err)
	require.Empty(t, ts)
	ns, err := c.ListNotes(context.Background())
	require.NoError(t, err)
	require.Empty(t, ns)
}

func TestSyncMoontechUnexpectedObjectKeepsState(t *testing.T) {
	f := newFakeMoontech(t)
	st, sy, p, calls := newMTSync(t, f)
	buf := captureLog(t)
	require.NoError(t, sy.SyncNow(p.ID))
	before, _ := st.ListTickets(p.ID)
	notesBefore, _ := st.MeetingNotes(p.ID, "")
	require.NotEmpty(t, before)
	require.NotEmpty(t, notesBefore)

	// Tickets: an object without "tickets" fails the sync and keeps everything.
	f.set(func(f *fakeMoontech) { f.ticketsRaw = `{"error":"session for ` + mtPass + `"}` })
	err := sy.SyncNow(p.ID)
	require.ErrorContains(t, err, "unexpected response")
	require.NotContains(t, err.Error(), mtPass)
	after, _ := st.ListTickets(p.ID)
	require.ElementsMatch(t, before, after)
	notesAfter, _ := st.MeetingNotes(p.ID, "")
	require.ElementsMatch(t, notesBefore, notesAfter)
	require.Len(t, calls(), 1)
	pr, _ := st.GetProject(p.ID)
	require.NotContains(t, pr.SyncError, mtPass)

	// Notes: an object without "notes" keeps the notes; tickets still sync with no changes.
	f.set(func(f *fakeMoontech) { f.ticketsRaw = ""; f.notesRaw = `{"error":"denied ` + mtPass + `"}` })
	require.NoError(t, sy.SyncNow(p.ID))
	notesAfter, _ = st.MeetingNotes(p.ID, "")
	require.ElementsMatch(t, notesBefore, notesAfter)
	after, _ = st.ListTickets(p.ID)
	require.ElementsMatch(t, before, after)
	c := calls()
	require.Len(t, c, 2)
	require.Empty(t, c[1].changes)
	require.False(t, c[1].notesChanged)
	require.Contains(t, buf.String(), "unexpected response")
	require.NotContains(t, buf.String(), mtPass)
}
