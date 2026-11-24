package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func countType(c *capture, typ string) int {
	n := 0
	for _, t := range c.types() {
		if t == typ {
			n++
		}
	}
	return n
}

func TestSessionUpsertWithRateLimitsPublishesUsageOnce(t *testing.T) {
	f := newFixture(t, "vps-1")
	c := f.dial(t)
	sendHello(t, c, "vps-1")
	eventually(t, func() bool { return online(f, "vps-1") })
	ctx := context.Background()
	at := time.Now().UnixMilli() - 60_000
	si := proto.SessionInfo{ID: "s1", State: proto.StateIdle, Account: "work", UsageAt: at,
		RateLimits: []proto.RateLimit{{Kind: "five_hour", PercentUsed: 42, ResetsAt: "2026-11-23T10:00:00Z"}}}
	send := func(si proto.SessionInfo) {
		require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "session_upsert", Session: si.ID, Payload: mustJSON(si)}))
	}
	send(si)
	eventually(t, func() bool { return countType(f.cap, "usage_upsert") == 1 })
	send(si) // unchanged
	marker := proto.SessionInfo{ID: "s2", State: proto.StateIdle}
	send(marker)
	eventually(t, func() bool { _, ok, _ := f.st.SessionOwner("s2"); return ok })
	require.Equal(t, 1, countType(f.cap, "usage_upsert"))

	// the key falls back to machine/alias, and the REST list serves it
	list, err := f.st.ListUsage(f.srv.hub.now().UnixMilli())
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "vps-1/work", list[0].Key)
	require.Equal(t, 42.0, list[0].FiveHour.Pct)

	si.RateLimits[0].PercentUsed = 43
	si.UsageAt = at + 1000
	send(si)
	eventually(t, func() bool { return countType(f.cap, "usage_upsert") == 2 })
}

func TestUsageRESTListsReports(t *testing.T) {
	_, st, h := newTestServer(t)
	code, err := st.CreateCode("pair")
	require.NoError(t, err)
	tok := tokenFrom(t, do(h, "POST", "/api/pair", `{"code":"`+code+`","deviceName":"tel"}`, nil))
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	require.Equal(t, 401, do(h, "GET", "/api/usage", "", nil).Code)
	rr := do(h, "GET", "/api/usage", "", hdr)
	require.Equal(t, 200, rr.Code)
	require.JSONEq(t, "[]", rr.Body.String())
	_, _, err = st.SaveUsage("abcd", "work", []proto.RateLimit{{Kind: "seven_day", PercentUsed: 7, ResetsAt: "x"}}, time.Now().UnixMilli())
	require.NoError(t, err)
	var got []proto.AccountUsage
	rr = do(h, "GET", "/api/usage", "", hdr)
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Len(t, got, 1)
	require.Equal(t, "abcd", got[0].Key)
	require.Equal(t, 7.0, got[0].SevenDay.Pct)
}

func TestUsageSkippedWhileAccountUnresolved(t *testing.T) {
	f := newFixture(t, "vps-1")
	c := f.dial(t)
	sendHello(t, c, "vps-1")
	eventually(t, func() bool { return online(f, "vps-1") })
	rl := []proto.RateLimit{{Kind: "five_hour", PercentUsed: 5}}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "session_upsert", Session: "s1",
		Payload: mustJSON(proto.SessionInfo{ID: "s1", State: proto.StateIdle, RateLimits: rl, UsageAt: time.Now().UnixMilli()})}))
	eventually(t, func() bool { _, ok, _ := f.st.SessionOwner("s1"); return ok })
	// a later session acts as a marker for ordering
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "session_upsert", Session: "s2",
		Payload: mustJSON(proto.SessionInfo{ID: "s2", State: proto.StateIdle})}))
	eventually(t, func() bool { _, ok, _ := f.st.SessionOwner("s2"); return ok })
	list, err := f.st.ListUsage(f.srv.hub.now().UnixMilli())
	require.NoError(t, err)
	require.Empty(t, list)
	require.Equal(t, 0, countType(f.cap, "usage_upsert"))
}

