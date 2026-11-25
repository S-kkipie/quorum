package store

import (
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// The rollover is measured from the last visit on any device: a desktop at 9:00, a phone at 9:20 and the desktop
// again at 9:45 is one sitting (seen_at stays 9:00); a visit more than 30 minutes after the last one rolls.
func TestVisitRolloverFromLastVisit(t *testing.T) {
	s, p := briefingStore(t)
	h9 := 9 * 60 * minMs
	at := func(h, m int64) int64 { return h*60*minMs + m*minMs }
	seen, prev, rolled, err := s.Visit(p.ID, at(9, 0))
	require.NoError(t, err)
	require.True(t, rolled)
	require.Equal(t, h9, seen)
	for _, v := range []int64{at(9, 20), at(9, 45), at(10, 10)} {
		seen, prev, rolled, err = s.Visit(p.ID, v)
		require.NoError(t, err)
		require.False(t, rolled, "each visit is within 30 minutes of the last one")
		require.Equal(t, h9, seen)
		require.Zero(t, prev)
	}
	seen, prev, rolled, err = s.Visit(p.ID, at(11, 0))
	require.NoError(t, err)
	require.True(t, rolled, "50 minutes after the last visit")
	require.Equal(t, at(11, 0), seen)
	require.Equal(t, h9, prev, "prev is the old seen_at")
}

// The review's example: 9:40 is 40 minutes after 9:00 (one rollover), 9:50 is 10 minutes after 9:40 (none),
// 11:00 is 70 minutes after 9:50 (rolls again).
func TestVisitRolloverDesktopPhoneDesktop(t *testing.T) {
	s, p := briefingStore(t)
	at := func(h, m int64) int64 { return h*60*minMs + m*minMs }
	_, _, _, err := s.Visit(p.ID, at(9, 0))
	require.NoError(t, err)
	_, _, rolled, err := s.Visit(p.ID, at(9, 40))
	require.NoError(t, err)
	require.True(t, rolled)
	seen, prev, rolled, err := s.Visit(p.ID, at(9, 50))
	require.NoError(t, err)
	require.False(t, rolled)
	require.Equal(t, at(9, 40), seen)
	require.Equal(t, at(9, 0), prev)
	seen, prev, rolled, err = s.Visit(p.ID, at(11, 0))
	require.NoError(t, err)
	require.True(t, rolled)
	require.Equal(t, at(11, 0), seen)
	require.Equal(t, at(9, 40), prev)
}

func TestNotesFirstSeen(t *testing.T) {
	s, p := briefingStore(t)
	n1 := proto.MeetingNote{ExternalID: "n1", Title: "Sync", Date: "2020-01-01"}
	_, err := s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n1}, 1000)
	require.NoError(t, err)
	got, err := s.NotesSeenSince(p.ID, 0)
	require.NoError(t, err)
	require.Empty(t, got, "the seeding sync is never new")

	n2 := proto.MeetingNote{ExternalID: "n2", Title: "Old date, new here", Date: "2020-01-02"}
	_, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n1, n2}, 5000)
	require.NoError(t, err)
	got, err = s.NotesSeenSince(p.ID, 4000)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "n2", got[0].ExternalID)
	require.Equal(t, int64(5000), got[0].FirstSeenAt, "by first-seen time, whatever its meeting date")
	got, _ = s.NotesSeenSince(p.ID, 5000)
	require.Empty(t, got)

	n2.Summary = "edited"
	_, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n1, n2}, 9000)
	require.NoError(t, err)
	got, _ = s.NotesSeenSince(p.ID, 4000)
	require.Equal(t, int64(5000), got[0].FirstSeenAt, "an edit keeps the first-seen time")
	require.Equal(t, "edited", got[0].Summary)
}

