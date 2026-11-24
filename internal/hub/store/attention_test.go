package store

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func saveState(t *testing.T, s *Store, id string, st proto.SessionState) {
	t.Helper()
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: id, Machine: "vps-1", State: st}))
}

func appendKind(t *testing.T, s *Store, id string, k proto.EventKind) int64 {
	t.Helper()
	seq, err := s.AppendEvent(proto.Event{Session: id, Kind: k, Data: json.RawMessage(`{}`)})
	require.NoError(t, err)
	return seq
}

func unread(t *testing.T, s *Store, id string) bool {
	t.Helper()
	si, err := s.Session(id)
	require.NoError(t, err)
	return si.Unread
}

func TestUnreadAfterTurnEndUntilSeen(t *testing.T) {
	s := openMem(t)
	saveState(t, s, "a", proto.StateWorking)
	appendKind(t, s, "a", proto.KindUser)
	end := appendKind(t, s, "a", proto.KindTurnEnd)
	require.False(t, unread(t, s, "a"), "working is never unread")
	saveState(t, s, "a", proto.StateIdle)
	require.True(t, unread(t, s, "a"))
	list, err := s.ListSessions(false)
	require.NoError(t, err)
	require.True(t, list[0].Unread)

	moved, err := s.SetSeen("a", end)
	require.NoError(t, err)
	require.True(t, moved)
	require.False(t, unread(t, s, "a"))

	// a new turn ends after the seen mark: unread again
	appendKind(t, s, "a", proto.KindUser)
	appendKind(t, s, "a", proto.KindTurnEnd)
	require.True(t, unread(t, s, "a"))
}

func TestSeenOnlyMovesForwardAndIsCappedAtLatest(t *testing.T) {
	s := openMem(t)
	saveState(t, s, "a", proto.StateIdle)
	for i := 0; i < 3; i++ {
		appendKind(t, s, "a", proto.KindInfo)
	}
	end := appendKind(t, s, "a", proto.KindTurnEnd) // 4
	moved, err := s.SetSeen("a", 2)
	require.NoError(t, err)
	require.True(t, moved)
	require.True(t, unread(t, s, "a"))
	moved, err = s.SetSeen("a", 1) // backwards: ignored
	require.NoError(t, err)
	require.False(t, moved)
	moved, err = s.SetSeen("a", 999) // capped at the latest seq
	require.NoError(t, err)
	require.True(t, moved)
	require.False(t, unread(t, s, "a"))
	// a later turn_end at seq 5 is still unread: the cap kept seen at 4, not 999
	require.Greater(t, appendKind(t, s, "a", proto.KindTurnEnd), end)
	require.True(t, unread(t, s, "a"))
	moved, err = s.SetSeen("missing", 3)
	require.NoError(t, err)
	require.False(t, moved)
}

func TestSeenMarksPersistAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "q.db")
	s, err := Open(path)
	require.NoError(t, err)
	saveState(t, s, "a", proto.StateIdle)
	end := appendKind(t, s, "a", proto.KindTurnEnd)
	_, err = s.SetSeen("a", end)
	require.NoError(t, err)
	appendKind(t, s, "b", proto.KindTurnEnd)
	saveState(t, s, "b", proto.StateIdle)
	require.NoError(t, s.Close())

	s, err = Open(path)
	require.NoError(t, err)
	defer s.Close()
	require.False(t, unread(t, s, "a"))
	require.True(t, unread(t, s, "b"))
}

func TestBackgroundAndClosedNeverUnread(t *testing.T) {
	s := openMem(t)
	saveState(t, s, "a", proto.StateWorking)
	appendKind(t, s, "a", proto.KindTurnEnd)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "vps-1", State: proto.StateBackground,
		Background: proto.BackgroundInfo{Tasks: 2, WakeAt: 1234}}))
	si, err := s.Session("a")
	require.NoError(t, err)
	require.False(t, si.Unread)
	require.Equal(t, proto.BackgroundInfo{Tasks: 2, WakeAt: 1234}, si.Background, "background is persisted")
	due, err := s.DoneDue("a")
	require.NoError(t, err)
	require.Zero(t, due)
	saveState(t, s, "a", proto.StateClosed)
	require.False(t, unread(t, s, "a"))
	_, err = s.CloseMachineSessionsExcept("vps-1", nil)
	require.NoError(t, err)
	require.False(t, unread(t, s, "a"))
}

func TestClaimDoneOncePerEndSeq(t *testing.T) {
	s := openMem(t)
	saveState(t, s, "a", proto.StateWorking)
	end := appendKind(t, s, "a", proto.KindTurnEnd)
	ok, err := s.ClaimDone("a", end)
	require.NoError(t, err)
	require.False(t, ok, "not idle yet")
	saveState(t, s, "a", proto.StateIdle)
	due, err := s.DoneDue("a")
	require.NoError(t, err)
	require.Equal(t, end, due)
	ok, err = s.ClaimDone("a", end)
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.ClaimDone("a", end)
	require.NoError(t, err)
	require.False(t, ok, "the same end_seq is announced once")
	saveState(t, s, "a", proto.StateIdle) // the mod re-sends the state
	due, err = s.DoneDue("a")
	require.NoError(t, err)
	require.Zero(t, due)

	// a newer end is not claimed by the older end's timer
	end2 := appendKind(t, s, "a", proto.KindTurnEnd)
	ok, err = s.ClaimDone("a", end)
	require.NoError(t, err)
	require.False(t, ok)
	// seen before the claim: nothing to announce
	_, err = s.SetSeen("a", end2)
	require.NoError(t, err)
	ok, err = s.ClaimDone("a", end2)
	require.NoError(t, err)
	require.False(t, ok)
}

func TestClaimNeedsYouOncePerTransition(t *testing.T) {
	s := openMem(t)
	saveState(t, s, "a", proto.StateNeedsYou)
	ok, err := s.ClaimNeedsYou("a")
	require.NoError(t, err)
	require.True(t, ok)
	saveState(t, s, "a", proto.StateNeedsYou) // re-sent (hello, re-upsert)
	ok, err = s.ClaimNeedsYou("a")
	require.NoError(t, err)
	require.False(t, ok)
	// a drop closes it and the machine comes back with the same pending question: no repeat
	_, err = s.CloseMachineSessionsExcept("vps-1", nil)
	require.NoError(t, err)
	ok, err = s.ClaimNeedsYou("a")
	require.NoError(t, err)
	require.False(t, ok)
	saveState(t, s, "a", proto.StateNeedsYou)
	ok, err = s.ClaimNeedsYou("a")
	require.NoError(t, err)
	require.False(t, ok)
	// answered, then a new question: a new transition
	saveState(t, s, "a", proto.StateWorking)
	ok, err = s.ClaimNeedsYou("a")
	require.NoError(t, err)
	require.False(t, ok)
	saveState(t, s, "a", proto.StateNeedsYou)
	ok, err = s.ClaimNeedsYou("a")
	require.NoError(t, err)
	require.True(t, ok)
}
