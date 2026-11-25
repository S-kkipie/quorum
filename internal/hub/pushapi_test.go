package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func (f *appFx) pushReq(t *testing.T, method, body, tok string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, f.ts.URL+"/api/devices/push", strings.NewReader(body))
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var e struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&e)
	return resp.StatusCode, e.Error
}

func TestPushTokenRoutes(t *testing.T) {
	f := newAppFx(t)
	code, _ := f.pushReq(t, "POST", `{"token":"fcm-1","platform":"android"}`, f.devTok)
	require.Equal(t, 204, code)
	ts, err := f.st.PushTokens()
	require.NoError(t, err)
	require.Equal(t, []store.PushToken{{Device: "tel", Token: "fcm-1", Platform: "android"}}, ts)

	long := strings.Repeat("x", 4096)
	code, _ = f.pushReq(t, "POST", `{"token":"`+long+`","platform":"android"}`, f.devTok)
	require.Equal(t, 204, code, "4096 characters is the limit")

	code, _ = f.pushReq(t, "DELETE", `{"token":"fcm-1"}`, f.devTok)
	require.Equal(t, 204, code)
	code, _ = f.pushReq(t, "DELETE", `{"token":"fcm-1"}`, f.devTok)
	require.Equal(t, 204, code, "deleting twice is fine")
	ts, _ = f.st.PushTokens()
	require.Len(t, ts, 1)
	require.Equal(t, long, ts[0].Token)

	code, _ = f.pushReq(t, "POST", `{"token":"fcm-1","platform":"android"}`, "")
	require.Equal(t, 401, code)
	code, _ = f.pushReq(t, "DELETE", `{"token":"fcm-1"}`, "wrong")
	require.Equal(t, 401, code)
}

func TestPushTokenValidation(t *testing.T) {
	f := newAppFx(t)
	for name, body := range map[string]string{
		"empty token":    `{"token":"","platform":"android"}`,
		"no token":       `{"platform":"android"}`,
		"too long":       `{"token":"` + strings.Repeat("x", 4097) + `","platform":"android"}`,
		"space":          `{"token":"a b","platform":"android"}`,
		"newline":        `{"token":"a\nb","platform":"android"}`,
		"control":        `{"token":"a\u0001b","platform":"android"}`,
		"non-ascii":      `{"token":"añb","platform":"android"}`,
		"ios":            `{"token":"fcm-1","platform":"ios"}`,
		"no platform":    `{"token":"fcm-1"}`,
		"platform case":  `{"token":"fcm-1","platform":"Android"}`,
		"not json":       `{"token":`,
		"token a number": `{"token":5,"platform":"android"}`,
	} {
		t.Run(name, func(t *testing.T) {
			code, msg := f.pushReq(t, "POST", body, f.devTok)
			require.Equal(t, 400, code)
			require.NotEmpty(t, msg)
		})
	}
	for name, body := range map[string]string{
		"empty token": `{"token":""}`,
		"too long":    `{"token":"` + strings.Repeat("x", 4097) + `"}`,
		"space":       `{"token":"a b"}`,
		"not json":    `nope`,
	} {
		t.Run("delete "+name, func(t *testing.T) {
			code, msg := f.pushReq(t, "DELETE", body, f.devTok)
			require.Equal(t, 400, code)
			require.NotEmpty(t, msg)
		})
	}
	code, msg := f.pushReq(t, "POST", `{"token":"a b","platform":"android"}`, f.devTok)
	require.Equal(t, 400, code)
	require.Equal(t, "invalid push token", msg)
	_, msg = f.pushReq(t, "POST", `{"token":"ab","platform":"ios"}`, f.devTok)
	require.Equal(t, "platform must be android", msg)
	ts, _ := f.st.PushTokens()
	require.Empty(t, ts)
}

func TestRevokedDeviceTokenIsGone(t *testing.T) {
	f := newAppFx(t)
	code, _ := f.pushReq(t, "POST", `{"token":"fcm-1","platform":"android"}`, f.devTok)
	require.Equal(t, 204, code)
	require.NoError(t, f.st.RevokeToken("device", "tel"))
	ts, err := f.st.PushTokens()
	require.NoError(t, err)
	require.Empty(t, ts)
}

// fakePusher records each Push call.
type fakePusher struct {
	mu    sync.Mutex
	calls []pushCall
}

type pushCall struct {
	targets     []PushTarget
	title, body string
	data        map[string]string
}

func (p *fakePusher) Push(_ context.Context, targets []PushTarget, title, body string, data map[string]string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, pushCall{targets, title, body, data})
}

func (p *fakePusher) got() []pushCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]pushCall(nil), p.calls...)
}

func (f *attFx) named(t *testing.T, id, name, recap string, st proto.SessionState) {
	t.Helper()
	env := proto.Envelope{Type: "session_upsert", Session: id, Payload: mustJSON(proto.SessionInfo{ID: id, Name: name, Recap: recap, State: st})}
	require.NoError(t, wsjson.Write(context.Background(), f.c, env))
}

