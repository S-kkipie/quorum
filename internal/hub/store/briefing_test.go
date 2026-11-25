package store

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

const minMs = int64(60 * 1000)

func briefingStore(t *testing.T) (*Store, proto.Project) {
	s, err := Open(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s, mkProject(t, s)
}

func TestTicketChangesDiff(t *testing.T) {
	s, p := briefingStore(t)
	ch, err := s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "todo", Assignee: "Ana"},
		{ExternalID: "2", Title: "b", Status: "todo", Assignee: "Ben"},
	}, 1000)
	require.NoError(t, err)
	require.Empty(t, ch, "the first sync seeds without new rows")
	got, err := s.TicketChanges(p.ID, 0)
	require.NoError(t, err)
	require.Empty(t, got)

	// Unchanged resync (even with a newer updatedAt): nothing recorded.
	ch, err = s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "todo", Assignee: "Ana", UpdatedAt: 5},
		{ExternalID: "2", Title: "b", Status: "todo", Assignee: "Ben"},
	}, 2000)
	require.NoError(t, err)
	require.Empty(t, ch)

	ch, err = s.ReplaceTickets(p.ID, []proto.Ticket{
		{ExternalID: "1", Title: "a", Status: "in_progress", Assignee: "Ana"},
		{ExternalID: "2", Title: "b", Status: "todo", Assignee: "Ana"},
		{ExternalID: "3", Title: "c", Status: "todo", Assignee: "Ana"},
	}, 3000)
	require.NoError(t, err)
	want := []proto.TicketChange{
		{ExternalID: "1", Kind: "status", From: "todo", To: "in_progress", At: 3000},
		{ExternalID: "2", Kind: "assigned", From: "Ben", To: "Ana", At: 3000},
		{ExternalID: "3", Kind: "new", To: "todo", At: 3000},
	}
	require.Equal(t, want, ch)
	got, err = s.TicketChanges(p.ID, 0)
	require.NoError(t, err)
	require.Equal(t, want, got)
	got, err = s.TicketChanges(p.ID, 3000)
	require.NoError(t, err)
	require.Empty(t, got, "since is exclusive")
}

func TestTicketChangesPrunedAfter60Days(t *testing.T) {
	s, p := briefingStore(t)
	_, err := s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "todo"}}, 1000)
	require.NoError(t, err)
	_, err = s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "done"}}, 2000)
	require.NoError(t, err)
	got, _ := s.TicketChanges(p.ID, 0)
	require.Len(t, got, 1)
	day := int64(24 * 60 * 60 * 1000)
	_, err = s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "done"}}, 2000+59*day)
	require.NoError(t, err)
	got, _ = s.TicketChanges(p.ID, 0)
	require.Len(t, got, 1)
	_, err = s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "done"}}, 2000+61*day)
	require.NoError(t, err)
	got, _ = s.TicketChanges(p.ID, 0)
	require.Empty(t, got)
}

func TestTicketOptionalFieldsRoundTrip(t *testing.T) {
	s, p := briefingStore(t)
	_, err := s.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "1", Status: "todo", PlannedStart: 10, PlannedEnd: 20, NoteTitle: "Kickoff"}}, 1)
	require.NoError(t, err)
	ts, err := s.ListTickets(p.ID)
	require.NoError(t, err)
	require.Equal(t, int64(10), ts[0].PlannedStart)
	require.Equal(t, int64(20), ts[0].PlannedEnd)
	require.Equal(t, "Kickoff", ts[0].NoteTitle)
	one, err := s.Ticket(ts[0].ID)
	require.NoError(t, err)
	require.Equal(t, "Kickoff", one.NoteTitle)
}

