package hub

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// viewFx: m1 answers file_read from files (keyed by absolute path), and session s1
// lives in /work/proj.
type viewFx struct {
	*appFx
	mu    sync.Mutex
	files map[string][]byte
	fail  map[string]string // path -> daemon error (e.g. a symlink the daemon refuses)
	reads []map[string]any
}

func newViewFx(t *testing.T) *viewFx {
	t.Helper()
	vf := &viewFx{appFx: newAppFx(t), files: map[string][]byte{}, fail: map[string]string{}}
	fakeMachine(t, vf.appFx, vf.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		if r.Method != "file_read" {
			return okResult(map[string]string{})
		}
		var p struct {
			Path   string `json:"path"`
			Base   string `json:"base"`
			Offset int64  `json:"offset"`
			Length int    `json:"length"`
		}
		_ = json.Unmarshal(r.Params, &p)
		vf.mu.Lock()
		defer vf.mu.Unlock()
		var raw map[string]any
		_ = json.Unmarshal(r.Params, &raw)
		vf.reads = append(vf.reads, raw)
		if e, ok := vf.fail[p.Path]; ok {
			return &proto.RPCResult{Error: e}
		}
		data, ok := vf.files[p.Path]
		if !ok {
			return &proto.RPCResult{Error: "does not exist"}
		}
		end := p.Offset + int64(p.Length)
		if end > int64(len(data)) {
			end = int64(len(data))
		}
		chunk := data[p.Offset:end]
		return okResult(map[string]any{"data": base64.StdEncoding.EncodeToString(chunk), "size": len(data), "eof": end >= int64(len(data))})
	})
	eventually(t, func() bool { return vf.srv.hub.Connected("m1") })
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj/sub", State: proto.StateIdle}))
	return vf
}

func (vf *viewFx) put(path string, data []byte) {
	vf.mu.Lock()
	vf.files[path] = data
	vf.mu.Unlock()
}

// link creates a view link and returns its url.
func (vf *viewFx) link(t *testing.T, path string) string {
	t.Helper()
	code, body := vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]string{"sessionId": "s1", "path": path})))
	require.Equal(t, 200, code, body)
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	return out.URL
}