func TestAttentionCarriesTextAndPushes(t *testing.T) {
	f := newAttFx(t, "s1", "s2", "s3")
	p := &fakePusher{}
	f.srv.hub.setPusher(p)
	require.NoError(t, f.st.AddToken("device", "phone", "tok-phone"))
	require.NoError(t, f.st.AddToken("device", "tablet", "tok-tablet"))
	require.NoError(t, f.st.AddPushToken("phone", "fcm-1", "android"))
	require.NoError(t, f.st.AddPushToken("tablet", "fcm-2", "android"))
	require.NoError(t, f.st.RevokeToken("device", "tablet")) // a revoked device gets nothing

	// permission ask: the recap is the name the app shows
	f.named(t, "s1", "fix-login", "Fix the login", proto.StateWorking)
	f.event(t, "s1", proto.KindAsk, proto.Ask{AskID: "a1", Kind: "permission", Tool: "Bash"})
	f.named(t, "s1", "fix-login", "Fix the login", proto.StateNeedsYou)
	f.sync(t)
	require.Len(t, f.attentions(), 1)
	a := f.attentions()[0]
	require.Equal(t, "Fix the login · vps-1", a.Title)
	require.Equal(t, "Needs you: permission for Bash", a.Body)
	eventually(t, func() bool { return len(p.got()) == 1 })
	c := p.got()[0]
	require.Equal(t, []PushTarget{{Device: "phone", Token: "fcm-1"}}, c.targets)
	require.Equal(t, a.Title, c.title)
	require.Equal(t, a.Body, c.body)
	require.Equal(t, map[string]string{"session": "s1", "kind": "needs_you"}, c.data)

	// question ask, name without a recap
	f.named(t, "s2", "refactor", "", proto.StateWorking)
	f.event(t, "s2", proto.KindAsk, proto.Ask{AskID: "a2", Kind: "question", Tool: "AskUserQuestion"})
	f.named(t, "s2", "refactor", "", proto.StateNeedsYou)
	f.sync(t)
	require.Len(t, f.attentions(), 2)
	require.Equal(t, "refactor · vps-1", f.attentions()[1].Title)
	require.Equal(t, "Needs you: question", f.attentions()[1].Body)

	// unnamed session that finished
	f.state(t, "s3", proto.StateWorking)
	f.event(t, "s3", proto.KindTurnEnd, map[string]any{})
	f.state(t, "s3", proto.StateIdle)
	f.sync(t)
	f.clock.advance(doneGrace)
	require.Len(t, f.attentions(), 3)
	require.Equal(t, "Session · vps-1", f.attentions()[2].Title)
	require.Equal(t, "Finished", f.attentions()[2].Body)
	eventually(t, func() bool { return len(p.got()) == 3 })
	require.Equal(t, map[string]string{"session": "s3", "kind": "done"}, p.got()[2].data)
}

func TestAttentionWithoutPushTokensSendsNothing(t *testing.T) {
	f := newAttFx(t, "s1")
	p := &fakePusher{}
	f.srv.hub.setPusher(p)
	f.state(t, "s1", proto.StateNeedsYou)
	f.sync(t)
	require.Len(t, f.attentions(), 1)
	require.Equal(t, "Needs you", f.attentions()[0].Body)
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, p.got())
}

func TestHubKeepsPublishingWithoutAUsableKey(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "fcm.json")
	require.NoError(t, os.WriteFile(bad, []byte(`{"project_id":`), 0o600))
	for name, path := range map[string]string{"malformed": bad, "missing": filepath.Join(dir, "none.json")} {
		t.Run(name, func(t *testing.T) {
			st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
			require.NoError(t, err)
			t.Cleanup(func() { st.Close() })
			s := NewServer(st, Options{FCMKeyFile: path})
			require.Nil(t, s.hub.getPusher(), "push is off")
			c := &capture{}
			s.hub.SetBroadcaster(c)
			s.hub.publishAttention("vps-1", "s1", "done")
			c.mu.Lock()
			defer c.mu.Unlock()
			require.Len(t, c.envs, 1)
			var a proto.Attention
			require.NoError(t, json.Unmarshal(c.envs[0].Payload, &a))
			require.Equal(t, "Finished", a.Body)
		})
	}
}

func TestFCMGoneTokenIsDeletedFromStore(t *testing.T) {
	ff := newFakeFCM(t)
	ff.set(func() {
		ff.reply = func(string) (int, string) { return 404, `{"error":{"code":404,"status":"NOT_FOUND"}}` }
	})
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	s := NewServer(st, Options{FCMKeyFile: ff.keyFile(t)})
	fp, ok := s.hub.getPusher().(*fcmPusher)
	require.True(t, ok)
	fp.baseURL = ff.ts.URL
	require.NoError(t, st.AddToken("device", "phone", "tok"))
	require.NoError(t, st.AddPushToken("phone", "fcm-1", "android"))
	s.hub.publishAttention("vps-1", "s1", "done")
	eventually(t, func() bool { ts, _ := st.PushTokens(); return len(ts) == 0 })
}
