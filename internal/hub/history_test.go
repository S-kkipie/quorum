package hub

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestHistoryProxiesAndFiltersTheSeam(t *testing.T) {
	f := newAppFx(t, "s1")
	_, got := fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult(proto.TranscriptPage{
			Events: []proto.Event{{Key: "a", TS: 100, Kind: proto.KindUser}, {Key: "b", TS: 200, Kind: proto.KindUser}, {Key: "c", TS: 300, Kind: proto.KindUser}},
			Cursor: "1234", Done: false,
		})
	})
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	_, err := f.st.AppendEvent(proto.Event{Session: "s1", TS: 200, Kind: proto.KindUser})
	require.NoError(t, err)
	_, err = f.st.AppendEvent(proto.Event{Session: "s1", TS: 400, Kind: proto.KindUser})
	require.NoError(t, err)

	code, body := f.do("GET", "/api/sessions/s1/history?cursor=s99", "")
	require.Equal(t, 200, code, body)
	var page proto.TranscriptPage
	require.NoError(t, json.Unmarshal([]byte(body), &page))
	require.Len(t, page.Events, 1)
	require.Equal(t, "a", page.Events[0].Key)
	require.Equal(t, "1234", page.Cursor)
	require.False(t, page.Done)
	r := <-got
	require.Equal(t, "transcript_page", r.Method)
	var p proto.TranscriptPageParams
	require.NoError(t, json.Unmarshal(r.Params, &p))
	require.Equal(t, "s99", p.Cursor)
	require.Equal(t, "s1", p.Session)
}

func TestHistoryWithoutHubEventsKeepsEverything(t *testing.T) {
	f := newAppFx(t, "s1")
	fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult(proto.TranscriptPage{Events: []proto.Event{{Key: "a", TS: 100}}, Done: true})
	})
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	code, body := f.do("GET", "/api/sessions/s1/history", "")
	require.Equal(t, 200, code, body)
	require.Contains(t, body, `"done":true`)
	require.Contains(t, body, `"key":"a"`)
}

func TestHistoryErrors(t *testing.T) {
	f := newAppFx(t, "s1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	for _, c := range []string{"abc", "-5", "s", "12345678901234567890", "1%3B2", "ss1"} {
		code, _ := f.do("GET", "/api/sessions/s1/history?cursor="+c, "")
		require.Equal(t, 400, code, c)
	}
	code, _ := f.do("GET", "/api/sessions/nope/history", "")
	require.Equal(t, 404, code)
	// A session whose machine is not connected.
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "other", State: proto.StateClosed}))
	code, body := f.do("GET", "/api/sessions/s2/history", "")
	require.Equal(t, 409, code)
	require.Contains(t, body, "Older history is on other, which is offline.")
}

func TestEventsAfterDelta(t *testing.T) {
	f := newAppFx(t, "s1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	var seqs []int64
	for i := 0; i < 5; i++ {
		seq, err := f.st.AppendEvent(proto.Event{Session: "s1", TS: int64(i + 1), Kind: proto.KindUser})
		require.NoError(t, err)
		seqs = append(seqs, seq)
	}
	code, body := f.do("GET", "/api/sessions/s1/events?after="+itoa(seqs[1])+"&limit=2", "")
	require.Equal(t, 200, code, body)
	var evs []proto.Event
	require.NoError(t, json.Unmarshal([]byte(body), &evs))
	require.Len(t, evs, 2)
	require.Equal(t, seqs[2], evs[0].Seq)
	require.Equal(t, seqs[3], evs[1].Seq)
	code, body = f.do("GET", "/api/sessions/s1/events?after="+itoa(seqs[4]), "")
	require.Equal(t, 200, code)
	require.JSONEq(t, `[]`, body)
	code, _ = f.do("GET", "/api/sessions/s1/events?after=x", "")
	require.Equal(t, 400, code)
}

func TestRetentionLoopWithFakeClock(t *testing.T) {
	st, err := store.Open(":memory:")
	require.NoError(t, err)
	defer st.Close()
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m", State: proto.StateClosed}))
	_, err = st.AppendEvent(proto.Event{Session: "old", Kind: proto.KindUser, TS: 1})
	require.NoError(t, err)
	require.NoError(t, st.SetHistoryOK("old")) // served or not: only the 90 days count
	// The session closed "now" in real time; the fake clock moves 31, then 91 days ahead.
	var mu sync.Mutex
	fake := time.Now().AddDate(0, 0, 31)
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return fake }
	ticks := make(chan time.Time)
	var waits []time.Duration
	asked := make(chan struct{}, 4)
	after := func(d time.Duration) <-chan time.Time { waits = append(waits, d); asked <- struct{}{}; return ticks }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { runRetention(ctx, st, "", clock, after); close(done) }()
	<-asked
	ticks <- clock()
	<-asked // the first prune finished: 31 days is within Claude Code's own cleanup, keep
	evs, err := st.Events("old", 0, 10)
	require.NoError(t, err)
	require.Len(t, evs, 1)
	mu.Lock()
	fake = time.Now().AddDate(0, 0, 91)
	mu.Unlock()
	ticks <- clock()
	<-asked
	evs, err = st.Events("old", 0, 10)
	require.NoError(t, err)
	require.Empty(t, evs)
	cancel()
	<-done
	require.Equal(t, []time.Duration{time.Minute, 24 * time.Hour, 24 * time.Hour}, waits)
}

