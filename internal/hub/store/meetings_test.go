package store

import (
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// mkMeeting creates a completed upload (a queued meeting) with its audio at path.
func mkMeeting(t *testing.T, s *Store, projectID, path string) proto.Meeting {
	t.Helper()
	u, err := s.CreateMeetingUpload(MeetingUpload{Size: 10, Name: "a.ogg", Mime: "audio/ogg", ProjectID: projectID, Title: "Weekly", Language: "es"}, nil)
	require.NoError(t, err)
	require.NoError(t, s.SetMeetingUploadOffset(u.ID, 10))
	m, err := s.CompleteMeetingUpload(u.ID, path)
	require.NoError(t, err)
	return m
}

func TestMeetingUploadLifecycle(t *testing.T) {
	s, p := briefingStore(t)
	u, err := s.CreateMeetingUpload(MeetingUpload{Size: 10, Name: "a.ogg", Mime: "audio/ogg", ProjectID: p.ID, Title: "Weekly", Channels: "me|others"}, nil)
	require.NoError(t, err)
	require.NotEmpty(t, u.ID)
	require.NotEmpty(t, u.MeetingID)
	require.Greater(t, u.ExpiresAt, s.now().UnixMilli())
	got, err := s.MeetingUploadByID(u.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), got.Offset)
	_, err = s.CompleteMeetingUpload(u.ID, "/x/a.ogg")
	require.ErrorIs(t, err, ErrUploadIncomplete)
	require.NoError(t, s.SetMeetingUploadOffset(u.ID, 10))
	m, err := s.CompleteMeetingUpload(u.ID, "/x/a.ogg")
	require.NoError(t, err)
	require.Equal(t, u.MeetingID, m.ID)
	require.Equal(t, "uploaded", m.Status)
	require.Equal(t, p.ID, m.ProjectID)
	require.Equal(t, "Weekly", m.Title)
	require.Equal(t, "me|others", m.Channels)
	require.True(t, m.HasAudio)
	require.Equal(t, int64(10), m.AudioBytes)
	// a retried complete returns the same meeting
	m2, err := s.CompleteMeetingUpload(u.ID, "/x/other.ogg")
	require.NoError(t, err)
	require.Equal(t, m.ID, m2.ID)
	path, _, _, ok, err := s.MeetingAudio(m.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "/x/a.ogg", path)
	_, err = s.MeetingUploadByID("nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestMeetingStatusReadySetsAudioExpiry(t *testing.T) {
	s, p := briefingStore(t)
	base := time.UnixMilli(1_000_000_000_000)
	s.now = func() time.Time { return base }
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	require.NoError(t, s.SetMeetingStatus(m.ID, "queued", "", 0))
	require.NoError(t, s.ReplaceMeetingSegments(m.ID, []proto.MeetingSegment{{StartMs: 0, EndMs: 900, Speaker: "Speaker 1", Text: "hola"}}))
	// not ready yet: nothing expires
	gone, err := s.ExpiredMeetingAudio(base.Add(365 * 24 * time.Hour).UnixMilli())
	require.NoError(t, err)
	require.Empty(t, gone)
	require.NoError(t, s.SetMeetingStatus(m.ID, "ready", "", 100))
	gone, err = s.ExpiredMeetingAudio(base.Add(29 * 24 * time.Hour).UnixMilli())
	require.NoError(t, err)
	require.Empty(t, gone)
	gone, err = s.ExpiredMeetingAudio(base.Add(31 * 24 * time.Hour).UnixMilli())
	require.NoError(t, err)
	require.Equal(t, []MeetingAudioFile{{MeetingID: m.ID, Path: "/x/a.ogg"}}, gone)
	require.NoError(t, s.DropMeetingAudio(m.ID))
	d, err := s.MeetingDetail(m.ID)
	require.NoError(t, err)
	require.False(t, d.HasAudio)
	require.Equal(t, "ready", d.Status)
	require.Len(t, d.Segments, 1, "the transcript is kept")
	require.Error(t, s.SetMeetingStatus(m.ID, "bogus", "", 0))
}

func TestReplaceMeetingNotesKeepsQuorumRows(t *testing.T) {
	s, p := briefingStore(t)
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	require.NoError(t, s.SetMeetingProjection(m.ID, &proto.MeetingNote{Title: "Weekly", Date: "2026-11-20", Decisions: "- ship it"}, 500))
	// the connector seeds (no connector rows yet: first_seen 0) and later syncs without the quorum row
	_, err := s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{{ExternalID: "n1", Title: "Standup", Date: "2026-11-19"}}, 1000)
	require.NoError(t, err)
	ch, err := s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{}, 2000)
	require.NoError(t, err)
	require.True(t, ch)
	ns, err := s.MeetingNotes(p.ID, "")
	require.NoError(t, err)
	require.Len(t, ns, 1)
	require.Equal(t, MeetingNoteID(m.ID), ns[0].ExternalID)
	require.Equal(t, "- ship it", ns[0].Decisions)
	seen, err := s.NotesSeenSince(p.ID, 0)
	require.NoError(t, err)
	require.Len(t, seen, 1)
	require.Equal(t, int64(500), seen[0].FirstSeenAt)
	// a connector note with the same id never overwrites the quorum row
	_, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{{ExternalID: MeetingNoteID(m.ID), Title: "evil"}}, 3000)
	require.NoError(t, err)
	ns, _ = s.MeetingNotes(p.ID, "")
	require.Len(t, ns, 1)
	require.Equal(t, "Weekly", ns[0].Title)
	// the first connector note after only quorum rows exist is still the seeding sync
	_, err = s.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{{ExternalID: "n2", Title: "Retro", Date: "2026-11-21"}}, 4000)
	require.NoError(t, err)
	seen, _ = s.NotesSeenSince(p.ID, 600)
	require.Empty(t, seen)
	// a connector reset drops connector rows only
	pr, err := s.GetProject(p.ID)
	require.NoError(t, err)
	_, err = s.UpdateProjectResetConnector(pr)
	require.NoError(t, err)
	ns, _ = s.MeetingNotes(p.ID, "")
	require.Len(t, ns, 1)
	require.Equal(t, MeetingNoteID(m.ID), ns[0].ExternalID)
	// nil clears the projection
	require.NoError(t, s.SetMeetingProjection(m.ID, nil, 0))
	ns, _ = s.MeetingNotes(p.ID, "")
	require.Empty(t, ns)
}

