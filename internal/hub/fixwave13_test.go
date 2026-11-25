package hub

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestMoontechIdentityKeys(t *testing.T) {
	base := proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{
		"baseUrl": "https://a.example", "product": "Acme", "titlePrefix": "Atlas", "person": "Ana", "username": "ana"}}
	with := func(k, v string) proto.ConnectorConfig {
		c := proto.ConnectorConfig{Kind: base.Kind, Settings: map[string]string{}}
		for kk, vv := range base.Settings {
			c.Settings[kk] = vv
		}
		c.Settings[k] = v
		return c
	}
	for _, k := range []string{"baseUrl", "product", "titlePrefix"} {
		require.True(t, connectorIdentityChanged(base, with(k, "other")), k)
	}
	for _, k := range []string{"person", "username"} {
		require.False(t, connectorIdentityChanged(base, with(k, "other")), k)
	}
}

// readOnlyFx: a project per kind, each with one ticket confirmed on its own session.
func readOnlyFx(t *testing.T, st *store.Store, kind string) (proto.Project, proto.Ticket, string) {
	t.Helper()
	w, err := st.CreateWorkspace(proto.Workspace{Name: "w-" + kind})
	require.NoError(t, err)
	p, err := st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: kind,
		Connector: proto.ConnectorConfig{Kind: kind, Settings: map[string]string{"repo": "o/r", "product": "Acme", "username": "ana"}}})
	require.NoError(t, err)
	_, err = st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "t", Status: "todo"}}, 1)
	require.NoError(t, err)
	ts, _ := st.ListTickets(p.ID)
	sid := "s-" + kind
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: sid, Machine: "m1", Root: "/" + kind, Role: proto.RoleWork, State: proto.StateIdle}))
	require.NoError(t, st.LinkSessionTicket(proto.SessionTicket{SessionID: sid, TicketID: ts[0].ID, Confirmed: true}))
	return p, ts[0], sid
}

func TestReadOnlySourceGetsNoCommentDraft(t *testing.T) {
	s, st, _ := newTestServer(t)
	_, mt, mtSess := readOnlyFx(t, st, "moontech")
	_, gh, ghSess := readOnlyFx(t, st, "github")
	for _, sid := range []string{mtSess, ghSess} {
		d, _ := json.Marshal(proto.TurnEnd{Answer: "Fixed it."})
		s.hub.draftFromTurnEnd(proto.Event{Session: sid, Kind: proto.KindTurnEnd, Data: d})
	}
	ps, _ := st.ListProposals(mt.ID)
	require.Empty(t, ps, "a read-only source never gets a comment proposal")
	ps, _ = st.ListProposals(gh.ID)
	require.Len(t, ps, 1)
}

func TestReadOnlySourceRejectsStatusProposal(t *testing.T) {
	f := newAppFx(t)
	_, mt, _ := readOnlyFx(t, f.st, "moontech")
	code, body := f.req(t, "POST", "/api/tickets/"+mt.ID+"/proposals", `{"kind":"status","status":"done"}`)
	require.Equal(t, 400, code, body)
	require.Contains(t, body, "read-only")
}

func TestStartDropsPendingProposalsOfReadOnlySources(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hub.db")
	st, err := store.Open(path)
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	_, mt, _ := readOnlyFx(t, st, "moontech")
	_, gh, _ := readOnlyFx(t, st, "github")
	a, err := st.CreateProposal(proto.Proposal{TicketID: mt.ID, Kind: "comment", Body: "x"})
	require.NoError(t, err)
	b, err := st.CreateProposal(proto.Proposal{TicketID: gh.ID, Kind: "comment", Body: "x"})
	require.NoError(t, err)
	NewServer(st)
	_, err = st.GetProposal(a.ID)
	require.ErrorIs(t, err, store.ErrNotFound)
	_, err = st.GetProposal(b.ID)
	require.NoError(t, err)
}

// countModel counts the "where you left off" calls.
type countModel struct {
	mu sync.Mutex
	n  int
}

func (m *countModel) Complete(ctx context.Context, prompt string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.n++
	return "You were fixing the login.", nil
}

func (m *countModel) calls() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.n
}

// "Where you left off" is lazy: turn ends with no page open never call the model; the briefing request does,
// once, and the text arrives with project_briefing_changed.
func TestBriefingRequestDrivesLeftOff(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	m := &countModel{}
	s := NewServer(st, Options{Model: m})
	p := briefingProject(t, st, "Ana")
	require.NoError(t, st.SetProjectSummary(p.ID, "x", time.Now().UnixMilli())) // no summary call in the way
	for i := range 10 {
		briefingSession(t, st, "s1", proto.StateIdle, "Login", "answer", time.Now().UnixMilli()+int64(i))
		s.hub.sessionEnded(proto.SessionInfo{ID: "s1", ProjectID: p.ID, Role: proto.RoleWork})
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s.sum.Start(ctx)
	s.sum.RunOnce(ctx)
	require.Zero(t, m.calls(), "no page open")

	rr := do(s.Handler(), "GET", "/api/projects/"+p.ID+"/briefing", "", map[string]string{"Authorization": "Bearer " + devToken(t, st)})
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Contains(t, rr.Body.String(), `"whereLeftOff":null`, "answers with the current text right away")
	eventually(t, func() bool { text, _, _, _ := st.WhereLeftOff(p.ID); return text != "" })
	require.Equal(t, 1, m.calls())

	rr = do(s.Handler(), "GET", "/api/projects/"+p.ID+"/briefing", "", map[string]string{"Authorization": "Bearer " + devToken(t, st)})
	require.Contains(t, rr.Body.String(), "You were fixing the login.")
	s.sum.RunOnce(ctx)
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, 1, m.calls(), "reopened within 10 minutes")
}

func devToken(t *testing.T, st *store.Store) string {
	t.Helper()
	tok, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, st.AddToken("device", "tel", tok))
	return tok
}

// A meeting note counts as new since the previous visit by when the hub first stored it, not by its meeting date;
// the seeding sync is never new.
func TestBriefingNotesNewByFirstSeen(t *testing.T) {
	s, st, _ := newTestServer(t)
	p := briefingProject(t, st, "Ana")
	now := time.Now()
	ms := func(d time.Duration) int64 { return now.Add(d).UnixMilli() }
	today := now.Format(time.DateOnly)
	seeded := proto.MeetingNote{ExternalID: "n0", Title: "Seeded today", Date: today}
	_, err := st.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{seeded}, ms(-30*time.Minute))
	require.NoError(t, err)
	_, _, _, err = st.Visit(p.ID, ms(-3*time.Hour))
	require.NoError(t, err)
	_, _, _, err = st.Visit(p.ID, ms(-time.Hour))
	require.NoError(t, err)
	late := proto.MeetingNote{ExternalID: "n1", Title: "Written up late", Date: now.AddDate(0, 0, -30).Format(time.DateOnly), Summary: "From last month."}
	_, err = st.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{seeded, late}, ms(-20*time.Minute))
	require.NoError(t, err)
	b, err := s.briefing(p.ID, now)
	require.NoError(t, err)
	var notes []proto.BriefingItem
	for _, x := range b.NewSince {
		if x.Kind == "note" {
			notes = append(notes, x)
		}
	}
	require.Equal(t, []proto.BriefingItem{{Kind: "note", Title: "Written up late", Detail: "From last month.", At: ms(-20 * time.Minute), Ref: "n1"}}, notes)
}
