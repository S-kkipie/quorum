package store

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestNormalizeRepoURL(t *testing.T) {
	for _, in := range []string{
		"git@github.com:O/R.git", "https://github.com/o/r", "https://github.com/O/R.git",
		"https://user@GitHub.com/o/r/", "ssh://git@github.com/o/r.git", "github.com/o/r",
	} {
		require.Equal(t, "github.com/o/r", NormalizeRepoURL(in), in)
	}
	require.Equal(t, "", NormalizeRepoURL(" "))
}

func mkProject(t *testing.T, s *Store) proto.Project {
	w, err := s.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := s.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "p", Connector: proto.ConnectorConfig{Kind: "github", Settings: map[string]string{"repo": "o/r"}}})
	require.NoError(t, err)
	return p
}

func TestReplaceTicketsKeepsMissing(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "done", Comments: []proto.TicketComment{{Author: "x", Body: "hi", At: 1}}},
		{ExternalID: "2", Title: "b", Status: "todo"},
	}))
	first, _ := s.ListTickets(p.ID)
	require.Len(t, first, 2)
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "a2", Status: "done"}}))
	ts, err := s.ListTickets(p.ID)
	require.NoError(t, err)
	require.Len(t, ts, 2)
	for _, tk := range ts {
		if tk.ExternalID == "1" {
			require.Equal(t, "a2", tk.Title)
		}
	}
	got, _ := s.GetProject(p.ID)
	require.Equal(t, proto.Progress{Done: 1, Total: 2}, got.Progress)
	// stable ids across upserts
	for _, a := range first {
		for _, b := range ts {
			if a.ExternalID == b.ExternalID {
				require.Equal(t, a.ID, b.ID)
			}
		}
	}
	require.Equal(t, "hi", func() string {
		for _, tk := range first {
			if tk.ExternalID == "1" {
				return tk.Comments[0].Body
			}
		}
		return ""
	}())
}

func TestProjectTokenNeverExposed(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	got, _ := s.GetProject(p.ID)
	require.False(t, got.Connector.HasToken)
	require.NoError(t, s.SetConnectorToken(p.ID, "secret"))
	got, err := s.GetProject(p.ID)
	require.NoError(t, err)
	require.True(t, got.Connector.HasToken)
	require.Equal(t, "o/r", got.Connector.Settings["repo"])
	all, _ := s.ListProjects()
	require.True(t, all[0].Connector.HasToken)
	tok, err := s.ConnectorToken(p.ID)
	require.NoError(t, err)
	require.Equal(t, "secret", tok)
}

func TestDeleteWorkspaceNotEmpty(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	require.ErrorIs(t, s.DeleteWorkspace(p.WorkspaceID), ErrNotEmpty)
	require.NoError(t, s.DeleteProject(p.ID))
	require.NoError(t, s.DeleteWorkspace(p.WorkspaceID))
	require.ErrorIs(t, s.DeleteWorkspace(p.WorkspaceID), ErrNotFound)
}

func TestDeleteProjectCleansUp(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	require.NoError(t, s.SetConnectorToken(p.ID, "t"))
	_, err := s.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r"})
	require.NoError(t, err)
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "todo"}}))
	ts, _ := s.ListTickets(p.ID)
	require.NoError(t, s.LinkSessionTicket(proto.SessionTicket{SessionID: "s", TicketID: ts[0].ID}))
	_, err = s.CreateProposal(proto.Proposal{TicketID: ts[0].ID, Kind: "comment", Body: "x"})
	require.NoError(t, err)

	require.NoError(t, s.DeleteProject(p.ID))
	_, err = s.GetProject(p.ID)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = s.ConnectorToken(p.ID)
	require.ErrorIs(t, err, ErrNotFound)
	ls, _ := s.SessionTickets("s")
	require.Empty(t, ls)
	ps, _ := s.ListProposals("")
	require.Empty(t, ps)
	c, err := s.CheckoutForRoot("m", "/r")
	require.NoError(t, err)
	require.Equal(t, "", c.ProjectID)
}

func TestCheckoutsAndProposals(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	c1, err := s.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r", Branch: "a"})
	require.NoError(t, err)
	c2, err := s.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r", Branch: "b"})
	require.NoError(t, err)
	require.Equal(t, c1.ID, c2.ID)
	require.Equal(t, "b", c2.Branch)
	cs, _ := s.ListCheckouts(p.ID)
	require.Len(t, cs, 1)
	_, err = s.CheckoutForRoot("m", "/nope")
	require.ErrorIs(t, err, ErrNotFound)

	pr, err := s.CreateProposal(proto.Proposal{TicketID: "t", Kind: "status", Body: "done"})
	require.NoError(t, err)
	require.Equal(t, "pending", pr.Status)
	require.NoError(t, s.SetProposalStatus(pr.ID, "failed", "boom"))
	ps, _ := s.ListProposals("t")
	require.Equal(t, "failed", ps[0].Status)
	require.Equal(t, "boom", ps[0].Error)
	require.NoError(t, s.SetProjectSummary(p.ID, "sum", 5))
	require.NoError(t, s.SetSyncResult(p.ID, "err", 6))
	g, _ := s.GetProject(p.ID)
	require.Equal(t, "sum", g.Summary)
	require.EqualValues(t, 6, g.SyncedAt)
	require.Equal(t, "err", g.SyncError)
}

