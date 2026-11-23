package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func (f *appFx) getEvents(t *testing.T, path string) []proto.Event {
	t.Helper()
	req, _ := http.NewRequest("GET", f.ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	var evs []proto.Event
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&evs))
	return evs
}

func TestBackfillRequestedOncePerMinute(t *testing.T) {
	f := newAppFx(t, "s1")
	clock := time.Unix(1000, 0)
	f.srv.hub.now = func() time.Time { return clock }

	require.Equal(t, []proto.Event{}, f.getEvents(t, "/api/sessions/s1/events"))
	select {
	case env := <-f.backfills:
		require.Equal(t, "s1", env.Session)
		require.Equal(t, "m1", env.Machine)
	case <-time.After(3 * time.Second):
		t.Fatal("history was not requested")
	}
	f.getEvents(t, "/api/sessions/s1/events")
	f.getEvents(t, "/api/sessions/s1/events?before=-5") // pagination: does not trigger
	select {
	case <-f.backfills:
		t.Fatal("second backfill within 60 s")
	case <-time.After(200 * time.Millisecond):
	}
	clock = clock.Add(61 * time.Second)
	f.getEvents(t, "/api/sessions/s1/events")
	select {
	case <-f.backfills:
	case <-time.After(3 * time.Second):
		t.Fatal("not repeated after 60 s")
	}
}

func TestBackfillNotRequestedWithStoredEvents(t *testing.T) {
	f := newAppFx(t, "s1")
	_, err := f.st.AppendEvent(proto.Event{Session: "s1", Kind: proto.KindInfo})
	require.NoError(t, err)
	require.Len(t, f.getEvents(t, "/api/sessions/s1/events"), 1)
	select {
	case <-f.backfills:
		t.Fatal("should not have been requested")
	case <-time.After(200 * time.Millisecond):
	}
}

func userEv(text string, ts int64) proto.Event {
	d, _ := json.Marshal(map[string]string{"text": text})
	return proto.Event{TS: ts, Kind: proto.KindUser, Data: d}
}

func TestBackfillResultStoredAndPublished(t *testing.T) {
	f := newAppFx(t, "s1")
	_, envs := f.live(t)
	evs := []proto.Event{userEv("uno", 1), userEv("dos", 2)}
	p, _ := json.Marshal(evs)
	f.machineSend(t, proto.Envelope{Type: "backfill_result", Session: "s1", Payload: p})
	eventually(t, func() bool { e, _ := f.st.Events("s1", 0, 10); return len(e) == 2 })
	got := f.getEvents(t, "/api/sessions/s1/events")
	require.Len(t, got, 2)
	require.EqualValues(t, -1, got[0].Seq) // newest first
	require.EqualValues(t, -2, got[1].Seq)
	require.Equal(t, "s1", got[0].Session)
	// a single "events" envelope with the whole batch, ascending
	env := waitEnv(t, envs, func(e proto.Envelope) bool { return e.Type == "events" || e.Type == "event" })
	require.Equal(t, "events", env.Type)
	require.Equal(t, "s1", env.Session)
	var batch []proto.Event
	require.NoError(t, json.Unmarshal(env.Payload, &batch))
	var seqs []int64
	for _, ev := range batch {
		seqs = append(seqs, ev.Seq)
	}
	require.Equal(t, []int64{-2, -1}, seqs)
}

// A large history does not disconnect the apps: it goes in a single envelope.
func TestBigBackfillDoesNotOverflowLiveClients(t *testing.T) {
	f := newAppFx(t, "s1")
	_, envs := f.live(t)
	waitEnv(t, envs, func(e proto.Envelope) bool { return e.Type == "session_upsert" }) // end of the snapshot
	evs := make([]proto.Event, 500)
	for i := range evs {
		evs[i] = userEv("x", int64(i))
	}
	p, _ := json.Marshal(evs)
	f.machineSend(t, proto.Envelope{Type: "backfill_result", Session: "s1", Payload: p})
	env := waitEnv(t, envs, func(e proto.Envelope) bool { return e.Type == "events" })
	var batch []proto.Event
	require.NoError(t, json.Unmarshal(env.Payload, &batch))
	require.Len(t, batch, 500)
	f.srv.live.mu.Lock()
	n := len(f.srv.live.clients)
	f.srv.live.mu.Unlock()
	require.Equal(t, 1, n, "the live client is still connected")
}

func TestBackfillResultFromForeignMachineIgnored(t *testing.T) {
	f := newAppFx(t, "s1")
	tok2, _ := NewToken()
	require.NoError(t, f.st.AddToken("machine", "m2", tok2))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c2, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok2}}})
	require.NoError(t, err)
	t.Cleanup(func() { c2.CloseNow() })
	sendHello(t, c2, "m2")
	eventually(t, func() bool { return online2(f.st, "m2") })
	p, _ := json.Marshal([]proto.Event{userEv("intruder", 1)})
	require.NoError(t, wsjson.Write(ctx, c2, proto.Envelope{Type: "backfill_result", Session: "s1", Payload: p}))
	// marker: an own session of m2 arriving later
	require.NoError(t, wsjson.Write(ctx, c2, proto.Envelope{Type: "session_upsert", Session: "s2", Payload: mustJSON(proto.SessionInfo{ID: "s2", State: proto.StateIdle})}))
	eventually(t, func() bool { _, ok, _ := f.st.SessionOwner("s2"); return ok })
	evs, _ := f.st.Events("s1", 0, 10)
	require.Empty(t, evs)
}
