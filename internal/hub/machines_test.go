package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

type fakeTimer struct {
	at      time.Time
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { t.stopped = true; return true }

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func (c *fakeClock) afterFunc(d time.Duration, f func()) stopper {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var due []*fakeTimer
	for _, t := range c.timers {
		if !t.stopped && !t.at.After(c.now) {
			t.stopped = true
			due = append(due, t)
		}
	}
	c.mu.Unlock()
	for _, t := range due {
		t.f()
	}
}

type capture struct {
	mu   sync.Mutex
	envs []proto.Envelope
}

func (c *capture) Publish(e proto.Envelope) { c.mu.Lock(); c.envs = append(c.envs, e); c.mu.Unlock() }
func (c *capture) types() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, e := range c.envs {
		out = append(out, e.Type)
	}
	return out
}

type fixture struct {
	srv   *Server
	st    *store.Store
	url   string
	token string
	clock *fakeClock
	cap   *capture
}

func newFixture(t *testing.T, machine string) *fixture {
	t.Helper()
	s, st, h := newTestServer(t)
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	tok, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, st.AddToken("machine", machine, tok))
	f := &fixture{srv: s, st: st, url: "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/machine/ws", token: tok,
		clock: &fakeClock{now: time.Unix(1000, 0)}, cap: &capture{}}
	s.hub.afterFunc = f.clock.afterFunc
	s.hub.SetBroadcaster(f.cap)
	return f
}

func (f *fixture) dial(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, f.url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.token}}})
	require.NoError(t, err)
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func sendHello(t *testing.T, c *websocket.Conn, machine string, ids ...string) {
	t.Helper()
	h := proto.MachineHello{Machine: machine, OS: "linux", Env: "linux", Version: proto.Version}
	for _, id := range ids {
		h.Sessions = append(h.Sessions, proto.SessionInfo{ID: id, Machine: machine, State: proto.StateIdle})
	}
	p := mustJSON(h)
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "hello", Machine: machine, Payload: p}))
}

func eventually(t *testing.T, f func() bool) {
	t.Helper()
	require.Eventually(t, f, 3*time.Second, 10*time.Millisecond)
}

func online(f *fixture, name string) bool {
	ms, _ := f.st.ListMachines()
	for _, m := range ms {
		if m.Name == name {
			return m.Online
		}
	}
	return false
}

func TestHelloRegistersMachineAndSessions(t *testing.T) {
	f := newFixture(t, "m1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m1", State: proto.StateIdle}))
	c := f.dial(t)
	sendHello(t, c, "m1", "s1", "s2")
	eventually(t, func() bool { return online(f, "m1") })
	eventually(t, func() bool { l, _ := f.st.ListSessions(false); return len(l) == 2 })
	l, _ := f.st.ListSessions(false)
	for _, s := range l {
		require.Equal(t, "m1", s.Machine)
		require.NotEqual(t, "old", s.ID)
	}
	// the apps do not listen to hello: the closed one comes out as session_gone and the current ones as session_upsert
	eventually(t, func() bool { return len(f.cap.types()) >= 4 })
	require.Equal(t, []string{"session_gone", "session_upsert", "session_upsert", "machine_status"}, f.cap.types()[:4])
	require.Equal(t, "old", f.cap.envs[0].Session)
}

func TestAuthenticatedNameOverridesHello(t *testing.T) {
	f := newFixture(t, "real")
	c := f.dial(t)
	sendHello(t, c, "fake", "s1")
	eventually(t, func() bool { return online(f, "real") })
	require.False(t, online(f, "fake"))
	eventually(t, func() bool { l, _ := f.st.ListSessions(false); return len(l) == 1 })
	l, _ := f.st.ListSessions(false)
	require.Equal(t, "real", l[0].Machine)
}

func TestSessionMessagesStoredAndPublished(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	ev := proto.Event{Session: "s1", TS: 5, Kind: proto.KindInfo}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(ev)}))
	dl := proto.Event{Session: "s1", TS: 6, Kind: proto.KindAssistantDelta}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(dl)}))
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "session_gone", Session: "s1"}))
	eventually(t, func() bool { l, _ := f.st.ListSessions(false); return len(l) == 0 })
	evs, _ := f.st.Events("s1", 0, 10)
	require.Len(t, evs, 1)
	require.Equal(t, []string{"session_upsert", "machine_status", "event", "event", "session_gone"}, f.cap.types())
}

