package store

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func pushStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	require.NoError(t, s.AddToken("device", "phone", "tok-phone"))
	require.NoError(t, s.AddToken("device", "tablet", "tok-tablet"))
	return s
}

func TestPushTokensRoundTrip(t *testing.T) {
	s := pushStore(t)
	require.NoError(t, s.AddPushToken("phone", "fcm-1", "android"))
	require.NoError(t, s.AddPushToken("phone", "fcm-1", "android")) // re-registering is fine
	require.NoError(t, s.AddPushToken("tablet", "fcm-2", "android"))
	ts, err := s.PushTokens()
	require.NoError(t, err)
	require.ElementsMatch(t, []PushToken{{Device: "phone", Token: "fcm-1", Platform: "android"}, {Device: "tablet", Token: "fcm-2", Platform: "android"}}, ts)

	// a token that moves to another device (phone re-paired) belongs to the new one
	require.NoError(t, s.AddPushToken("tablet", "fcm-1", "android"))
	ts, _ = s.PushTokens()
	require.Len(t, ts, 2)
	for _, p := range ts {
		require.Equal(t, "tablet", p.Device)
	}

	// a device only removes its own tokens
	require.NoError(t, s.DeletePushToken("phone", "fcm-2"))
	ts, _ = s.PushTokens()
	require.Len(t, ts, 2)
	require.NoError(t, s.DeletePushToken("tablet", "fcm-2"))
	ts, _ = s.PushTokens()
	require.Equal(t, []PushToken{{Device: "tablet", Token: "fcm-1", Platform: "android"}}, ts)

	// FCM said the token is gone
	require.NoError(t, s.ForgetPushToken("fcm-1"))
	ts, _ = s.PushTokens()
	require.Empty(t, ts)
}

func TestRevokingADeviceDropsItsPushTokens(t *testing.T) {
	s := pushStore(t)
	require.NoError(t, s.AddPushToken("phone", "fcm-1", "android"))
	require.NoError(t, s.AddPushToken("phone", "fcm-3", "android"))
	require.NoError(t, s.AddPushToken("tablet", "fcm-2", "android"))
	require.NoError(t, s.RevokeToken("device", "phone"))
	ts, err := s.PushTokens()
	require.NoError(t, err)
	require.Equal(t, []PushToken{{Device: "tablet", Token: "fcm-2", Platform: "android"}}, ts)
	var n int
	require.NoError(t, s.db.QueryRow(`SELECT count(*) FROM push_tokens WHERE device_id='phone'`).Scan(&n))
	require.Zero(t, n, "the rows are gone, not just hidden")

	// revoking a machine with the same name never touches device tokens
	require.NoError(t, s.AddToken("machine", "tablet", "tok-m"))
	require.NoError(t, s.RevokeToken("machine", "tablet"))
	ts, _ = s.PushTokens()
	require.Len(t, ts, 1)
}

func TestPushTokensSurviveReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "h.db")
	s, err := Open(path)
	require.NoError(t, err)
	require.NoError(t, s.AddToken("device", "phone", "tok"))
	require.NoError(t, s.AddPushToken("phone", "fcm-1", "android"))
	require.NoError(t, s.Close())
	s, err = Open(path)
	require.NoError(t, err)
	defer s.Close()
	ts, err := s.PushTokens()
	require.NoError(t, err)
	require.Len(t, ts, 1)
	require.NoError(t, s.RevokeToken("device", "phone"))
	ts, _ = s.PushTokens()
	require.Empty(t, ts, "the revoke cascade works after a reopen")
}

func TestSessionOpenAsk(t *testing.T) {
	s := pushStore(t)
	saveState(t, s, "s1", proto.StateNeedsYou)
	ev, err := s.SessionOpenAsk("s1")
	require.NoError(t, err)
	require.Nil(t, ev)
	ask := func(id, tool string) {
		_, err := s.AppendEvent(proto.Event{Session: "s1", Kind: proto.KindAsk, Data: mustRaw(proto.Ask{AskID: id, Kind: "permission", Tool: tool})})
		require.NoError(t, err)
	}
	ask("a1", "Bash")
	ask("a2", "Edit")
	ev, err = s.SessionOpenAsk("s1")
	require.NoError(t, err)
	require.NotNil(t, ev)
	var a proto.Ask
	require.NoError(t, json.Unmarshal(ev.Data, &a))
	require.Equal(t, "a2", a.AskID, "the latest open ask")
	_, err = s.AppendEvent(proto.Event{Session: "s1", Kind: proto.KindAskResolved, Data: mustRaw(proto.AskResolved{AskID: "a2", By: "terminal"})})
	require.NoError(t, err)
	ev, _ = s.SessionOpenAsk("s1")
	require.NoError(t, json.Unmarshal(ev.Data, &a))
	require.Equal(t, "a1", a.AskID)
}

func mustRaw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