// get fetches a /v/ url with no Authorization and without following redirects.
func (vf *viewFx) get(t *testing.T, u string) (*http.Response, string) {
	t.Helper()
	cl := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequest("GET", vf.ts.URL+u, nil)
	require.NoError(t, err)
	resp, err := cl.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func requireViewHeaders(t *testing.T, resp *http.Response) {
	t.Helper()
	require.Equal(t, "sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'; "+
		"default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'", resp.Header.Get("Content-Security-Policy"))
	require.Equal(t, "no-referrer", resp.Header.Get("Referrer-Policy"))
	require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	require.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
	require.Equal(t, "*", resp.Header.Get("Access-Control-Allow-Origin"))
}

func TestViewLinkAndServe(t *testing.T) {
	vf := newViewFx(t)
	data := bytes.Repeat([]byte("<p>x</p>"), (3<<20)/16) // 1.5 MiB: two chunks
	vf.put("/work/proj/docs/a b.html", data)
	u := vf.link(t, "/work/proj/docs/a b.html")
	require.Regexp(t, `^/v/[0-9a-f]{32}/docs/a%20b\.html$`, u)
	resp, body := vf.get(t, u)
	require.Equal(t, 200, resp.StatusCode)
	requireViewHeaders(t, resp)
	require.True(t, strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html"))
	require.Equal(t, string(data), body)
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Len(t, vf.reads, 2)
	require.Equal(t, "/work/proj", vf.reads[0]["base"])
	require.EqualValues(t, 1<<20, vf.reads[1]["offset"])
}

func TestViewContentTypes(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/r.md", []byte("# hi"))
	vf.put("/work/proj/i.svg", []byte("<svg/>"))
	vf.put("/work/proj/x.bin", []byte("??"))
	u := vf.link(t, "/work/proj/r.md")
	tok := strings.Split(u, "/")[2]
	for name, ct := range map[string]string{"r.md": "text/plain; charset=utf-8", "i.svg": "image/svg+xml", "x.bin": "application/octet-stream"} {
		resp, _ := vf.get(t, "/v/"+tok+"/"+name)
		require.Equal(t, 200, resp.StatusCode, name)
		require.Equal(t, ct, resp.Header.Get("Content-Type"), name)
	}
}

func TestViewRelativeAsset(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/docs/r.html", []byte("<img src=img/a.png>"))
	vf.put("/work/proj/img/a.png", []byte("PNG"))
	u := vf.link(t, "/work/proj/docs/r.html")
	tok := strings.Split(u, "/")[2]
	resp, body := vf.get(t, "/v/"+tok+"/img/a.png")
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "PNG", body)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
}

func TestViewTraversal403(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/r.html", []byte("x"))
	vf.put("/etc/x", []byte("secret"))
	tok := strings.Split(vf.link(t, "/work/proj/r.html"), "/")[2]
	for _, p := range []string{"/../../x", "/%2e%2e/%2e%2e/x", "/%2E%2E/%2e%2e/etc/x", "/a/%2e%2e/%2e%2e/x", "/..%2f..%2fetc/x", "/a%5c..%5c..%5cx", "/a%00", "//etc/x"} {
		resp, body := vf.get(t, "/v/"+tok+p)
		require.Equal(t, 403, resp.StatusCode, p+" "+body)
		requireViewHeaders(t, resp)
		require.NotContains(t, body, "secret")
	}
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Empty(t, vf.reads)
}

func TestViewOutsideBase403(t *testing.T) {
	vf := newViewFx(t)
	for _, p := range []string{"/work/other/x.html", "/work/projx/a.html", "/work/proj/../other/a.html", "relative/a.html", ""} {
		code, body := vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]string{"sessionId": "s1", "path": p})))
		require.Equal(t, 403, code, p)
		require.Contains(t, body, "outside the project folder")
	}
	// the session belongs to m1: asking through another machine is 404
	code, body := vf.do("POST", "/api/machines/m2/views", `{"sessionId":"s1","path":"/work/proj/a.html"}`)
	require.Equal(t, 404, code)
	require.Contains(t, body, "session not found")
	code, _ = vf.do("POST", "/api/machines/m1/views", `{"sessionId":"nope","path":"/work/proj/a.html"}`)
	require.Equal(t, 404, code)
}

func TestViewBaseFallsBackToCwd(t *testing.T) {
	vf := newViewFx(t)
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Cwd: "/work/cwd", State: proto.StateIdle}))
	vf.put("/work/cwd/a.html", []byte("ok"))
	resp, body := vf.get(t, vf.link(t, "/work/cwd/a.html"))
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "ok", body)
}

func TestViewCaseFoldOnWindows(t *testing.T) {
	vf := newViewFx(t)
	require.NoError(t, vf.st.UpsertMachine("m1", "windows", "windows", proto.Version, true, proto.MachineCaps{}))
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: `C:\Work\Proj`, State: proto.StateIdle}))
	vf.put("C:/Work/Proj/Docs/R.html", []byte("win"))
	u := vf.link(t, `c:\work\proj\Docs\R.html`)
	require.True(t, strings.HasSuffix(u, "/Docs/R.html"), u)
	resp, body := vf.get(t, u)
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "win", body)
}

func TestViewDaemonErrors(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/a.html", []byte("x"))
	tok := strings.Split(vf.link(t, "/work/proj/a.html"), "/")[2]
	resp, _ := vf.get(t, "/v/"+tok+"/missing.html")
	require.Equal(t, 404, resp.StatusCode)
	requireViewHeaders(t, resp)
	vf.srv.hub.mu.Lock()
	c := vf.srv.hub.conns["m1"]
	vf.srv.hub.mu.Unlock()
	c.ws.CloseNow()
	eventually(t, func() bool { return !vf.srv.hub.Connected("m1") })
	resp, _ = vf.get(t, "/v/"+tok+"/a.html")
	require.Equal(t, 503, resp.StatusCode)
}