func TestResetConnectorDropsChangeLogAndNotes(t *testing.T) {
	s, p := briefingStore(t)
	other := mkProject(t, s)
	for _, pid := range []string{p.ID, other.ID} {
		_, err := s.ReplaceTickets(pid, []proto.Ticket{{ExternalID: "1", Status: "todo"}}, 1)
		require.NoError(t, err)
		_, err = s.ReplaceTickets(pid, []proto.Ticket{{ExternalID: "1", Status: "done"}}, 2)
		require.NoError(t, err)
		_, err = s.ReplaceMeetingNotes(pid, []proto.MeetingNote{{ExternalID: "n", Date: "2026-01-01"}}, 1)
		require.NoError(t, err)
	}
	cur, err := s.GetProject(p.ID)
	require.NoError(t, err)
	cur.Connector = proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{"product": "Other"}}
	_, err = s.UpdateProjectResetConnector(cur)
	require.NoError(t, err)
	for _, tb := range []string{"ticket_changes", "meeting_notes"} {
		var n, m int
		require.NoError(t, s.db.QueryRow(`SELECT count(*) FROM `+tb+` WHERE project_id=?`, p.ID).Scan(&n))
		require.NoError(t, s.db.QueryRow(`SELECT count(*) FROM `+tb+` WHERE project_id=?`, other.ID).Scan(&m))
		require.Zero(t, n, tb)
		require.Equal(t, 1, m, tb+" of another project stays")
	}
}

func TestReplaceAllTicketsPrunesMissing(t *testing.T) {
	s, p := briefingStore(t)
	ts := []proto.Ticket{{ExternalID: "1", Status: "todo", Assignee: "Ana"}, {ExternalID: "2", Status: "todo", Assignee: "Ana"}}
	_, _, err := s.ReplaceAllTickets(p.ID, ts, 1)
	require.NoError(t, err)
	stored, _ := s.ListTickets(p.ID)
	byExt := map[string]string{}
	for _, t := range stored {
		byExt[t.ExternalID] = t.ID
	}
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m", Root: "/r", State: proto.StateIdle}))
	require.NoError(t, s.LinkSessionTicket(proto.SessionTicket{SessionID: "s1", TicketID: byExt["2"], Confirmed: true}))
	_, err = s.CreateProposal(proto.Proposal{TicketID: byExt["2"], Kind: "comment", Body: "x"})
	require.NoError(t, err)

	ch, removed, err := s.ReplaceAllTickets(p.ID, ts[:1], 2)
	require.NoError(t, err)
	require.Empty(t, ch, "a removal writes no change-log row")
	require.Equal(t, []proto.SessionTicket{{SessionID: "s1", TicketID: byExt["2"], Removed: true}}, removed)
	stored, _ = s.ListTickets(p.ID)
	require.Len(t, stored, 1)
	require.Equal(t, "1", stored[0].ExternalID)
	ls, _ := s.SessionTickets("s1")
	require.Empty(t, ls)
	ps, _ := s.ListProposals(byExt["2"])
	require.Empty(t, ps)
	log, _ := s.TicketChanges(p.ID, 0)
	require.Empty(t, log)

	// ReplaceTickets (a source that may return a partial list) keeps the missing ones
	_, err = s.ReplaceTickets(p.ID, nil, 3)
	require.NoError(t, err)
	stored, _ = s.ListTickets(p.ID)
	require.Len(t, stored, 1)
}

func TestDeletePendingProposalsOfKinds(t *testing.T) {
	s, p := briefingStore(t)
	other := mkProject(t, s)
	p.Connector = proto.ConnectorConfig{Kind: "moontech", Settings: map[string]string{}}
	require.NoError(t, s.UpdateProject(p))
	var props []proto.Proposal
	for _, pid := range []string{p.ID, other.ID} {
		require.NoError(t, replaceTk(s, pid, []proto.Ticket{{ExternalID: "1", Status: "todo"}}))
		ts, _ := s.ListTickets(pid)
		pr, err := s.CreateProposal(proto.Proposal{TicketID: ts[0].ID, Kind: "comment", Body: "x"})
		require.NoError(t, err)
		props = append(props, pr)
	}
	n, err := s.DeletePendingProposalsOfKinds([]string{"moontech"})
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	_, err = s.GetProposal(props[0].ID)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = s.GetProposal(props[1].ID)
	require.NoError(t, err, "another source's proposal stays")
	n, err = s.DeletePendingProposalsOfKinds(nil)
	require.NoError(t, err)
	require.Zero(t, n)
}
