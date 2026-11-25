package hub

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// briefingProject creates a project of product Acme whose person is Ana, with a checkout m1:/r.
func briefingProject(t *testing.T, st *store.Store, person string) proto.Project {
	t.Helper()
	w, err := st.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "Acme",
		Connector: proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{"product": "Acme", "person": person}}})
	require.NoError(t, err)
	_, err = st.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m1", Root: "/r"})
	require.NoError(t, err)
	return p
}

func briefingSession(t *testing.T, st *store.Store, id string, state proto.SessionState, recap, answer string, endAt int64) {
	t.Helper()
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: id, Machine: "m1", Root: "/r", Cwd: "/r", Role: proto.RoleWork, State: state, Recap: recap, UpdatedAt: endAt}))
	_, err := st.AppendEvent(proto.Event{Session: id, TS: endAt - 10, Kind: proto.KindUser, Data: json.RawMessage(`{"text":"go"}`)})
	require.NoError(t, err)
	if answer != "" {
		d, _ := json.Marshal(proto.TurnEnd{Answer: answer})
		_, err := st.AppendEvent(proto.Event{Session: id, TS: endAt, Kind: proto.KindTurnEnd, Data: d})
		require.NoError(t, err)
	}
}

func TestBriefingSections(t *testing.T) {
	s, st, _ := newTestServer(t)
	p := briefingProject(t, st, " ana ")
	now := time.Now()
	ms := func(d time.Duration) int64 { return now.Add(d).UnixMilli() }

	// visits: previous at -2h, current at -1h
	_, _, _, err := st.Visit(p.ID, ms(-2*time.Hour))
	require.NoError(t, err)
	_, _, _, err = st.Visit(p.ID, ms(-time.Hour))
	require.NoError(t, err)

	// tickets: the first sync seeds, the second one changes
	_, err = st.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "Login redirect", Status: "todo", Assignee: "Ana"},
		{ExternalID: "2", Title: "Report", Status: "todo", Assignee: "Ben"},
		{ExternalID: "3", Title: "Old work", Status: "done", Assignee: "Ana"},
		{ExternalID: "4", Title: "Late", Status: "in_progress", Assignee: "ANA", PlannedEnd: ms(48 * time.Hour)},
		{ExternalID: "5", Title: "Soon", Status: "blocked", RawStatus: "aparcado", Assignee: "Ana", PlannedEnd: ms(24 * time.Hour)},
	}, ms(-3*time.Hour))
	require.NoError(t, err)
	_, err = st.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "Login redirect", Status: "in_progress", Assignee: "Ana"},
		{ExternalID: "2", Title: "Report", Status: "todo", Assignee: "Ana"},
		{ExternalID: "6", Title: "New for Ana", Status: "todo", Assignee: "Ana"},
		{ExternalID: "7", Title: "New for Ben", Status: "todo", Assignee: "Ben"},
	}, ms(-30*time.Minute))
	require.NoError(t, err)

	today := now.Format(time.DateOnly)
	old := now.AddDate(0, 0, -20).Format(time.DateOnly)
	_, err = st.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{
		{ExternalID: "n1", Title: "Weekly", Date: today, Summary: "Planning v2.",
			Decisions: "- Ship v2\n  on Friday\n- Drop IE", OpenPoints: "- Budget?",
			Actions: "- Ana: send the report\n- Ben: review\nana: book the room\n- Anabel: not Ana\n- Ana:"},
		{ExternalID: "n0", Title: "Kickoff", Date: old, Decisions: "- Old decision", Actions: "- Ana: old action"},
	})
	require.NoError(t, err)

	_, err = st.AddPinned(p.ID, "Staging password is in the vault", ms(-5*time.Hour))
	require.NoError(t, err)
	require.NoError(t, st.SetWhereLeftOff(p.ID, "You were fixing the login redirect.", 2, ms(-10*time.Minute)))

	briefingSession(t, st, "done1", proto.StateIdle, "Login fix", "I changed the callback URL.", ms(-20*time.Minute))
	briefingSession(t, st, "busy", proto.StateWorking, "Still going", "partial", ms(-15*time.Minute))
	briefingSession(t, st, "before", proto.StateIdle, "Earlier", "earlier answer", ms(-3*time.Hour))
	briefingSession(t, st, "gone", proto.StateIdle, "", "", ms(-4*time.Hour))
	_, err = st.CloseSession("m1", "gone") // closed now: counts as finished since
	require.NoError(t, err)
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: "svc", Machine: "m1", Root: "/r", Role: proto.RoleService, State: proto.StateIdle}))

	b, err := s.briefing(p.ID, now)
	require.NoError(t, err)

	require.Equal(t, &proto.WhereLeftOff{Text: "You were fixing the login redirect.", At: ms(-10 * time.Minute), Sessions: 2}, b.WhereLeftOff)
	require.Equal(t, ms(-time.Hour), b.SeenAt)
	require.Equal(t, ms(-2*time.Hour), b.PrevSeenAt)

	var mine []string
	for _, tk := range b.MyTickets {
		mine = append(mine, tk.ExternalID)
	}
	require.Equal(t, []string{"5", "4", "1", "2", "6"}, mine, "open, Ana's, by planned end with none last")

	type it struct{ Kind, Title, Detail string }
	var got []it
	for _, x := range b.NewSince {
		got = append(got, it{x.Kind, x.Title, x.Detail})
	}
	require.ElementsMatch(t, []it{
		{"session", "Login fix", "I changed the callback URL."},
		{"session", "r", "Session closed"}, // no recap or name: the folder
		{"ticket", "Login redirect", "To do → In progress"},
		{"ticket", "Report", "Assigned to you (was Ben)"},
		{"ticket", "New for Ana", "New ticket for you · To do"},
		{"note", "Weekly", "Planning v2."},
	}, got)
	for i := 1; i < len(b.NewSince); i++ {
		require.GreaterOrEqual(t, b.NewSince[i-1].At, b.NewSince[i].At, "newest first")
	}
	require.Equal(t, "gone", b.NewSince[0].Ref, "closed just now")

	require.Equal(t, []proto.MeetingItem{{Text: "Ship v2 on Friday", NoteTitle: "Weekly", Date: today}, {Text: "Drop IE", NoteTitle: "Weekly", Date: today}}, b.Meetings.Decisions)
	require.Equal(t, []proto.MeetingItem{{Text: "Budget?", NoteTitle: "Weekly", Date: today}}, b.Meetings.OpenPoints)
	require.Equal(t, []proto.MeetingItem{{Text: "send the report", NoteTitle: "Weekly", Date: today}, {Text: "book the room", NoteTitle: "Weekly", Date: today}}, b.Meetings.Actions)

	require.Len(t, b.Pinned, 1)
	var ids []string
	for _, si := range b.Sessions {
		ids = append(ids, si.ID)
	}
	require.ElementsMatch(t, []string{"done1", "busy", "before", "gone"}, ids, "no service sessions")
	require.Equal(t, "gone", ids[len(ids)-1], "closed ones after the live ones")
}

