package store

import (
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestReplaceMeetingActionsKeepsIssuedOnes(t *testing.T) {
	s, p := briefingStore(t)
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	require.NoError(t, s.ReplaceMeetingActions(m.ID, []proto.MeetingAction{{Text: "Send the report", Owner: "Ana", Mine: true, TsMs: 5}, {Text: "Book a room"}}))
	acts, err := s.MeetingActions(m.ID)
	require.NoError(t, err)
	require.Len(t, acts, 2)
	require.True(t, acts[0].Mine)
	ok, err := s.SetMeetingActionIssue(m.ID, acts[1].ID, "https://github.com/o/r/issues/1")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.SetMeetingActionIssue(m.ID, acts[1].ID, "https://github.com/o/r/issues/2")
	require.NoError(t, err)
	require.False(t, ok, "the first URL wins")

	// a re-summary: the issued action stays first with its id; one with the same text is not added again
	require.NoError(t, s.ReplaceMeetingActions(m.ID, []proto.MeetingAction{{Text: "book  a ROOM"}, {Text: "New one"}}))
	got, err := s.MeetingActions(m.ID)
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, acts[1].ID, got[0].ID)
	require.Equal(t, "https://github.com/o/r/issues/1", got[0].IssueURL)
	require.Equal(t, "New one", got[1].Text)
	_, err = s.MeetingAction(m.ID, "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestMeetingSpeakersAndMeta(t *testing.T) {
	s, p := briefingStore(t)
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	require.NoError(t, s.SetMeetingSpeakers(m.ID, map[string]string{"Speaker 1": "Ana", "Speaker 2": "Luis"}))
	require.NoError(t, s.SetMeetingSpeakers(m.ID, map[string]string{"Speaker 1": "", "Speaker 2": "Luis M"}))
	names, err := s.MeetingSpeakers(m.ID)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"Speaker 2": "Luis M"}, names)
	require.ErrorIs(t, s.SetMeetingSpeakers("nope", map[string]string{"a": "b"}), ErrNotFound)

	v, err := s.Meta("k")
	require.NoError(t, err)
	require.Equal(t, "", v)
	require.NoError(t, s.SetMeta("k", "v"))
	v, _ = s.Meta("k")
	require.Equal(t, "v", v)
	require.NoError(t, s.SetMeta("k", ""))
	v, _ = s.Meta("k")
	require.Equal(t, "", v)
}
