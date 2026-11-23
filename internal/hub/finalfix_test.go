package hub

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/connectors"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// srcConn simulates a ticket source whose content depends on the "repo" setting.
type srcConn struct{ repo string }

var srcLog struct {
	mu    sync.Mutex
	since map[string][]int64
}

func (c srcConn) List(_ context.Context, since int64) ([]proto.Ticket, error) {
	srcLog.mu.Lock()
	srcLog.since[c.repo] = append(srcLog.since[c.repo], since)
	srcLog.mu.Unlock()
	return []proto.Ticket{{ExternalID: "41", Title: "other 41 of " + c.repo, Status: "todo"}}, nil
}
func (srcConn) Comment(context.Context, string, string) error   { return nil }
func (srcConn) SetStatus(context.Context, string, string) error { return nil }

func srcSince(repo string) []int64 {
	srcLog.mu.Lock()
	defer srcLog.mu.Unlock()
	return append([]int64(nil), srcLog.since[repo]...)
}

func init() {
	srcLog.since = map[string][]int64{}
	connectors.Register("fakesrc", func(c proto.ConnectorConfig, _ string, _ []string) (connectors.Connector, error) {
		return srcConn{repo: c.Settings["repo"]}, nil
	})
}

func TestConnectorChangeResetsTicketsLinksProposals(t *testing.T) {
	f, ids := propFx(t, "fakesrc")
	p, err := f.st.Session("s1")
	require.NoError(t, err)
	pid := p.ProjectID
	proj, _ := f.st.GetProject(pid)
	proj.Connector.Settings = map[string]string{"repo": "old/a"}
	require.NoError(t, f.st.UpdateProject(proj))
	require.NoError(t, f.st.SetSyncResult(pid, "", 123456))
	f.turnEnd(t, "progress")
	require.Eventually(t, func() bool { ps, _ := f.st.ListProposals(ids["41"]); return len(ps) == 1 }, 3*time.Second, 20*time.Millisecond)
	ps, _ := f.st.ListProposals(ids["41"])
	old := ps[0]
	require.NotEmpty(t, f.linked("s1"))

	// Changing only the interval touches nothing.
	f.reqJSON(t, "PATCH", "/api/projects/"+pid, `{"connector":{"intervalMin":7}}`, 200, nil)
	got, _ := f.st.GetProposal(old.ID)
	require.Equal(t, "pending", got.Status)
	pp, _ := f.st.GetProject(pid)
	require.EqualValues(t, 123456, pp.SyncedAt)

	// Changing the repo: deletes old tickets, links and leaves the proposal failed.
	f.reqJSON(t, "PATCH", "/api/projects/"+pid, `{"connector":{"settings":{"repo":"new/b"}}}`, 200, nil)
	got, _ = f.st.GetProposal(old.ID)
	require.Equal(t, "failed", got.Status)
	require.Equal(t, store.ConnectorResetMsg, got.Error)
	_, err = f.st.Ticket(ids["41"])
	require.ErrorIs(t, err, store.ErrNotFound)
	require.Empty(t, f.linked("s1"))
	require.Equal(t, 409, f.postJSON(t, "/api/proposals/"+old.ID+"/approve", `{}`, &map[string]string{}))
	require.Zero(t, fake.n())

	// The next query to the new source is complete (since == 0).
	require.Eventually(t, func() bool { return len(srcSince("new/b")) > 0 }, 3*time.Second, 20*time.Millisecond)
	require.EqualValues(t, 0, srcSince("new/b")[0])
	require.Eventually(t, func() bool {
		ts, _ := f.st.ListTickets(pid)
		return len(ts) == 1 && ts[0].Title == "other 41 of new/b" && ts[0].ID != ids["41"]
	}, 3*time.Second, 20*time.Millisecond)
}

func TestApproveRefusedWhenTicketGone(t *testing.T) {
	f, ids := propFx(t, "fakew")
	f.turnEnd(t, "x")
	require.Eventually(t, func() bool { ps, _ := f.st.ListProposals(ids["41"]); return len(ps) == 1 }, 3*time.Second, 20*time.Millisecond)
	ps, _ := f.st.ListProposals(ids["41"])
	// The ticket disappears (e.g. connector change midway) with the proposal still pending.
	tk, _ := f.st.Ticket(ids["41"])
	proj, _ := f.st.GetProject(tk.ProjectID)
	_, err := f.st.UpdateProjectResetConnector(proj)
	require.NoError(t, err)
	require.NoError(t, f.st.SetProposalStatus(ps[0].ID, "pending", ""))
	var got proto.Proposal
	require.Equal(t, 200, f.postJSON(t, "/api/proposals/"+ps[0].ID+"/approve", ``, &got))
	require.Equal(t, "failed", got.Status)
	require.Equal(t, "ticket not found", got.Error)
	require.Zero(t, fake.n(), "nothing is written to the ticket source")
}

func TestListProposalsFilters(t *testing.T) {
	f, _, ids := linkFx(t)
	var made []proto.Proposal
	for i := 0; i < 5; i++ {
		p, err := f.st.CreateProposal(proto.Proposal{TicketID: ids["41"], Kind: "status", Body: "done"})
		require.NoError(t, err)
		made = append(made, p)
		time.Sleep(2 * time.Millisecond)
	}
	require.NoError(t, f.st.SetProposalStatus(made[0].ID, "approved", ""))
	require.NoError(t, f.st.SetProposalStatus(made[4].ID, "rejected", ""))
	var got []proto.Proposal
	f.reqJSON(t, "GET", "/api/proposals?status=pending", "", 200, &got)
	require.Len(t, got, 3)
	for _, p := range got {
		require.Equal(t, "pending", p.Status)
	}
	f.reqJSON(t, "GET", "/api/proposals?limit=2", "", 200, &got)
	require.Len(t, got, 2)
	require.Equal(t, made[4].ID, got[0].ID, "newest first")
	require.Equal(t, made[3].ID, got[1].ID)
	f.reqJSON(t, "GET", "/api/proposals?status=pending&limit=1&ticket="+ids["41"], "", 200, &got)
	require.Len(t, got, 1)
	require.Equal(t, made[3].ID, got[0].ID)
	f.reqJSON(t, "GET", "/api/proposals?ticket="+ids["42"], "", 200, &got)
	require.Empty(t, got)
	code, _ := f.req(t, "GET", "/api/proposals?status=nope", "")
	require.Equal(t, 400, code)
	code, _ = f.req(t, "GET", "/api/proposals?limit=-1", "")
	require.Equal(t, 400, code)
	code, _ = f.req(t, "GET", "/api/proposals?limit=x", "")
	require.Equal(t, 400, code)
}

func TestListProposalsDefaultLimit(t *testing.T) {
	f, _, ids := linkFx(t)
	for i := 0; i < defaultProposalLimit+5; i++ {
		_, err := f.st.CreateProposal(proto.Proposal{TicketID: ids["41"], Kind: "status", Body: "done"})
		require.NoError(t, err)
	}
	var got []proto.Proposal
	f.reqJSON(t, "GET", "/api/proposals", "", 200, &got)
	require.Len(t, got, defaultProposalLimit)
}

func TestDeleteProjectForgetsSummaryState(t *testing.T) {
	f, p, _ := linkFx(t)
	f.srv.sum.Touch(p.ID)
	require.True(t, f.srv.sum.Pending(p.ID))
	require.Equal(t, 204, f.del(t, "/api/projects/"+p.ID))
	require.False(t, f.srv.sum.Pending(p.ID), "deletion forgets it without waiting for the loop")
}
