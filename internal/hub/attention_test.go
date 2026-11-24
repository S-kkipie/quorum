package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

type attFx struct {
	*fixture
	c *websocket.Conn
}

func newAttFx(t *testing.T, ids ...string) *attFx {
	t.Helper()
	f := newFixture(t, "vps-1")
	c := f.dial(t)
	sendHello(t, c, "vps-1", ids...)
	eventually(t, func() bool { return online(f, "vps-1") })
	return &attFx{fixture: f, c: c}
}

func (f *attFx) state(t *testing.T, id string, st proto.SessionState) {
	t.Helper()
	require.NoError(t, wsjson.Write(context.Background(), f.c, upsertEnv(id, "", st)))
}

func (f *attFx) event(t *testing.T, id string, k proto.EventKind, data any) {
	t.Helper()
	ev := proto.Event{Session: id, Kind: k, Data: mustJSON(data)}
	require.NoError(t, wsjson.Write(context.Background(), f.c, proto.Envelope{Type: "event", Session: id, Payload: mustJSON(ev)}))
}

// sync waits until the hub processed everything sent so far (a marker session shows up).
func (f *attFx) sync(t *testing.T) {
	t.Helper()
	id := "marker-" + time.Now().Format("150405.000000000")
	f.state(t, id, proto.StateWorking)
	eventually(t, func() bool { _, ok, _ := f.st.SessionOwner(id); return ok })
}

func (f *attFx) attentions() []proto.Attention {
	f.cap.mu.Lock()
	defer f.cap.mu.Unlock()
	var out []proto.Attention
	for _, e := range f.cap.envs {
		if e.Type == "attention" {
			var a proto.Attention
			_ = json.Unmarshal(e.Payload, &a)
			out = append(out, a)
		}
	}
	return out
}

// lastUpsert returns the last session_upsert published for id.
func (f *attFx) lastUpsert(t *testing.T, id string) proto.SessionInfo {
	t.Helper()
	f.cap.mu.Lock()
	defer f.cap.mu.Unlock()
	for i := len(f.cap.envs) - 1; i >= 0; i-- {
		if e := f.cap.envs[i]; e.Type == "session_upsert" && e.Session == id {
			var si proto.SessionInfo
			require.NoError(t, json.Unmarshal(e.Payload, &si))
			return si
		}
	}
	t.Fatalf("no session_upsert for %s", id)
	return proto.SessionInfo{}
}