func TestVisitRollover(t *testing.T) {
	s, p := briefingStore(t)
	seen, prev, err := s.Visits(p.ID)
	require.NoError(t, err)
	require.Zero(t, seen)
	require.Zero(t, prev)

	t0 := 1_000_000 * minMs
	seen, prev, rolled, err := s.Visit(p.ID, t0)
	require.NoError(t, err)
	require.True(t, rolled)
	require.Equal(t, t0, seen)
	require.Zero(t, prev)

	seen, prev, rolled, err = s.Visit(p.ID, t0+10*minMs)
	require.NoError(t, err)
	require.False(t, rolled)
	require.Equal(t, t0, seen)
	require.Zero(t, prev)

	seen, prev, rolled, err = s.Visit(p.ID, t0+30*minMs)
	require.NoError(t, err)
	require.False(t, rolled, "exactly 30 minutes is not older than 30 minutes")
	require.Equal(t, t0, seen)

	seen, prev, rolled, err = s.Visit(p.ID, t0+31*minMs)
	require.NoError(t, err)
	require.True(t, rolled)
	require.Equal(t, t0+31*minMs, seen)
	require.Equal(t, t0, prev)

	seen, prev, err = s.Visits(p.ID)
	require.NoError(t, err)
	require.Equal(t, t0+31*minMs, seen)
	require.Equal(t, t0, prev)

	_, _, _, err = s.Visit("nope", t0)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestPinnedNotes(t *testing.T) {
	s, p := briefingStore(t)
	_, err := s.AddPinned(p.ID, "   ", 1)
	require.Error(t, err)
	_, err = s.AddPinned(p.ID, strings.Repeat("é", 501), 1)
	require.Error(t, err)
	a, err := s.AddPinned(p.ID, strings.Repeat("é", 500), 1)
	require.NoError(t, err)
	require.NotEmpty(t, a.ID)
	b, err := s.AddPinned(p.ID, " call Ben ", 2)
	require.NoError(t, err)
	require.Equal(t, "call Ben", b.Text)
	got, err := s.Pinned(p.ID)
	require.NoError(t, err)
	require.Equal(t, []proto.PinnedNote{a, b}, got)

	require.ErrorIs(t, s.DeletePinned(p.ID, "missing"), ErrNotFound)
	require.NoError(t, s.DeletePinned(p.ID, a.ID))
	got, _ = s.Pinned(p.ID)
	require.Equal(t, []proto.PinnedNote{b}, got)
	_, err = s.AddPinned("nope", "x", 1)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestMeetingNotes(t *testing.T) {
	s, p := briefingStore(t)
	n1 := proto.MeetingNote{ExternalID: "n1", Title: "Sync", Date: "2026-11-10", Decisions: "- ship it", UpdatedAt: 1}
	n2 := proto.MeetingNote{ExternalID: "n2", Title: "Review", Date: "2026-11-20", Actions: "- Ana: draft", UpdatedAt: 1}
	changed, err := s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n1, n2})
	require.NoError(t, err)
	require.True(t, changed)
	changed, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n1, n2})
	require.NoError(t, err)
	require.False(t, changed)

	n2.Summary = "edited"
	changed, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n1, n2})
	require.NoError(t, err)
	require.True(t, changed)

	got, err := s.MeetingNotes(p.ID, "2026-11-15")
	require.NoError(t, err)
	require.Equal(t, []proto.MeetingNote{n2}, got)
	got, _ = s.MeetingNotes(p.ID, "")
	require.Equal(t, []proto.MeetingNote{n2, n1}, got)

	changed, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{n2})
	require.NoError(t, err)
	require.True(t, changed, "a note that left the source is dropped")
	got, _ = s.MeetingNotes(p.ID, "")
	require.Equal(t, []proto.MeetingNote{n2}, got)

	_, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{{Title: "x"}})
	require.Error(t, err)
	got, _ = s.MeetingNotes(p.ID, "")
	require.Len(t, got, 1, "a failed replace leaves the notes alone")
}

func TestWhereLeftOffRoundTrip(t *testing.T) {
	s, p := briefingStore(t)
	text, at, err := s.WhereLeftOff(p.ID)
	require.NoError(t, err)
	require.Empty(t, text)
	require.Zero(t, at)
	require.NoError(t, s.SetWhereLeftOff(p.ID, "You were fixing login.", 42))
	text, at, err = s.WhereLeftOff(p.ID)
	require.NoError(t, err)
	require.Equal(t, "You were fixing login.", text)
	require.Equal(t, int64(42), at)
	require.ErrorIs(t, s.SetWhereLeftOff("nope", "x", 1), ErrNotFound)
	_, _, err = s.WhereLeftOff("nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestBriefingMigrationOnOldDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "h.db")
	s, err := Open(path)
	require.NoError(t, err)
	for _, q := range []string{`ALTER TABLE tickets DROP COLUMN note_title`, `ALTER TABLE projects DROP COLUMN where_left_off`, `DROP TABLE pinned_notes`} {
		_, err = s.db.Exec(q)
		require.NoError(t, err)
	}
	require.NoError(t, s.Close())
	s, err = Open(path)
	require.NoError(t, err)
	defer s.Close()
	p := mkProject(t, s)
	require.NoError(t, s.SetWhereLeftOff(p.ID, "x", 1))
	_, err = s.AddPinned(p.ID, "x", 1)
	require.NoError(t, err)
}