func TestViewExpired410(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/a.html", []byte("x"))
	now := time.Now()
	vf.srv.views.setNow(func() time.Time { return now })
	u := vf.link(t, "/work/proj/a.html")
	now = now.Add(6*time.Hour - time.Second)
	resp, _ := vf.get(t, u)
	require.Equal(t, 200, resp.StatusCode)
	now = now.Add(2 * time.Second)
	resp, body := vf.get(t, u)
	require.Equal(t, 410, resp.StatusCode)
	require.Contains(t, body, "Open it again from Quorum")
	requireViewHeaders(t, resp)
	resp, body = vf.get(t, "/v/00000000000000000000000000000000/a.html")
	require.Equal(t, 410, resp.StatusCode)
	require.Contains(t, body, "Open it again from Quorum")
}

func TestViewNeedsNoDeviceToken(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/a.html", []byte("hello"))
	u := vf.link(t, "/work/proj/a.html")
	resp, body := vf.get(t, u) // get sends no Authorization
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "hello", body)
	resp2, err := http.Post(vf.ts.URL+"/api/machines/m1/views", "application/json", strings.NewReader(`{"sessionId":"s1","path":"/work/proj/a.html"}`))
	require.NoError(t, err)
	resp2.Body.Close()
	require.Equal(t, 401, resp2.StatusCode)
}

// %252e%252e decodes once to the literal name "%2e%2e": it stays inside the base.
func TestViewDoubleEncodedStaysInside(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/etc/x", []byte("secret"))
	tok := strings.Split(vf.link(t, "/work/proj/r.html"), "/")[2]
	resp, body := vf.get(t, "/v/"+tok+"/%252e%252e/%252e%252e/etc/x")
	require.Equal(t, 404, resp.StatusCode)
	require.NotContains(t, body, "secret")
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Len(t, vf.reads, 1)
	require.Equal(t, "/work/proj/%2e%2e/%2e%2e/etc/x", vf.reads[0]["path"])
}

func TestViewSensitivePaths403(t *testing.T) {
	vf := newViewFx(t)
	tok := strings.Split(vf.link(t, "/work/proj/r.html"), "/")[2]
	for _, p := range []string{".git/config", "a/.GIT/HEAD", ".ssh/known_hosts", ".gnupg/x", ".aws/credentials",
		".env", ".env.local", "sub/.envrc", "id_rsa", "keys/id_rsa.pub", "id_ed25519", "c/server.pem", "tls.KEY",
		".claude/.credentials.json", ".config/gh/hosts.yml", ".CONFIG/GH/config.yml", ".npmrc", "sub/.netrc", ".pypirc",
		".docker/config.json", ".kube/config", ".azure/accessTokens.json", "certs/client.p12", "client.PFX",
		".git-credentials", ".pgpass"} {
		vf.put("/work/proj/"+p, []byte("secret"))
		resp, body := vf.get(t, "/v/"+tok+"/"+p)
		require.Equal(t, 403, resp.StatusCode, p)
		require.Contains(t, body, "this file is not served", p)
		requireViewHeaders(t, resp)
	}
	vf.mu.Lock()
	require.Empty(t, vf.reads)
	vf.mu.Unlock()
	// other dot-directories stay allowed: artifacts live there
	vf.put("/work/proj/.claude/quorum/artifacts/r.html", []byte("ok"))
	resp, body := vf.get(t, "/v/"+tok+"/.claude/quorum/artifacts/r.html")
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "ok", body)
	// other .config folders are not credentials
	vf.put("/work/proj/.config/app/r.html", []byte("cfg"))
	resp, body = vf.get(t, "/v/"+tok+"/.config/app/r.html")
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "cfg", body)
}
