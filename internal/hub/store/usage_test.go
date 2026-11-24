package store

import (
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func lim(five, seven float64) []proto.RateLimit {
	return []proto.RateLimit{
		{Kind: "five_hour", PercentUsed: five, ResetsAt: "2026-11-23T10:00:00Z"},
		{Kind: "seven_day", PercentUsed: seven, ResetsAt: "2026-11-27T10:00:00Z"},
	}
}

func TestUsageKeyFallsBackToMachineAndAlias(t *testing.T) {
	require.Equal(t, "abcd", UsageKey("vps-1", proto.SessionInfo{Account: "work", AccountKey: "abcd"}))
	require.Equal(t, "vps-1/work", UsageKey("vps-1", proto.SessionInfo{Account: "work"}))
}

func TestUsageSameKeyTwoMachinesOneRowNewestWins(t *testing.T) {
	s := openMem(t)
	u, changed, err := s.SaveUsage("abcd", "work", lim(10, 20), 100)
	require.NoError(t, err)
	require.True(t, changed)
	require.Equal(t, 10.0, u.FiveHour.Pct)
	_, changed, err = s.SaveUsage("abcd", "personal-test", lim(30, 40), 200)
	require.NoError(t, err)
	require.True(t, changed)
	// an older report does not overwrite
	_, changed, err = s.SaveUsage("abcd", "work", lim(1, 2), 150)
	require.NoError(t, err)
	require.False(t, changed)
	list, err := s.ListUsage(200)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "personal-test", list[0].Alias)
	require.Equal(t, 30.0, list[0].FiveHour.Pct)
	require.Equal(t, 40.0, list[0].SevenDay.Pct)
	require.EqualValues(t, 200, list[0].At)
}

func TestUsageUnchangedReportIsNotAChange(t *testing.T) {
	s := openMem(t)
	_, _, err := s.SaveUsage("k", "work", lim(10, 20), 100)
	require.NoError(t, err)
	_, changed, err := s.SaveUsage("k", "work", lim(10, 20), 200)
	require.NoError(t, err)
	require.False(t, changed)
	list, _ := s.ListUsage(200)
	require.EqualValues(t, 200, list[0].At) // freshness still advances
}

func TestUsageSameAtIsIgnored(t *testing.T) {
	s := openMem(t)
	_, _, err := s.SaveUsage("k", "work", lim(10, 20), 100)
	require.NoError(t, err)
	u, changed, err := s.SaveUsage("k", "work", lim(50, 60), 100)
	require.NoError(t, err)
	require.False(t, changed)
	require.Equal(t, 10.0, u.FiveHour.Pct)
	list, _ := s.ListUsage(200)
	require.Equal(t, 10.0, list[0].FiveHour.Pct)
}

func TestUsagePartialReportKeepsOtherWindow(t *testing.T) {
	s := openMem(t)
	_, _, err := s.SaveUsage("k", "work", lim(10, 20), 100)
	require.NoError(t, err)
	u, changed, err := s.SaveUsage("k", "work", lim(15, 20)[:1], 200)
	require.NoError(t, err)
	require.True(t, changed)
	require.Equal(t, 15.0, u.FiveHour.Pct)
	require.Equal(t, 20.0, u.SevenDay.Pct)
}

func TestUsageListExcludesOldRows(t *testing.T) {
	s := openMem(t)
	day := int64(24 * 3600 * 1000)
	_, _, _ = s.SaveUsage("old", "work", lim(1, 1), 1000)
	_, _, _ = s.SaveUsage("new", "work", lim(2, 2), 1000+6*day)
	list, err := s.ListUsage(1000 + 8*day)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "new", list[0].Key)
}

func TestSessionPluginFieldsRoundTrip(t *testing.T) {
	s := openMem(t)
	in := proto.SessionInfo{ID: "a", Machine: "vps-1", State: proto.StateIdle, Account: "work", AccountKey: "abcd",
		ConfigDir: "/cfg", Plugins: []string{"after", "use-haiku"}, ContextEstimate: true,
		Tokens: proto.TokenCount{In: 1, Out: 2, Cache: 3}}
	require.NoError(t, s.UpsertSession(in))
	got, err := s.Session("a")
	require.NoError(t, err)
	require.Equal(t, in.Account, got.Account)
	require.Equal(t, in.AccountKey, got.AccountKey)
	require.Equal(t, in.ConfigDir, got.ConfigDir)
	require.Equal(t, in.Plugins, got.Plugins)
	require.True(t, got.ContextEstimate)
	require.Equal(t, in.Tokens, got.Tokens)
	in.Plugins, in.ContextEstimate, in.Tokens.Out = nil, false, 9
	require.NoError(t, s.UpsertSession(in))
	l, _ := s.ListSessions(false)
	require.Equal(t, []string{"after", "use-haiku"}, l[0].Plugins) // empty keeps the stored list
	require.False(t, l[0].ContextEstimate)
	require.Equal(t, 9, l[0].Tokens.Out)
}

func TestSessionUpsertKeepsStoredAccountFieldsWhenEmpty(t *testing.T) {
	s := openMem(t)
	in := proto.SessionInfo{ID: "a", Machine: "vps-1", State: proto.StateIdle, Account: "work", AccountKey: "abcd",
		ConfigDir: "/cfg", Plugins: []string{"after"}, Tokens: proto.TokenCount{Out: 1}}
	require.NoError(t, s.UpsertSession(in))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "vps-1", State: proto.StateIdle, Tokens: proto.TokenCount{Out: 5}}))
	got, _ := s.Session("a")
	require.Equal(t, "work", got.Account)
	require.Equal(t, "abcd", got.AccountKey)
	require.Equal(t, "/cfg", got.ConfigDir)
	require.Equal(t, []string{"after"}, got.Plugins)
	require.Equal(t, 5, got.Tokens.Out)
}