func TestBriefingEmptyProject(t *testing.T) {
	f := newAppFx(t)
	w, err := f.st.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := f.st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "Bare"})
	require.NoError(t, err)
	code, body := f.req(t, "GET", "/api/projects/"+p.ID+"/briefing", "")
	require.Equal(t, 200, code, body)
	require.JSONEq(t, `{"whereLeftOff":null,"newSince":[],"myTickets":[],"meetings":{"decisions":[],"openPoints":[],"actions":[]},
		"pinned":[],"sessions":[],"seenAt":0,"prevSeenAt":0}`, body)
	code, _ = f.req(t, "GET", "/api/projects/nope/briefing", "")
	require.Equal(t, 404, code)
}

func TestBriefingNoPersonHasNoTicketsOrActions(t *testing.T) {
	s, st, _ := newTestServer(t)
	p := briefingProject(t, st, "")
	_, err := st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "a", Status: "todo", Assignee: ""}}, 1)
	require.NoError(t, err)
	_, err = st.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{{ExternalID: "n", Date: time.Now().Format(time.DateOnly), Actions: "- : x\n- Ana: y"}})
	require.NoError(t, err)
	b, err := s.briefing(p.ID, time.Now())
	require.NoError(t, err)
	require.Empty(t, b.MyTickets)
	require.Empty(t, b.Meetings.Actions)
	require.NotNil(t, b.Meetings.Actions)
}

