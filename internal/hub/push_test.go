package hub

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeFCM is the OAuth token endpoint and the FCM send endpoint in one test server.
type fakeFCM struct {
	t   *testing.T
	ts  *httptest.Server
	key *rsa.PrivateKey

	mu       sync.Mutex
	sends    []map[string]any
	auths    []string
	tokenHit int
	// reply decides the answer of a send by device token (nil: 200).
	reply func(token string) (int, string)
	// tokenStatus is the token endpoint's status (0: 200).
	tokenStatus int
	block       chan struct{} // when set, sends wait on it (or the request's end)
}

func newFakeFCM(t *testing.T) *fakeFCM {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	f := &fakeFCM{t: t, key: k}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", f.handleToken)
	mux.HandleFunc("POST /v1/projects/demo-project/messages:send", f.handleSend)
	f.ts = httptest.NewServer(mux)
	t.Cleanup(func() {
		f.mu.Lock()
		if f.block != nil {
			close(f.block)
			f.block = nil
		}
		f.mu.Unlock()
		f.ts.Close()
	})
	return f
}

func (f *fakeFCM) handleToken(w http.ResponseWriter, r *http.Request) {
	require.NoError(f.t, r.ParseForm())
	f.mu.Lock()
	f.tokenHit++
	st := f.tokenStatus
	f.mu.Unlock()
	if st != 0 {
		w.WriteHeader(st)
		_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
		return
	}
	require.Equal(f.t, "urn:ietf:params:oauth:grant-type:jwt-bearer", r.Form.Get("grant_type"))
	parts := strings.Split(r.Form.Get("assertion"), ".")
	require.Len(f.t, parts, 3)
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	require.NoError(f.t, err)
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	require.NoError(f.t, rsa.VerifyPKCS1v15(&f.key.PublicKey, crypto.SHA256, sum[:], sig), "the JWT is signed with the key")
	var hdr, claims map[string]any
	b, _ := base64.RawURLEncoding.DecodeString(parts[0])
	require.NoError(f.t, json.Unmarshal(b, &hdr))
	require.Equal(f.t, "RS256", hdr["alg"])
	b, _ = base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(f.t, json.Unmarshal(b, &claims))
	require.Equal(f.t, "push@demo-project.iam.gserviceaccount.com", claims["iss"])
	require.Equal(f.t, "https://www.googleapis.com/auth/firebase.messaging", claims["scope"])
	require.Equal(f.t, f.ts.URL+"/token", claims["aud"])
	writeJSON(w, 200, map[string]any{"access_token": "access-1", "expires_in": 3600, "token_type": "Bearer"})
}

func (f *fakeFCM) handleSend(w http.ResponseWriter, r *http.Request) {
	var m map[string]any
	require.NoError(f.t, json.NewDecoder(r.Body).Decode(&m))
	f.mu.Lock()
	f.sends = append(f.sends, m)
	f.auths = append(f.auths, r.Header.Get("Authorization"))
	block, reply := f.block, f.reply
	f.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-r.Context().Done():
		}
		return
	}
	tok, _ := m["message"].(map[string]any)["token"].(string)
	if reply != nil {
		if code, body := reply(tok); code != 200 {
			w.WriteHeader(code)
			_, _ = io.WriteString(w, body)
			return
		}
	}
	writeJSON(w, 200, map[string]string{"name": "projects/demo-project/messages/1"})
}

func (f *fakeFCM) set(fn func()) { f.mu.Lock(); defer f.mu.Unlock(); fn() }
func (f *fakeFCM) sent() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.sends...)
}
func (f *fakeFCM) authz() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.auths...)
}
func (f *fakeFCM) hits() int { f.mu.Lock(); defer f.mu.Unlock(); return f.tokenHit }

// keyFile writes a service-account key for the fake server and returns its path.
func (f *fakeFCM) keyFile(t *testing.T) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(f.key)
	require.NoError(t, err)
	k := map[string]string{
		"type":         "service_account",
		"project_id":   "demo-project",
		"client_email": "push@demo-project.iam.gserviceaccount.com",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"token_uri":    f.ts.URL + "/token",
	}
	b, _ := json.Marshal(k)
	p := filepath.Join(t.TempDir(), "fcm.json")
	require.NoError(t, os.WriteFile(p, b, 0o600))
	return p
}

type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logLines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

func (f *fakeFCM) pusher(t *testing.T, gone func(string), logs *logLines) *fcmPusher {
	t.Helper()
	p, err := newFCMPusher(f.keyFile(t), gone, logs.logf)
	require.NoError(t, err)
	p.baseURL = f.ts.URL
	return p
}

var pushData = map[string]string{"session": "s1", "kind": "needs_you"}

func TestFCMPayloadHasExactFields(t *testing.T) {
	f := newFakeFCM(t)
	logs := &logLines{}
	p := f.pusher(t, func(string) { t.Fatal("nothing is gone") }, logs)
	p.Push(context.Background(), []PushTarget{{Device: "phone", Token: "fcm-1"}, {Device: "tablet", Token: "fcm-2"}},
		"Fix the login · vps-1", "Needs you: permission for Bash", pushData)
	require.Len(t, f.sent(), 2)
	want := map[string]any{"message": map[string]any{
		"token":        "fcm-1",
		"notification": map[string]any{"title": "Fix the login · vps-1", "body": "Needs you: permission for Bash"},
		"android":      map[string]any{"priority": "high"},
		"data":         map[string]any{"session": "s1", "kind": "needs_you"},
	}}
	require.Equal(t, want, f.sent()[0])
	require.Equal(t, "fcm-2", f.sent()[1]["message"].(map[string]any)["token"])
	require.Equal(t, []string{"Bearer access-1", "Bearer access-1"}, f.authz())
	require.Equal(t, 1, f.hits(), "the access token is cached")

	p.Push(context.Background(), []PushTarget{{Device: "phone", Token: "fcm-1"}}, "t", "b", pushData)
	require.Equal(t, 1, f.hits(), "still cached on the next attention")
	require.Empty(t, logs.all())
}

