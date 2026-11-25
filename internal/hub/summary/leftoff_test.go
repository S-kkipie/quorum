package summary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// leftFx: project "Proj" whose person is Ana, with a checkout m:/r and the summarizer on a fake clock.
type leftFx struct {
	st      *store.Store
	p       proto.Project
	m       *fakeModel
	s       *Summarizer
	now     *time.Time
	changed []string
}

func newLeftFx(t *testing.T) *leftFx {
	st, p, m, s, now := setup(t, nil)
	p.Connector = proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{"person": " ana "}}
	require.NoError(t, st.UpdateProject(p))
	_, err := st.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r"})
	require.NoError(t, err)
	m.out = "You were fixing the login redirect. The fix is in review. Next, close ACME-12. Extra sentence."
	f := &leftFx{st: st, p: p, m: m, s: s, now: now}
	s.OnLeftOff = func(id string) { f.changed = append(f.changed, id) }
	return f
}

func (f *leftFx) session(t *testing.T, id, recap, answer string, at time.Time) {
	t.Helper()
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: id, Machine: "m", Root: "/r", Cwd: "/r", Role: proto.RoleWork,
		State: proto.StateIdle, Recap: recap, UpdatedAt: at.UnixMilli()}))
	if answer != "" {
		d, _ := json.Marshal(proto.TurnEnd{Answer: answer})
		_, err := f.st.AppendEvent(proto.Event{Session: id, TS: at.UnixMilli(), Kind: proto.KindTurnEnd, Data: d})
		require.NoError(t, err)
	}
}

// run triggers and lets the quiet period pass.
func (f *leftFx) run() {
	f.s.TouchLeftOff(f.p.ID)
	*f.now = f.now.Add(leftQuiet)
	f.s.RunOnce(context.Background())
}

func (f *leftFx) leftOffCalls() int {
	f.m.mu.Lock()
	defer f.m.mu.Unlock()
	n := 0
	for _, p := range f.m.prompts {
		if strings.Contains(p, "where they left off") {
			n++
		}
	}
	return n
}

func TestLeftOffGeneratesFromSessionsAndOwnTickets(t *testing.T) {
	f := newLeftFx(t)
	require.NoError(t, replaceTk(f.st, f.p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "Login redirect", Status: "in_progress", Assignee: "Ana"},
		{ExternalID: "2", Title: "Ben's report", Status: "todo", Assignee: "Ben"},
		{ExternalID: "3", Title: "Finished work", Status: "done", Assignee: "Ana"},
		{ExternalID: "4", Title: "Parked work", Status: "blocked", Assignee: "ANA"},
	}))
	base := *f.now
	f.session(t, "s1", "Oldest session", "old answer", base.Add(-4*time.Hour))
	f.session(t, "s2", "Login redirect", "I changed the callback URL.", base.Add(-3*time.Hour))
	f.session(t, "s3", "", "Tests pass now.", base.Add(-2*time.Hour))
	f.session(t, "s4", "Review", strings.Repeat("x", 2000), base.Add(-1*time.Hour))
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "svc", Machine: "m", Root: "/r", Role: proto.RoleService, UpdatedAt: base.UnixMilli()}))

	f.run()
	require.Equal(t, 1, f.leftOffCalls())
	pr := f.m.prompts[len(f.m.prompts)-1]
	require.Contains(t, pr, "Login redirect (in_progress)")
	require.Contains(t, pr, "Parked work (blocked)", "parked stays open")
	require.NotContains(t, pr, "Ben's report")
	require.NotContains(t, pr, "Finished work")
	require.Contains(t, pr, "I changed the callback URL.")
	require.Contains(t, pr, "Tests pass now.")
	require.NotContains(t, pr, "old answer", "only the 3 most recent sessions")
	require.NotContains(t, pr, strings.Repeat("x", leftExcerpt+1), "excerpts are capped")
	require.Contains(t, pr, "same language")
	require.Less(t, strings.Index(pr, "Review"), strings.Index(pr, "Tests pass now."), "newest first")

	text, n, at, err := f.st.WhereLeftOff(f.p.ID)
	require.NoError(t, err)
	require.Equal(t, "You were fixing the login redirect. The fix is in review. Next, close ACME-12.", text)
	require.Equal(t, 3, n)
	require.Equal(t, f.now.UnixMilli(), at)
	require.Equal(t, []string{f.p.ID}, f.changed)
	require.False(t, f.s.LeftOffPending(f.p.ID))
}