func TestHistoryMapsDaemonErrors(t *testing.T) {
	f := newAppFx(t, "s1")
	var reply atomic.Value
	fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return &proto.RPCResult{Error: reply.Load().(string)}
	})
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateClosed}))
	for _, c := range []struct {
		daemon string
		code   int
		msg    string
	}{
		{"unknown session", 404, "No older history on the machine."},
		{"the session has no readable transcript", 404, "No older history on the machine."},
		{"invalid cursor", 400, "invalid cursor"},
		{"unknown method", 404, "Update quorumd on m1 to load older history."},
		{"could not read the file", 502, "could not read the file"},
	} {
		reply.Store(c.daemon)
		code, body := f.do("GET", "/api/sessions/s1/history", "")
		require.Equal(t, c.code, code, c.daemon)
		require.Contains(t, body, c.msg, c.daemon)
	}
}

func TestHistoryPassesBeforeTSAndRecordsSuccess(t *testing.T) {
	f := newAppFx(t, "s1")
	_, got := fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult(proto.TranscriptPage{Events: []proto.Event{{Key: "a", TS: 100}}, Done: true})
	})
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	for i := 0; i < 2000; i++ {
		_, err := f.st.AppendEvent(proto.Event{Session: "s1", TS: int64(5000 + i), Kind: proto.KindUser})
		require.NoError(t, err)
	}
	ok, err := f.st.HistoryOK("s1")
	require.NoError(t, err)
	require.False(t, ok)
	code, body := f.do("GET", "/api/sessions/s1/history", "")
	require.Equal(t, 200, code, body)
	require.Contains(t, body, `"key":"a"`) // the first machine page already brings older events
	var p proto.TranscriptPageParams
	require.NoError(t, json.Unmarshal((<-got).Params, &p))
	require.EqualValues(t, 5000, p.BeforeTS)
	ok, err = f.st.HistoryOK("s1")
	require.NoError(t, err)
	require.True(t, ok)
}

func TestHistoryDropsSkewedDuplicatesAtTheSeam(t *testing.T) {
	f := newAppFx(t, "s1")
	tool := func(name, sum string) json.RawMessage { return mustJSON(proto.ToolStart{Name: name, Summary: sum}) }
	text := func(s string) json.RawMessage { return mustJSON(map[string]string{"text": s}) }
	fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult(proto.TranscriptPage{Events: []proto.Event{
			{Key: "old", TS: 1000, Kind: proto.KindUser, Data: text("hello")},       // 9 s before: kept
			{Key: "dup", TS: 9000, Kind: proto.KindUser, Data: text("hello")},       // 1 s skew: dropped
			{Key: "other", TS: 9500, Kind: proto.KindUser, Data: text("different")}, // other text: kept
			{Key: "kind", TS: 9600, Kind: proto.KindAssistant, Data: text("hello")}, // other kind: kept
			{Key: "tool", TS: 9700, Kind: proto.KindToolStart, Data: tool("Bash", "ls")},
			{Key: "tool2", TS: 9800, Kind: proto.KindToolStart, Data: tool("Bash", "pwd")},
		}, Done: true})
	})
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle}))
	for _, e := range []proto.Event{
		{Session: "s1", TS: 10000, Kind: proto.KindUser, Data: text("hello")},
		{Session: "s1", TS: 12000, Kind: proto.KindToolStart, Data: tool("Bash", "ls")},
	} {
		_, err := f.st.AppendEvent(e)
		require.NoError(t, err)
	}
	code, body := f.do("GET", "/api/sessions/s1/history", "")
	require.Equal(t, 200, code, body)
	var page proto.TranscriptPage
	require.NoError(t, json.Unmarshal([]byte(body), &page))
	var keys []string
	for _, e := range page.Events {
		keys = append(keys, e.Key)
	}
	require.Equal(t, []string{"old", "other", "kind", "tool2"}, keys)
}