func TestOfflineAfterGrace(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	c.Close(websocket.StatusNormalClosure, "")
	eventually(t, func() bool { f.clock.mu.Lock(); defer f.clock.mu.Unlock(); return len(f.clock.timers) == 1 })
	f.clock.advance(59 * time.Second)
	require.True(t, online(f, "m1"))
	f.clock.advance(2 * time.Second)
	require.False(t, online(f, "m1"))
	l, _ := f.st.ListSessions(false)
	require.Empty(t, l)
	ts := f.cap.types()
	require.Equal(t, "machine_status", ts[len(ts)-1])
}

func TestReconnectWithinGraceCancelsOffline(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	c.Close(websocket.StatusNormalClosure, "")
	eventually(t, func() bool { f.clock.mu.Lock(); defer f.clock.mu.Unlock(); return len(f.clock.timers) == 1 })
	c2 := f.dial(t)
	sendHello(t, c2, "m1", "s1")
	eventually(t, func() bool { return len(f.cap.types()) >= 4 })
	f.clock.advance(120 * time.Second)
	require.True(t, online(f, "m1"))
}

func TestNewConnectionReplacesOld(t *testing.T) {
	f := newFixture(t, "m1")
	c1 := f.dial(t)
	sendHello(t, c1, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	c2 := f.dial(t)
	sendHello(t, c2, "m1", "s1")

	// c1 is left closed with normal state
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var env proto.Envelope
	var err error
	for err == nil {
		err = wsjson.Read(ctx, c1, &env)
	}
	require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))

	// messages arrive through c2 and c1 dropping does not trigger the grace period
	eventually(t, func() bool { return f.srv.hub.SendToMachine("m1", proto.Envelope{Type: "command", Session: "s1"}) })
	for env.Type != "command" {
		env = proto.Envelope{}
		require.NoError(t, wsjson.Read(ctx, c2, &env))
	}
	f.clock.mu.Lock()
	require.Empty(t, f.clock.timers)
	f.clock.mu.Unlock()
}

func TestSendToMachineNotConnected(t *testing.T) {
	f := newFixture(t, "m1")
	require.False(t, f.srv.hub.SendToMachine("m1", proto.Envelope{Type: "command"}))
}

func TestMachineWSRequiresToken(t *testing.T) {
	f := newFixture(t, "m1")
	f.token = "bad"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, f.url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer bad"}}})
	require.Error(t, err)
	require.Equal(t, 401, resp.StatusCode)
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestReplacedConnectionMessagesIgnored(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	stale := &machineConn{name: "m1"} // a connection that is no longer the current one
	ev := proto.Event{Session: "s1", TS: 1, Kind: proto.KindInfo}
	f.srv.hub.onMessage(stale, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(ev)})
	f.srv.hub.onMessage(stale, proto.Envelope{Type: "session_gone", Session: "s1"})
	evs, _ := f.st.Events("s1", 0, 10)
	require.Empty(t, evs)
	l, _ := f.st.ListSessions(false)
	require.Len(t, l, 1)
}