func TestUsageFallbackRowReplacedWhenKeyResolves(t *testing.T) {
	f := newFixture(t, "vps-1")
	c := f.dial(t)
	sendHello(t, c, "vps-1")
	eventually(t, func() bool { return online(f, "vps-1") })
	ctx := context.Background()
	rl := []proto.RateLimit{{Kind: "five_hour", PercentUsed: 5}}
	send := func(si proto.SessionInfo) {
		require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "session_upsert", Session: si.ID, Payload: mustJSON(si)}))
	}
	at := time.Now().UnixMilli() - 60_000
	send(proto.SessionInfo{ID: "s1", State: proto.StateIdle, Account: "work", RateLimits: rl, UsageAt: at})
	eventually(t, func() bool { return countType(f.cap, "usage_upsert") == 1 })
	list, _ := f.st.ListUsage(f.srv.hub.now().UnixMilli())
	require.Len(t, list, 1)
	require.Equal(t, "vps-1/work", list[0].Key)

	key := "abcdabcdabcdabcd"
	send(proto.SessionInfo{ID: "s1", State: proto.StateIdle, Account: "work", AccountKey: key, RateLimits: rl, UsageAt: at + 1000})
	eventually(t, func() bool { return countType(f.cap, "usage_gone") == 1 })
	list, _ = f.st.ListUsage(f.srv.hub.now().UnixMilli())
	require.Len(t, list, 1)
	require.Equal(t, key, list[0].Key)
	require.Equal(t, 2, countType(f.cap, "usage_upsert"))
}

// Every update re-sends the last rate limits: only a newer usageAt is a new reading.
func TestUsageSavedOnlyForNewerUsageAt(t *testing.T) {
	f := newFixture(t, "vps-1")
	c := f.dial(t)
	sendHello(t, c, "vps-1")
	eventually(t, func() bool { return online(f, "vps-1") })
	ctx := context.Background()
	n := 0
	send := func(pct float64, usageAt int64) {
		n++
		si := proto.SessionInfo{ID: "s1", State: proto.StateIdle, Account: "work", UsageAt: usageAt,
			RateLimits: []proto.RateLimit{{Kind: "five_hour", PercentUsed: pct}}}
		require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "session_upsert", Session: "s1", Payload: mustJSON(si)}))
		// a marker session orders the check after the upsert above
		marker := fmt.Sprintf("m%d", n)
		require.NoError(t, wsjson.Write(ctx, c, proto.Envelope{Type: "session_upsert", Session: marker,
			Payload: mustJSON(proto.SessionInfo{ID: marker, State: proto.StateIdle})}))
		eventually(t, func() bool { _, ok, _ := f.st.SessionOwner(marker); return ok })
	}
	row := func() (proto.AccountUsage, bool) {
		list, err := f.st.ListUsage(f.srv.hub.now().UnixMilli())
		require.NoError(t, err)
		if len(list) == 0 {
			return proto.AccountUsage{}, false
		}
		return list[0], true
	}

	send(10, 0) // never measured: not saved
	_, ok := row()
	require.False(t, ok)

	at := f.srv.hub.now().UnixMilli() - 60_000
	send(20, at)
	u, ok := row()
	require.True(t, ok)
	require.Equal(t, 20.0, u.FiveHour.Pct)
	require.Equal(t, at, u.At) // the measurement time, not the hub's receive time

	send(21, at) // same reading re-sent with another update: ignored
	u, _ = row()
	require.Equal(t, 20.0, u.FiveHour.Pct)
	send(22, at-1000) // older: ignored
	u, _ = row()
	require.Equal(t, 20.0, u.FiveHour.Pct)
	require.Equal(t, 1, countType(f.cap, "usage_upsert"))

	future := f.srv.hub.now().Add(time.Hour).UnixMilli()
	send(30, future) // a skewed clock is clamped to the hub's now
	u, _ = row()
	require.Equal(t, 30.0, u.FiveHour.Pct)
	require.LessOrEqual(t, u.At, f.srv.hub.now().UnixMilli())
}