func TestDeleteMeetingCascades(t *testing.T) {
	s, p := briefingStore(t)
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	other := mkMeeting(t, s, p.ID, "/x/b.ogg")
	require.NoError(t, s.ReplaceMeetingSegments(m.ID, []proto.MeetingSegment{{Text: "a"}, {Text: "b"}}))
	require.NoError(t, s.SetMeetingSummary(m.ID, proto.MeetingSummary{Title: "t", Summary: "s"}))
	_, err := s.db.Exec(`INSERT INTO meeting_actions(meeting_id,id,text) VALUES(?,?,?)`, m.ID, "a1", "do it")
	require.NoError(t, err)
	_, err = s.db.Exec(`INSERT INTO meeting_speakers(meeting_id,label,name) VALUES(?,?,?)`, m.ID, "Speaker 1", "Luis")
	require.NoError(t, err)
	require.NoError(t, s.SetMeetingProjection(m.ID, &proto.MeetingNote{Title: "Weekly"}, 1))
	tok, err := s.CreateMeetingToken("audio", m.ID, "", time.Hour)
	require.NoError(t, err)
	d, err := s.MeetingDetail(m.ID)
	require.NoError(t, err)
	require.Len(t, d.Segments, 2)
	require.Equal(t, "s", d.Summary.Summary)
	require.Len(t, d.Actions, 1)
	require.Equal(t, map[string]string{"Speaker 1": "Luis"}, d.Speakers)

	gone, err := s.DeleteMeeting(m.ID)
	require.NoError(t, err)
	require.Equal(t, "/x/a.ogg", gone.AudioPath)
	require.Equal(t, p.ID, gone.ProjectID)
	_, err = s.MeetingDetail(m.ID)
	require.ErrorIs(t, err, ErrNotFound)
	for _, tbl := range []string{"meeting_audio", "meeting_segments", "meeting_summary", "meeting_actions", "meeting_speakers", "meeting_uploads", "meeting_tokens"} {
		var n int
		require.NoError(t, s.db.QueryRow(`SELECT count(*) FROM `+tbl+` WHERE meeting_id=?`, m.ID).Scan(&n))
		require.Zero(t, n, tbl)
	}
	_, ok, err := s.MeetingToken("audio", tok)
	require.NoError(t, err)
	require.False(t, ok)
	ns, _ := s.MeetingNotes(p.ID, "")
	require.Empty(t, ns)
	_, err = s.MeetingDetail(other.ID)
	require.NoError(t, err, "other meetings stay")
	_, err = s.DeleteMeeting(m.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestPatchMeetingMovesProjection(t *testing.T) {
	s, p := briefingStore(t)
	p2 := mkProject(t, s)
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	require.NoError(t, s.SetMeetingProjection(m.ID, &proto.MeetingNote{Title: "Weekly"}, 1))
	title, lang, proj := "Planning", "en", p2.ID
	got, oldProject, err := s.PatchMeeting(m.ID, MeetingPatch{Title: &title, Language: &lang, ProjectID: &proj})
	require.NoError(t, err)
	require.Equal(t, p.ID, oldProject)
	require.Equal(t, "Planning", got.Title)
	require.Equal(t, "en", got.Language)
	require.Equal(t, p2.ID, got.ProjectID)
	ns, _ := s.MeetingNotes(p.ID, "")
	require.Empty(t, ns)
	ns, _ = s.MeetingNotes(p2.ID, "")
	require.Len(t, ns, 1)
	none := ""
	_, _, err = s.PatchMeeting(m.ID, MeetingPatch{ProjectID: &none})
	require.NoError(t, err)
	ns, _ = s.MeetingNotes(p2.ID, "")
	require.Empty(t, ns, "an unassigned meeting has no projection")
	bad := "nope"
	_, _, err = s.PatchMeeting(m.ID, MeetingPatch{ProjectID: &bad})
	require.ErrorIs(t, err, ErrNoProject)
	ms, err := s.Meetings(MeetingFilter{Unassigned: true})
	require.NoError(t, err)
	require.Len(t, ms, 1)
	ms, err = s.Meetings(MeetingFilter{ProjectID: p.ID})
	require.NoError(t, err)
	require.Empty(t, ms)
}

func TestDeleteProjectUnassignsMeetings(t *testing.T) {
	s, p := briefingStore(t)
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	require.NoError(t, s.DeleteProject(p.ID))
	d, err := s.MeetingDetail(m.ID)
	require.NoError(t, err)
	require.Equal(t, "", d.ProjectID)
}

func TestMeetingTokens(t *testing.T) {
	s, p := briefingStore(t)
	base := time.UnixMilli(1_000_000_000_000)
	s.now = func() time.Time { return base }
	m := mkMeeting(t, s, p.ID, "/x/a.ogg")
	tok, err := s.CreateMeetingToken("audio", m.ID, "job1", time.Hour)
	require.NoError(t, err)
	info, ok, err := s.MeetingToken("audio", tok)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, MeetingTokenInfo{MeetingID: m.ID, Ref: "job1"}, info)
	_, ok, _ = s.MeetingToken("result", tok)
	require.False(t, ok, "another kind")
	_, ok, _ = s.MeetingToken("audio", tok[:len(tok)-1]+"x")
	require.False(t, ok, "a wrong secret")
	_, ok, _ = s.MeetingToken("audio", "garbage")
	require.False(t, ok)
	s.now = func() time.Time { return base.Add(time.Hour) }
	_, ok, _ = s.MeetingToken("audio", tok)
	require.False(t, ok, "expired")
	n, err := s.PruneMeetingTokens(base.Add(time.Hour).UnixMilli())
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
}

func TestExpiredMeetingUploads(t *testing.T) {
	s, _ := briefingStore(t)
	base := time.UnixMilli(1_000_000_000_000)
	s.now = func() time.Time { return base }
	u, err := s.CreateMeetingUpload(MeetingUpload{Size: 10, Path: "/x/u.part"}, nil)
	require.NoError(t, err)
	old, err := s.ExpiredMeetingUploads(base.Add(time.Hour).UnixMilli())
	require.NoError(t, err)
	require.Empty(t, old)
	old, err = s.ExpiredMeetingUploads(base.Add(25 * time.Hour).UnixMilli())
	require.NoError(t, err)
	require.Len(t, old, 1)
	require.Equal(t, u.ID, old[0].ID)
	require.Equal(t, "/x/u.part", old[0].Path)
	require.NoError(t, s.DeleteMeetingUpload(u.ID))
	_, err = s.MeetingUploadByID(u.ID)
	require.ErrorIs(t, err, ErrNotFound)
}
