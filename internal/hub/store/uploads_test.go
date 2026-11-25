package store

import (
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestUploadsRecordedPerSession(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m"}))
	require.NoError(t, s.AddUpload(Upload{SessionID: "a", Path: "/u/x.png", Name: "x.png", Mime: "image/png", Size: 3}))
	u, ok, err := s.UploadOf("a", "/u/x.png")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "image/png", u.Mime)
	require.NotZero(t, u.At)
	_, ok, _ = s.UploadOf("b", "/u/x.png")
	require.False(t, ok)
	_, ok, _ = s.UploadOf("a", "/u/y.png")
	require.False(t, ok)
}

func TestUploadsFollowRename(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m"}))
	require.NoError(t, s.AddUpload(Upload{SessionID: "old", Path: "/u/x.png", Name: "x.png"}))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "new", PreviousID: "old", Machine: "m"}))
	_, ok, _ := s.UploadOf("new", "/u/x.png")
	require.True(t, ok)
	_, ok, _ = s.UploadOf("old", "/u/x.png")
	require.False(t, ok)
}