func TestBriefingNewSinceCapAndOrder(t *testing.T) {
	s, st, _ := newTestServer(t)
	p := briefingProject(t, st, "Ana")
	now := time.Now()
	_, _, _, err := st.Visit(p.ID, now.Add(-3*time.Hour).UnixMilli())
	require.NoError(t, err)
	_, _, _, err = st.Visit(p.ID, now.Add(-2*time.Hour).UnixMilli())
	require.NoError(t, err)
	var seed []proto.Ticket
	for i := range 30 {
		seed = append(seed, proto.Ticket{ExternalID: fmt.Sprint(i), Title: fmt.Sprint("t", i), Status: "todo", Assignee: "Ana"})
	}
	_, err = st.ReplaceTickets(p.ID, seed, 1)
	require.NoError(t, err)
	for i := range 30 { // one status change per ticket, a minute apart
		tk := seed[i]
		tk.Status = "in_progress"
		_, err = st.ReplaceTickets(p.ID, []proto.Ticket{tk}, now.Add(time.Duration(i-60)*time.Minute).UnixMilli())
		require.NoError(t, err)
	}
	b, err := s.briefing(p.ID, now)
	require.NoError(t, err)
	require.Len(t, b.NewSince, maxNewSince)
	require.Equal(t, "t29", b.NewSince[0].Title)
	require.Equal(t, "t10", b.NewSince[19].Title)
}

func TestBriefingNeverVisitedHasNoNewSince(t *testing.T) {
	s, st, _ := newTestServer(t)
	p := briefingProject(t, st, "Ana")
	briefingSession(t, st, "s1", proto.StateIdle, "x", "done", time.Now().UnixMilli())
	b, err := s.briefing(p.ID, time.Now())
	require.NoError(t, err)
	require.Empty(t, b.NewSince)
	require.Len(t, b.Sessions, 1)
}

func TestPersonAction(t *testing.T) {
	for _, c := range []struct {
		line, want string
		ok         bool
	}{
		{"Ana: send it", "send it", true},
		{"- ana: send it", "send it", true},
		{"ANA:send", "send", true},
		{"Ana : x", "", false},
		{"Anabel: x", "", false},
		{"Ben: x", "", false},
		{"Ana:", "", false},
	} {
		got, ok := personAction(c.line, " Ana ")
		require.Equal(t, c.ok, ok, c.line)
		require.Equal(t, c.want, got, c.line)
	}
	_, ok := personAction("Ana: x", "")
	require.False(t, ok)
}

func TestPersonActionsStopAtAnotherName(t *testing.T) {
	for _, c := range []struct {
		text string
		want []string
	}{
		{"Ana: x\nBen: y", []string{"x"}},
		{"- Ana: x\n  continues\n- Ben: y", []string{"x continues"}},
		{"Ana: x\nBen y: z", []string{"x"}},
		{"Ana: x\nBen Smith Jr: z\nmore for Ben\nana: w\nand more", []string{"x", "w and more"}},
		{"Ana: x\nthen call the client at 10: before noon please", []string{"x then call the client at 10: before noon please"}},
		{"Ben: y\nAna: x", []string{"x"}},
	} {
		require.Equal(t, c.want, personActions(c.text, "Ana"), c.text)
	}
}