func TestLeftOffAtMostOncePer10Minutes(t *testing.T) {
	f := newLeftFx(t)
	f.session(t, "s1", "Login", "first", *f.now)
	f.run()
	require.Equal(t, 1, f.leftOffCalls())
	for i := range 9 { // a new turn end every minute keeps triggering
		f.session(t, "s1", "Login", fmt.Sprintf("answer %d", i), *f.now)
		f.s.TouchLeftOff(f.p.ID)
		*f.now = f.now.Add(time.Minute)
		f.s.RunOnce(context.Background())
	}
	require.Equal(t, 1, f.leftOffCalls(), "throttled for 10 minutes")
	require.True(t, f.s.LeftOffPending(f.p.ID), "still pending")
	*f.now = f.now.Add(time.Minute)
	f.s.RunOnce(context.Background())
	require.Equal(t, 2, f.leftOffCalls(), "the pending trigger runs once the gap passed")
	require.Len(t, f.changed, 2)
}

func TestLeftOffDebounces(t *testing.T) {
	f := newLeftFx(t)
	f.session(t, "s1", "Login", "first", *f.now)
	f.s.TouchLeftOff(f.p.ID)
	f.s.RunOnce(context.Background())
	require.Zero(t, f.leftOffCalls(), "waits for the quiet period")
	*f.now = f.now.Add(leftQuiet / 2)
	f.s.TouchLeftOff(f.p.ID)
	*f.now = f.now.Add(leftQuiet / 2)
	f.s.RunOnce(context.Background())
	require.Zero(t, f.leftOffCalls(), "a new trigger restarts the quiet period")
	*f.now = f.now.Add(leftQuiet)
	f.s.RunOnce(context.Background())
	require.Equal(t, 1, f.leftOffCalls())
}

func TestLeftOffUnchangedInputSkipsModel(t *testing.T) {
	f := newLeftFx(t)
	f.session(t, "s1", "Login", "first", *f.now)
	f.run()
	first := f.now.UnixMilli()
	*f.now = f.now.Add(time.Hour)
	f.run()
	require.Equal(t, 1, f.leftOffCalls())
	require.Len(t, f.changed, 1)
	_, _, at, _ := f.st.WhereLeftOff(f.p.ID)
	require.Equal(t, first, at, "nothing stored")
}

func TestLeftOffNoSessionsIsNull(t *testing.T) {
	f := newLeftFx(t)
	f.run()
	require.Zero(t, f.leftOffCalls())
	require.Empty(t, f.changed)
	require.NoError(t, f.st.SetWhereLeftOff(f.p.ID, "stale", 1, f.now.Add(-time.Hour).UnixMilli()))
	f.run()
	text, n, at, _ := f.st.WhereLeftOff(f.p.ID)
	require.Empty(t, text)
	require.Zero(t, n)
	require.Zero(t, at)
	require.Equal(t, []string{f.p.ID}, f.changed)
}

func TestLeftOffModelErrorRetriesLater(t *testing.T) {
	f := newLeftFx(t)
	f.session(t, "s1", "Login", "first", *f.now)
	f.m.err = errors.New("quota")
	f.run()
	require.Equal(t, 1, f.leftOffCalls())
	require.True(t, f.s.LeftOffPending(f.p.ID))
	*f.now = f.now.Add(time.Minute)
	f.s.RunOnce(context.Background())
	require.Equal(t, 1, f.leftOffCalls(), "no retry before 5 minutes")
	f.m.err = nil
	*f.now = f.now.Add(retryGap)
	f.s.RunOnce(context.Background())
	require.Equal(t, 2, f.leftOffCalls())
	text, _, _, _ := f.st.WhereLeftOff(f.p.ID)
	require.NotEmpty(t, text)
}

func TestLeftOffStartSeedsOnlyMissing(t *testing.T) {
	f := newLeftFx(t)
	w, _ := f.st.ListWorkspaces()
	other, err := f.st.CreateProject(proto.Project{WorkspaceID: w[0].ID, Name: "Other"})
	require.NoError(t, err)
	require.NoError(t, f.st.SetWhereLeftOff(other.ID, "done", 1, 5))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.s.Start(ctx)
	require.True(t, f.s.LeftOffPending(f.p.ID))
	require.False(t, f.s.LeftOffPending(other.ID))
}

func TestLeftOffForget(t *testing.T) {
	f := newLeftFx(t)
	f.s.TouchLeftOff(f.p.ID)
	require.True(t, f.s.Pending(f.p.ID))
	f.s.Forget(f.p.ID)
	require.False(t, f.s.Pending(f.p.ID))
}

func TestCleanLeftOff(t *testing.T) {
	require.Equal(t, "One. Two! Three?", CleanLeftOff("\"One.\n Two!  Three? Four.\""))
	require.Equal(t, "Version 1.2 works. Done.", CleanLeftOff("Version 1.2 works. Done."))
	require.Len(t, []rune(CleanLeftOff(strings.Repeat("á", 900))), maxLeftOff)
	require.Empty(t, CleanLeftOff("  \"\" "))
}