func TestMigratePlan1DB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	// Plan 1 DB: only the old schema, with data.
	old, err := Open(path)
	require.NoError(t, err)
	for _, tbl := range []string{"workspaces", "projects", "project_tokens", "checkouts", "tickets", "session_tickets", "proposals"} {
		_, err = old.db.Exec(`DROP TABLE ` + tbl)
		require.NoError(t, err)
	}
	_, err = old.db.Exec(`INSERT INTO sessions(id,machine,name) VALUES('s1','m','old')`)
	require.NoError(t, err)
	require.NoError(t, old.Close())

	s, err := Open(path)
	require.NoError(t, err)
	defer s.Close()
	var name string
	require.NoError(t, s.db.QueryRow(`SELECT name FROM sessions WHERE id='s1'`).Scan(&name))
	require.Equal(t, "old", name)
	_, err = s.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
}

func TestTicketValidation(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	err := s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "done"}, {ExternalID: "2", Status: "weird"}})
	require.ErrorContains(t, err, "weird")
	ts, _ := s.ListTickets(p.ID)
	require.Empty(t, ts, "rollback total")
	require.Error(t, s.ReplaceTickets(p.ID, []proto.Ticket{{Title: "x", Status: "done"}}))
	require.True(t, ValidStatus("in_review"))
	require.False(t, ValidStatus("pending"))
}

func TestCheckoutProjectKept(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	c, err := s.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r"})
	require.NoError(t, err)
	c, err = s.UpsertCheckout(proto.Checkout{Machine: "m", Root: "/r", Branch: "x"})
	require.NoError(t, err)
	require.Equal(t, p.ID, c.ProjectID)
	require.NoError(t, s.SetCheckoutProject(c.ID, ""))
	c, _ = s.CheckoutForRoot("m", "/r")
	require.Equal(t, "", c.ProjectID)
	require.NoError(t, s.SetCheckoutProject(c.ID, p.ID))
	require.ErrorIs(t, s.SetCheckoutProject("nope", p.ID), ErrNotFound)
}

func TestUpdateProjectWorkspaceAndProposalEnums(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	p.WorkspaceID = "nope"
	require.ErrorIs(t, s.UpdateProject(p), ErrNotFound)
	_, err := s.CreateProposal(proto.Proposal{TicketID: "t", Kind: "bogus"})
	require.Error(t, err)
	pr, err := s.CreateProposal(proto.Proposal{TicketID: "t", Kind: "comment"})
	require.NoError(t, err)
	require.Error(t, s.SetProposalStatus(pr.ID, "bogus", ""))
	require.NoError(t, s.SetProposalStatus(pr.ID, "approved", ""))
}

func TestReplaceTicketsNilCommentsKeepsStored(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	cm := []proto.TicketComment{{Author: "x", Body: "hi", At: 1}}
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "a", Status: "todo", Comments: cm}}))
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "b", Status: "todo"}}))
	ts, err := s.ListTickets(p.ID)
	require.NoError(t, err)
	require.Equal(t, "b", ts[0].Title)
	require.Equal(t, cm, ts[0].Comments)
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "b", Status: "todo", Comments: []proto.TicketComment{}}}))
	ts, _ = s.ListTickets(p.ID)
	require.Empty(t, ts[0].Comments)
}

func TestProgressWindow30Days(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	now := time.Now().UnixMilli()
	old := now - 40*24*3600*1000
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "done", UpdatedAt: now - 1000},
		{ExternalID: "2", Title: "b", Status: "todo", UpdatedAt: now - 2000},
		{ExternalID: "3", Title: "c", Status: "done", UpdatedAt: old},
	}))
	got, _ := s.GetProject(p.ID)
	require.Equal(t, proto.Progress{Done: 1, Total: 2}, got.Progress)
	act, err := s.ProjectActivity(p.ID)
	require.NoError(t, err)
	require.Equal(t, now-1000, act)
}

func TestProgressFallbackAndUndated(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	now := time.Now().UnixMilli()
	old := now - 40*24*3600*1000
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "done", UpdatedAt: old},
		{ExternalID: "2", Title: "b", Status: "todo", UpdatedAt: old},
	}))
	got, _ := s.GetProject(p.ID)
	require.Equal(t, proto.Progress{Done: 1, Total: 2}, got.Progress) // empty window: all
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "3", Title: "c", Status: "done"}}))
	got, _ = s.GetProject(p.ID)
	require.Equal(t, proto.Progress{Done: 1, Total: 1}, got.Progress) // no date counts as recent
}

func TestProjectActivityIncludesLiveSessions(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	now := time.Now().UnixMilli()
	old := now - 10*24*3600*1000
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Title: "a", Status: "todo", UpdatedAt: old}}))
	_, err := s.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r", RepoURL: "git@x:o/r.git"})
	require.NoError(t, err)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m", Root: "/r", State: proto.StateWorking, UpdatedAt: now}))
	act, err := s.ProjectActivity(p.ID)
	require.NoError(t, err)
	require.Equal(t, now, act)
	// closed does not count
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m", Root: "/r", State: proto.StateClosed, UpdatedAt: now}))
	act, _ = s.ProjectActivity(p.ID)
	require.Equal(t, old, act)
}

func TestProgressBogusTimestampsCountAsUndated(t *testing.T) {
	s := openMem(t)
	p := mkProject(t, s)
	require.NoError(t, s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "done", UpdatedAt: 1},
		{ExternalID: "2", Title: "b", Status: "todo", UpdatedAt: 2},
		{ExternalID: "3", Title: "c", Status: "todo", UpdatedAt: time.Now().UnixMilli()},
	}))
	got, _ := s.GetProject(p.ID)
	require.Equal(t, proto.Progress{Done: 1, Total: 3}, got.Progress)
}