func TestMachineCannotTouchOtherMachinesSessions(t *testing.T) {
	f := newFixture(t, "m1")
	tok2, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, f.st.AddToken("machine", "m2", tok2))

	c1 := f.dial(t)
	sendHello(t, c1, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })

	f.token = tok2
	c2 := f.dial(t)
	sendHello(t, c2, "m2")
	eventually(t, func() bool { return online(f, "m2") })
	ctx := context.Background()
	steal := proto.SessionInfo{ID: "s1", Machine: "m2", State: proto.StateWorking}
	require.NoError(t, wsjson.Write(ctx, c2, proto.Envelope{Type: "session_upsert", Session: "s1", Payload: mustJSON(steal)}))
	require.NoError(t, wsjson.Write(ctx, c2, proto.Envelope{Type: "event", Session: "s1", Payload: mustJSON(proto.Event{Session: "s1", Kind: proto.KindInfo})}))
	require.NoError(t, wsjson.Write(ctx, c2, proto.Envelope{Type: "session_gone", Session: "s1"}))
	// a new session serves as a marker: when it arrives, everything before it has been processed
	own := proto.SessionInfo{ID: "s2", State: proto.StateIdle}
	require.NoError(t, wsjson.Write(ctx, c2, proto.Envelope{Type: "session_upsert", Session: "s2", Payload: mustJSON(own)}))
	eventually(t, func() bool { o, ok, _ := f.st.SessionOwner("s2"); return ok && o == "m2" })

	l, _ := f.st.ListSessions(false)
	byID := map[string]proto.SessionInfo{}
	for _, s := range l {
		byID[s.ID] = s
	}
	require.Equal(t, "m1", byID["s1"].Machine)
	require.Equal(t, proto.StateIdle, byID["s1"].State)
	evs, _ := f.st.Events("s1", 0, 10)
	require.Empty(t, evs)
}

func TestStaleExpireDoesNotMarkOffline(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	sendHello(t, c, "m1", "s1")
	eventually(t, func() bool { return online(f, "m1") })
	c.Close(websocket.StatusNormalClosure, "")
	eventually(t, func() bool { f.clock.mu.Lock(); defer f.clock.mu.Unlock(); return len(f.clock.timers) == 1 })
	f.srv.hub.mu.Lock()
	oldGen := f.srv.hub.gens["m1"]
	f.srv.hub.mu.Unlock()
	c2 := f.dial(t)
	sendHello(t, c2, "m1", "s1")
	eventually(t, func() bool { return len(f.cap.types()) >= 4 })
	f.srv.hub.expire("m1", oldGen) // the old timer arrives late
	require.True(t, online(f, "m1"))
	l, _ := f.st.ListSessions(false)
	require.Len(t, l, 1)
}

func TestHelloCannotStealOtherMachinesSession(t *testing.T) {
	f := newFixture(t, "A")
	tokB, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, f.st.AddToken("machine", "B", tokB))
	ca := f.dial(t)
	sendHello(t, ca, "A", "s1")
	eventually(t, func() bool { l, _ := f.st.ListSessions(false); return len(l) == 1 })

	f.token = tokB
	cb := f.dial(t)
	sendHello(t, cb, "B", "s1", "s2")
	eventually(t, func() bool { o, ok, _ := f.st.SessionOwner("s2"); return ok && o == "B" })
	o, _, _ := f.st.SessionOwner("s1")
	require.Equal(t, "A", o)
	l, _ := f.st.ListSessions(false)
	require.Len(t, l, 2) // s1 of A is still open
	// a second hello from B without s1 does not close it either
	cb2 := f.dial(t)
	sendHello(t, cb2, "B", "s2")
	eventually(t, func() bool { return len(f.cap.types()) >= 6 })
	l, _ = f.st.ListSessions(false)
	require.Len(t, l, 2)
}

func lastStatusHerdr(f *fixture) (herdr bool, n int) {
	f.cap.mu.Lock()
	defer f.cap.mu.Unlock()
	for _, e := range f.cap.envs {
		if e.Type != "machine_status" {
			continue
		}
		var m struct {
			Caps struct {
				Herdr bool `json:"herdr"`
			} `json:"caps"`
		}
		_ = json.Unmarshal(e.Payload, &m)
		herdr = m.Caps.Herdr
		n++
	}
	return
}

func TestHelloAndCapsUpdatePublishStatus(t *testing.T) {
	f := newFixture(t, "m1")
	c := f.dial(t)
	hello := proto.MachineHello{Machine: "m1", OS: "linux", Env: "linux", Version: proto.Version, Caps: proto.MachineCaps{Herdr: true}}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "hello", Machine: "m1", Payload: mustJSON(hello)}))
	eventually(t, func() bool { h, n := lastStatusHerdr(f); return n == 1 && h })
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "caps", Machine: "m1", Payload: mustJSON(proto.MachineCaps{Herdr: false})}))
	eventually(t, func() bool { h, n := lastStatusHerdr(f); return n == 2 && !h })
}