func (f *attFx) seen(t *testing.T, id string, seq int64) int {
	t.Helper()
	tok, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, f.st.AddToken("device", "phone", tok))
	base := "http" + strings.TrimSuffix(strings.TrimPrefix(f.url, "ws"), "/api/machine/ws")
	req, _ := http.NewRequest("POST", base+"/api/sessions/"+id+"/seen", strings.NewReader(`{"seq":`+itoa(seq)+`}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	return resp.StatusCode
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestDoneAttentionOncePerTurnEnd(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.state(t, "s1", proto.StateIdle) // re-sent right after turn_end
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread, "the upsert carries the hub's unread")
	require.Empty(t, f.attentions(), "done waits for the grace period")
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 1)
	a := f.attentions()[0]
	require.Equal(t, "s1", a.Session)
	require.Equal(t, "done", a.Kind)
	require.NotZero(t, a.At)
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 1, "the same end_seq never fires twice")

	// a second turn ends: one more
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 2)
}

func TestTurnEndAfterIdlePublishesUnread(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateIdle) // the state arrived before the turn_end
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 1)
}

func TestBackgroundNeverDoneUntilIdle(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateBackground)
	f.sync(t)
	require.False(t, f.lastUpsert(t, "s1").Unread)
	f.clock.advance(doneGrace)
	require.Empty(t, f.attentions())
	f.state(t, "s1", proto.StateIdle) // the re-check found nothing pending
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 1)
}

func TestSeenWithinGraceSuppressesDone(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	evs, _ := f.st.Events("s1", 0, 1)
	require.Equal(t, 204, f.seen(t, "s1", evs[0].Seq))
	require.False(t, f.lastUpsert(t, "s1").Unread, "seen publishes the session")
	f.clock.advance(doneGrace)
	require.Empty(t, f.attentions(), "the owner was looking at it")
	si, _ := f.st.Session("s1")
	require.False(t, si.Unread)
}

func TestSeenEndpointErrors(t *testing.T) {
	f := newAttFx(t, "s1")
	require.Equal(t, 404, f.seen(t, "nope", 1))
	require.Equal(t, 204, f.seen(t, "s1", 0)) // nothing to move: still fine
}

func TestTerminalPromptMarksSeenDevicePromptDoesNot(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	f.event(t, "s1", proto.KindUser, map[string]any{"text": "from the phone", "device": true})
	f.sync(t)
	si, _ := f.st.Session("s1")
	require.True(t, si.Unread, "a device prompt is not a terminal visit")
	f.event(t, "s1", proto.KindUser, map[string]any{"text": "typed here"})
	f.sync(t)
	si, _ = f.st.Session("s1")
	require.False(t, si.Unread)
	require.False(t, f.lastUpsert(t, "s1").Unread, "the cleared unread reaches the apps")
	f.clock.advance(doneGrace)
	require.Empty(t, f.attentions())
}

func TestNeedsYouAttentionOncePerTransition(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateNeedsYou)
	f.state(t, "s1", proto.StateNeedsYou)
	f.sync(t)
	require.Len(t, f.attentions(), 1)
	require.Equal(t, "needs_you", f.attentions()[0].Kind)
	f.state(t, "s1", proto.StateWorking)
	f.state(t, "s1", proto.StateNeedsYou)
	f.sync(t)
	require.Len(t, f.attentions(), 2)
}

func TestReconnectDoesNotReplayAttention(t *testing.T) {
	f := newAttFx(t, "s1", "s2")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.state(t, "s2", proto.StateNeedsYou)
	f.sync(t)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 2)

	// the daemon reconnects with the same sessions (s1 still unread, s2 still asking)
	f.c.Close(websocket.StatusNormalClosure, "")
	c := f.dial(t)
	h := proto.MachineHello{Machine: "vps-1", OS: "linux", Env: "linux", Version: proto.Version, Sessions: []proto.SessionInfo{
		{ID: "s1", Machine: "vps-1", State: proto.StateIdle}, {ID: "s2", Machine: "vps-1", State: proto.StateNeedsYou}}}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "hello", Machine: "vps-1", Payload: mustJSON(h)}))
	f.c = c
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread, "still unread after the reconnect")
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 2, "nothing replayed")

	// a restarted hub on the same store: same answer
	h2 := newHub(f.st)
	cap2 := &capture{}
	h2.SetBroadcaster(cap2)
	h2.afterFunc = f.clock.afterFunc
	require.True(t, h2.onHello("vps-1", h))
	f.clock.advance(doneGrace)
	require.Zero(t, countType(cap2, "attention"))
}

func TestClosedSessionNeverUnread(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateClosed)
	f.sync(t)
	require.False(t, f.lastUpsert(t, "s1").Unread)
	f.clock.advance(doneGrace)
	require.Empty(t, f.attentions())
}

// Review fix: a second end inside the first one's grace gets its own full grace.
func TestSecondEndInsideGraceGetsFullGrace(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	f.clock.advance(2 * time.Second)
	evs, _ := f.st.Events("s1", 0, 1)
	require.Equal(t, 204, f.seen(t, "s1", evs[0].Seq)) // the owner looked at end 1
	f.clock.advance(doneGrace - 2*time.Second - time.Millisecond)
	f.state(t, "s1", proto.StateWorking) // end 2 at grace-ε
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	f.clock.advance(time.Millisecond) // end 1's timer fires
	require.Empty(t, f.attentions(), "end 2 had almost no grace")
	f.clock.advance(doneGrace - 2*time.Millisecond)
	require.Empty(t, f.attentions())
	f.clock.advance(time.Millisecond) // end 2's full grace
	require.Len(t, f.attentions(), 1)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 1)
}

func TestSessionSeenFromTheMachineMarksItRead(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread)
	require.NoError(t, wsjson.Write(context.Background(), f.c, proto.Envelope{Type: "session_seen", Session: "s1"}))
	f.sync(t)
	require.False(t, f.lastUpsert(t, "s1").Unread, "focusing the pane published the read session")
	f.clock.advance(doneGrace)
	require.Empty(t, f.attentions(), "seen before the grace: no done attention")
}

func TestSessionSeenIgnoresSessionsOfOtherMachines(t *testing.T) {
	f := newAttFx(t, "s1")
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "other", Machine: "laptop", State: proto.StateWorking}))
	_, err := f.st.AppendEvent(proto.Event{Session: "other", Kind: proto.KindTurnEnd, Data: mustJSON(map[string]any{})})
	require.NoError(t, err)
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "other", Machine: "laptop", State: proto.StateIdle}))
	before, err := f.st.Session("other")
	require.NoError(t, err)
	require.True(t, before.Unread)
	require.NoError(t, wsjson.Write(context.Background(), f.c, proto.Envelope{Type: "session_seen", Session: "other"}))
	f.sync(t)
	after, err := f.st.Session("other")
	require.NoError(t, err)
	require.True(t, after.Unread, "vps-1 cannot mark laptop's session seen")
}

func TestSeenDuringAnUpsertIsNotUndoneByItsStaleUnread(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread)

	h := f.srv.hub
	done := make(chan struct{})
	var once bool
	hook := func(id string) {
		if id != "s1" || once {
			return
		}
		once = true
		// a device marks the session seen between the upsert's unread read and its publish
		go func() {
			defer close(done)
			if moved, err := f.st.SetSeen("s1", 1<<40); err == nil && moved {
				h.publishStored("s1")
			}
		}()
		time.Sleep(50 * time.Millisecond)
	}
	h.upsertHook.Store(&hook)
	f.state(t, "s1", proto.StateIdle)
	<-done
	f.sync(t)
	require.False(t, f.lastUpsert(t, "s1").Unread, "the last upsert carries the seen state")
}

func TestTurnStoppedInClaudeCodeIsSeen(t *testing.T) {
	f := newAttFx(t, "s1")
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{"reason": "aborted", "stopped": true})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	require.False(t, f.lastUpsert(t, "s1").Unread, "the person pressed Stop: they were looking")
	f.clock.advance(doneGrace)
	require.Empty(t, f.attentions())

	// an abort without the person's Stop (from Quorum) is unread as usual
	f.state(t, "s1", proto.StateWorking)
	f.event(t, "s1", proto.KindTurnEnd, map[string]any{"reason": "aborted"})
	f.state(t, "s1", proto.StateIdle)
	f.sync(t)
	require.True(t, f.lastUpsert(t, "s1").Unread)
}