func TestVisitRolloverStable(t *testing.T) {
	f := newAppFx(t)
	p := briefingProject(t, f.st, "Ana")
	old := time.Now().Add(-time.Hour).UnixMilli()
	_, _, _, err := f.st.Visit(p.ID, old)
	require.NoError(t, err)
	var v1, v2 struct{ SeenAt, PrevSeenAt int64 }
	f.reqJSON(t, "POST", "/api/projects/"+p.ID+"/visit", "", 200, &v1)
	require.Equal(t, old, v1.PrevSeenAt, "an hour-old visit rolls over")
	require.Greater(t, v1.SeenAt, old)
	f.reqJSON(t, "POST", "/api/projects/"+p.ID+"/visit", "", 200, &v2) // another device, right after
	require.Equal(t, v1, v2, "within 30 minutes nothing moves")
	code, _ := f.req(t, "POST", "/api/projects/nope/visit", "")
	require.Equal(t, 404, code)
}

func TestPinnedValidationAndEvents(t *testing.T) {
	f := newAppFx(t)
	p := briefingProject(t, f.st, "Ana")
	_, ch := f.live(t)
	base := "/api/projects/" + p.ID + "/pinned"
	for _, body := range []string{`{"text":"   "}`, `{"text":"` + strings.Repeat("a", 501) + `"}`, `{}`, `nope`} {
		code, _ := f.req(t, "POST", base, body)
		require.Equal(t, 400, code, body)
	}
	var n proto.PinnedNote
	f.reqJSON(t, "POST", base, `{"text":"  `+strings.Repeat("á", 500)+`  "}`, 201, &n)
	require.NotEmpty(t, n.ID)
	require.Equal(t, strings.Repeat("á", 500), n.Text)
	code, _ := f.req(t, "POST", "/api/projects/nope/pinned", `{"text":"x"}`)
	require.Equal(t, 404, code)
	require.Equal(t, 204, f.del(t, base+"/"+n.ID))
	require.Equal(t, 404, f.del(t, base+"/"+n.ID))

	// the add and the delete within 2 s are one envelope
	env := waitBriefingEnv(t, ch)
	require.JSONEq(t, `{"projectId":"`+p.ID+`"}`, string(env.Payload))
	select {
	case e := <-ch:
		require.NotEqual(t, "project_briefing_changed", e.Type)
	case <-time.After(2500 * time.Millisecond):
	}
}

func waitBriefingEnv(t *testing.T, ch chan proto.Envelope) proto.Envelope {
	typ, d := "project_briefing_changed", 5*time.Second
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case e := <-ch:
			if e.Type == typ {
				return e
			}
		case <-deadline:
			t.Fatalf("no %s envelope", typ)
			return proto.Envelope{}
		}
	}
}

func briefingHub(t *testing.T) (*Server, *store.Store, *fakeClock, *capture) {
	s, st, _ := newTestServer(t)
	c := &fakeClock{now: time.Unix(1000, 0)}
	cp := &capture{}
	s.hub.afterFunc = c.afterFunc
	s.hub.SetBroadcaster(cp)
	return s, st, c, cp
}

func (c *capture) count(typ string) int {
	n := 0
	for _, x := range c.types() {
		if x == typ {
			n++
		}
	}
	return n
}

func TestBriefingEventsCoalesce(t *testing.T) {
	s, _, clock, cp := briefingHub(t)
	for range 5 {
		s.hub.briefingChanged("p1")
		clock.advance(300 * time.Millisecond)
	}
	s.hub.briefingChanged("p2")
	require.Zero(t, cp.count("project_briefing_changed"))
	clock.advance(time.Second)
	require.Equal(t, 1, cp.count("project_briefing_changed"), "5 triggers within 2 s are one envelope")
	clock.advance(time.Second)
	require.Equal(t, 2, cp.count("project_briefing_changed"), "one per project")
	s.hub.briefingChanged("p1")
	clock.advance(briefingCoalesce)
	require.Equal(t, 3, cp.count("project_briefing_changed"), "a later trigger is a new envelope")
	cp.mu.Lock()
	defer cp.mu.Unlock()
	require.JSONEq(t, `{"projectId":"p1"}`, string(cp.envs[0].Payload))
}

