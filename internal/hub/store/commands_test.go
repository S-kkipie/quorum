package store

import (
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestSessionCommandsRoundTrip(t *testing.T) {
	s := openMem(t)
	_, ok, err := s.Commands("s1")
	require.NoError(t, err)
	require.False(t, ok)
	list := []proto.SessionCommand{{Name: "clear", Source: "builtin", Group: "session"}, {Name: "after", Source: "plugin", Plugin: "bc", Group: "plugin", TerminalOnly: true}}
	changed, err := s.SaveCommands("s1", "h1", list)
	require.NoError(t, err)
	require.True(t, changed)
	got, ok, err := s.Commands("s1")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, proto.SessionCommands{Session: "s1", Hash: "h1", Commands: list}, got)
	changed, err = s.SaveCommands("s1", "h1", list)
	require.NoError(t, err)
	require.False(t, changed)
	changed, err = s.SaveCommands("s1", "h2", list[:1])
	require.NoError(t, err)
	require.True(t, changed)
	got, _, _ = s.Commands("s1")
	require.Len(t, got.Commands, 1)
	// an empty list is stored as [] and read back non-nil
	_, err = s.SaveCommands("s2", "e", nil)
	require.NoError(t, err)
	got, ok, _ = s.Commands("s2")
	require.True(t, ok)
	require.NotNil(t, got.Commands)
}

func opts(vs ...string) []proto.ModelOption {
	var o []proto.ModelOption
	for _, v := range vs {
		o = append(o, proto.ModelOption{Value: v, Label: v})
	}
	return o
}

func TestModelConfigRoundTripAndKeptWhenOmitted(t *testing.T) {
	s := openMem(t)
	up := func(si proto.SessionInfo) proto.SessionInfo {
		si.ID, si.Machine, si.State = "s1", "m1", proto.StateIdle
		require.NoError(t, s.UpsertSession(si))
		got, err := s.Session("s1")
		require.NoError(t, err)
		return got
	}
	got := up(proto.SessionInfo{Effort: "high", ModelOptions: opts("opus", "sonnet"), EffortOptions: []string{"low", "high"}})
	require.Equal(t, "high", got.Effort)
	require.Equal(t, opts("opus", "sonnet"), got.ModelOptions)
	require.Equal(t, []string{"low", "high"}, got.EffortOptions)
	// an upsert without them (older mod, early register) keeps what is stored
	got = up(proto.SessionInfo{})
	require.Equal(t, "high", got.Effort)
	require.Equal(t, opts("opus", "sonnet"), got.ModelOptions)
	require.Equal(t, []string{"low", "high"}, got.EffortOptions)
	// field by field: new options replace, the rest stays
	got = up(proto.SessionInfo{ModelOptions: opts("haiku")})
	require.Equal(t, opts("haiku"), got.ModelOptions)
	require.Equal(t, "high", got.Effort)
	got = up(proto.SessionInfo{Effort: "low"})
	require.Equal(t, "low", got.Effort)
	require.Equal(t, opts("haiku"), got.ModelOptions)
}

func TestSessionWithoutModelConfigReadsEmptyLists(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	got, _ := s.Session("s1")
	require.NotNil(t, got.ModelOptions)
	require.NotNil(t, got.EffortOptions)
	require.Empty(t, got.ModelOptions)
}

func TestModelCfgMigrationOnExistingDB(t *testing.T) {
	path := t.TempDir() + "/q.db"
	s, err := Open(path)
	require.NoError(t, err)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle, Effort: "max"}))
	_, err = s.db.Exec(`ALTER TABLE sessions DROP COLUMN model_cfg`) // a DB from before Plan 8
	require.NoError(t, err)
	require.NoError(t, s.Close())
	s, err = Open(path)
	require.NoError(t, err)
	defer s.Close()
	got, err := s.Session("s1")
	require.NoError(t, err)
	require.Equal(t, "", got.Effort)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle, Effort: "low"}))
	got, _ = s.Session("s1")
	require.Equal(t, "low", got.Effort)
}

func TestCommandsFollowRenameAndGoWithRemovedSession(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m1", State: proto.StateIdle}))
	_, err := s.SaveCommands("a", "h", []proto.SessionCommand{{Name: "clear"}})
	require.NoError(t, err)
	applied, err := s.SaveSession(proto.SessionInfo{ID: "b", PreviousID: "a", Machine: "m1", State: proto.StateIdle})
	require.NoError(t, err)
	require.Equal(t, "a", applied)
	_, ok, _ := s.Commands("a")
	require.False(t, ok)
	got, ok, _ := s.Commands("b")
	require.True(t, ok)
	require.Equal(t, "b", got.Session)
	// a session closed without ever being prompted is deleted with its list
	removed, err := s.CloseSession("m1", "b")
	require.NoError(t, err)
	require.True(t, removed)
	_, ok, _ = s.Commands("b")
	require.False(t, ok)
}