func TestFCMUnregisteredDeletesToken(t *testing.T) {
	f := newFakeFCM(t)
	f.mu.Lock()
	f.reply = func(tok string) (int, string) {
		switch tok {
		case "gone-1":
			return 400, `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
		case "gone-2":
			return 404, `{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
		case "gone-3":
			return 404, `{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}`
		case "keep-404":
			return 404, `not json` // a bare 404 is not FCM saying the token is gone
		}
		return 200, ""
	}
	f.mu.Unlock()
	var gone []string
	logs := &logLines{}
	p := f.pusher(t, func(tok string) { gone = append(gone, tok) }, logs)
	p.Push(context.Background(), []PushTarget{{Token: "gone-1"}, {Token: "ok"}, {Token: "gone-2"}, {Token: "gone-3"}, {Token: "keep-404"}}, "t", "b", pushData)
	require.Equal(t, []string{"gone-1", "gone-2", "gone-3"}, gone)
	for _, l := range logs.all() {
		require.NotContains(t, l, "gone-", "tokens are never logged")
		require.NotContains(t, l, "keep-", "tokens are never logged")
	}
}

func TestFCMWrongProject404KeepsToken(t *testing.T) {
	f := newFakeFCM(t)
	f.set(func() {
		f.reply = func(string) (int, string) {
			return 404, `<!DOCTYPE html><html><title>Error 404 (Not Found)!!1</title><p>The requested URL was not found on this server.</p></html>`
		}
	})
	logs := &logLines{}
	p := f.pusher(t, func(string) { t.Fatal("a non-FCM 404 never deletes a token") }, logs)
	p.Push(context.Background(), []PushTarget{{Device: "phone", Token: "fcm-1"}}, "t", "b", pushData)
	require.Len(t, logs.all(), 1)
	require.Contains(t, logs.all()[0], "FCM send failed: 404")
	require.NotContains(t, logs.all()[0], "fcm-1")
}

func TestFCMInvalidArgumentKeepsToken(t *testing.T) {
	f := newFakeFCM(t)
	f.set(func() {
		f.reply = func(string) (int, string) {
			return 400, `{"error":{"code":400,"message":"Invalid value at 'message.data'","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"INVALID_ARGUMENT"}]}}`
		}
	})
	logs := &logLines{}
	p := f.pusher(t, func(string) { t.Fatal("a bad payload never deletes a token") }, logs)
	p.Push(context.Background(), []PushTarget{{Token: "fcm-1"}}, "t", "b", pushData)
	require.Len(t, logs.all(), 1)
	require.Contains(t, logs.all()[0], "INVALID_ARGUMENT")
	require.NotContains(t, logs.all()[0], "fcm-1")
}

func TestFCMExpiredCredentialsKeepTokens(t *testing.T) {
	f := newFakeFCM(t)
	f.set(func() { f.tokenStatus = 400 }) // invalid_grant: the key was deleted or its clock is off
	logs := &logLines{}
	p := f.pusher(t, func(string) { t.Fatal("an auth failure never deletes a token") }, logs)
	p.Push(context.Background(), []PushTarget{{Token: "fcm-1"}}, "t", "b", pushData)
	require.Empty(t, f.sent())
	require.Len(t, logs.all(), 1)
	require.Contains(t, logs.all()[0], "auth")

	// FCM rejects a cached access token: it is dropped and fetched again next time
	f.set(func() { f.tokenStatus = 0 })
	f.set(func() {
		f.reply = func(string) (int, string) { return 401, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}` }
	})
	p.Push(context.Background(), []PushTarget{{Token: "fcm-1"}}, "t", "b", pushData)
	f.set(func() { f.reply = nil })
	p.Push(context.Background(), []PushTarget{{Token: "fcm-1"}}, "t", "b", pushData)
	require.Equal(t, 3, f.hits())
}

func TestFCMTimeoutIsHonoured(t *testing.T) {
	require.Equal(t, 10*time.Second, pushTimeout, "the production timeout")
	f := newFakeFCM(t)
	f.set(func() { f.block = make(chan struct{}) })
	logs := &logLines{}
	p := f.pusher(t, func(string) { t.Fatal("a timeout never deletes a token") }, logs)
	p.timeout = 150 * time.Millisecond
	start := time.Now()
	p.Push(context.Background(), []PushTarget{{Token: "fcm-1"}, {Token: "fcm-2"}}, "t", "b", pushData)
	require.Less(t, time.Since(start), 2*time.Second)
	require.NotEmpty(t, logs.all())
}

func TestLoadPusherMissingKey(t *testing.T) {
	logs := &logLines{}
	p := loadPusher(filepath.Join(t.TempDir(), "fcm.json"), func(string) {}, logs.logf)
	require.Nil(t, p)
	require.Len(t, logs.all(), 1)
	require.Contains(t, logs.all()[0], "push is off")
}

func TestLoadPusherMalformedKey(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"not-json":   `{"project_id":`,
		"no-project": `{"client_email":"a@b","private_key":"x"}`,
		"bad-pem":    `{"project_id":"p","client_email":"a@b","private_key":"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, name+".json")
			require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
			logs := &logLines{}
			require.Nil(t, loadPusher(path, func(string) {}, logs.logf))
			require.Len(t, logs.all(), 1)
			require.Contains(t, logs.all()[0], "push is off")
			require.NotContains(t, logs.all()[0], "BEGIN PRIVATE KEY", "the key is never logged")
		})
	}
}