func TestOnSyncedTriggers(t *testing.T) {
	s, st, clock, cp := briefingHub(t)
	p := briefingProject(t, st, "Ana")
	_, err := st.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "a", Status: "todo", Assignee: "Ana"}, {ExternalID: "b", Status: "todo", Assignee: "Ben"},
	}, 1)
	require.NoError(t, err)
	fire := func(changes []proto.TicketChange, notes bool) {
		s.onSynced(p.ID, changes, notes)
		clock.advance(briefingCoalesce)
	}

	fire(nil, false) // a sync that only moved updated_at
	fire([]proto.TicketChange{}, false)
	require.Zero(t, cp.count("project_briefing_changed"))
	require.False(t, s.sum.LeftOffPending(p.ID))

	fire(nil, true)
	require.Equal(t, 1, cp.count("project_briefing_changed"))
	require.False(t, s.sum.LeftOffPending(p.ID), "notes are not an input of where you left off")

	fire([]proto.TicketChange{{ExternalID: "b", Kind: "status", From: "todo", To: "done"}}, false)
	require.Equal(t, 2, cp.count("project_briefing_changed"))
	require.False(t, s.sum.LeftOffPending(p.ID), "Ben's ticket")

	fire([]proto.TicketChange{{ExternalID: "b", Kind: "assigned", From: "Ana", To: "Ben"}}, false)
	require.True(t, s.sum.LeftOffPending(p.ID), "taken away from Ana")
	s.sum.Forget(p.ID)

	fire([]proto.TicketChange{{ExternalID: "a", Kind: "status", From: "todo", To: "in_progress"}}, false)
	require.True(t, s.sum.LeftOffPending(p.ID), "Ana's ticket")
}

func TestSessionEndsTriggerBriefing(t *testing.T) {
	f, p, _ := linkFx(t)
	_, ch := f.live(t)
	f.upsert(t, "s1", "/r/s1", linkRepo, "main")
	eventually(t, func() bool { si, err := f.st.Session("s1"); return err == nil && si.ProjectID == p.ID })
	f.srv.sum.Forget(p.ID)

	d, _ := json.Marshal(proto.TurnEnd{Answer: "done"})
	ev, _ := json.Marshal(proto.Event{Session: "s1", TS: time.Now().UnixMilli(), Kind: proto.KindTurnEnd, Data: d})
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: ev})
	eventually(t, func() bool { return f.srv.sum.LeftOffPending(p.ID) })
	env := waitBriefingEnv(t, ch)
	require.JSONEq(t, `{"projectId":"`+p.ID+`"}`, string(env.Payload))

	f.srv.sum.Forget(p.ID)
	u, _ := json.Marshal(proto.Event{Session: "s1", TS: time.Now().UnixMilli(), Kind: proto.KindUser, Data: json.RawMessage(`{"text":"hi"}`)})
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: u})
	f.machineSend(t, proto.Envelope{Type: "session_gone", Session: "s1"})
	eventually(t, func() bool { si, err := f.st.Session("s1"); return err == nil && si.State == proto.StateClosed })
	eventually(t, func() bool { return f.srv.sum.LeftOffPending(p.ID) })
}

func TestServiceSessionDoesNotTrigger(t *testing.T) {
	s, _, clock, cp := briefingHub(t)
	s.hub.sessionEnded(proto.SessionInfo{ID: "x", ProjectID: "p1", Role: proto.RoleService})
	s.hub.sessionEnded(proto.SessionInfo{ID: "y"})
	clock.advance(briefingCoalesce)
	require.Zero(t, cp.count("project_briefing_changed"))
	require.False(t, s.sum.LeftOffPending("p1"))
}
