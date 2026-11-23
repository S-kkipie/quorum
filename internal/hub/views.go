package hub

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
)

const (
	viewTTL       = 6 * time.Hour
	viewChunk     = 1 << 20
	viewMaxSize   = 50 << 20
	viewGoneText  = "Open it again from Quorum"
	viewOutside   = "outside the project folder"
	viewDenied    = "this file is not served"
	viewCSPHeader = "sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'; " +
		"default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'"
	viewWriteWait = 30 * time.Second
)

// viewLink is what a /v/ token grants: reading files under base on machine.
type viewLink struct {
	machine string
	base    string
	expires time.Time
}

// viewLinks keeps the /v/ tokens in memory: a hub restart invalidates them all.
type viewLinks struct {
	mu    sync.Mutex
	now   func() time.Time
	links map[string]viewLink
}

func newViewLinks() *viewLinks {
	return &viewLinks{now: time.Now, links: map[string]viewLink{}}
}

func (v *viewLinks) setNow(f func() time.Time) {
	v.mu.Lock()
	v.now = f
	v.mu.Unlock()
}

// create stores a new link and drops the expired ones.
func (v *viewLinks) create(machine, base string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(b[:])
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	for k, l := range v.links {
		if !now.Before(l.expires) {
			delete(v.links, k)
		}
	}
	v.links[tok] = viewLink{machine: machine, base: base, expires: now.Add(viewTTL)}
	return tok, nil
}

func (v *viewLinks) get(tok string) (viewLink, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	l, ok := v.links[tok]
	if !ok {
		return l, false
	}
	if !v.now().Before(l.expires) {
		delete(v.links, tok)
		return l, false
	}
	return l, true
}

// isAbsAnyOS: absolute on Unix ("/x") or Windows ("C:\x", "C:/x", `\\server\share`).
func isAbsAnyOS(p string) bool {
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\\`) {
		return true
	}
	return len(p) >= 3 && (p[0]|0x20 >= 'a' && p[0]|0x20 <= 'z') && p[1] == ':' && (p[2] == '/' || p[2] == '\\')
}

// pathSegs splits a cleaned, slash-normalized path into its non-empty segments.
func pathSegs(p string) []string {
	var out []string
	for _, s := range strings.Split(path.Clean(strings.ReplaceAll(p, `\`, "/")), "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// relInside returns the segments of p below base, or false if p is not base or under it.
func relInside(base, p string, fold bool) ([]string, bool) {
	if !isAbsAnyOS(base) || !isAbsAnyOS(p) || strings.ContainsRune(p, 0) {
		return nil, false
	}
	bs, ps := pathSegs(base), pathSegs(p)
	if len(ps) < len(bs) {
		return nil, false
	}
	for i := range bs {
		if normRoot(bs[i], fold) != normRoot(ps[i], fold) {
			return nil, false
		}
	}
	return ps[len(bs):], true
}

// sessionBase: root if set, otherwise cwd.
func sessionBase(root, cwd string) string {
	if root != "" {
		return root
	}
	return cwd
}

func (s *Server) handleCreateView(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
	}
	if !decode(w, r, &b) {
		return
	}
	m := r.PathValue("m")
	si, err := s.st.Session(b.SessionID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && si.Machine != m) {
		apiErr(w, 404, "session not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	base := sessionBase(si.Root, si.Cwd)
	rel, ok := relInside(base, b.Path, s.hub.caseInsensitiveOS(m))
	if base == "" || !ok {
		apiErr(w, 403, viewOutside)
		return
	}
	tok, err := s.views.create(m, base)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	esc := make([]string, len(rel))
	for i, seg := range rel {
		esc[i] = url.PathEscape(seg)
	}
	writeJSON(w, 200, map[string]string{"url": "/v/" + tok + "/" + strings.Join(esc, "/")})
}

// viewSensitive reports whether a cleaned relative path names something a link must
// never serve (repository internals, keys, credentials), even inside the base. The base
// can be the home folder, so tool credential folders are denied too. Other
// dot-directories stay allowed: artifacts live under .claude/quorum/artifacts/.
func viewSensitive(rel string) bool {
	segs := strings.Split(strings.ToLower(rel), "/")
	for i, seg := range segs {
		switch {
		case seg == ".git", seg == ".ssh", seg == ".gnupg", seg == ".aws", strings.HasPrefix(seg, ".env"),
			seg == ".docker", seg == ".kube", seg == ".azure":
			return true
		case seg == ".config" && i+1 < len(segs) && segs[i+1] == "gh":
			return true
		}
	}
	name := segs[len(segs)-1]
	switch name {
	case ".credentials.json", ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".pgpass":
		return true
	}
	return strings.HasPrefix(name, "id_rsa") || strings.HasPrefix(name, "id_ed25519") ||
		strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, ".key") ||
		strings.HasSuffix(name, ".p12") || strings.HasSuffix(name, ".pfx")
}

// viewContentTypes by lowercase extension; anything else is application/octet-stream.
var viewContentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
}

func viewContentType(p string) string {
	if ct, ok := viewContentTypes[strings.ToLower(path.Ext(p))]; ok {
		return ct
	}
	return "application/octet-stream"
}

// viewFail writes a plain-text error (the /v/ headers are already set).
func viewFail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(msg + "\n"))
}

// viewRPCFail maps a file_read error to the /v/ response.
func viewRPCFail(w http.ResponseWriter, err error) {
	var de daemonError
	switch {
	case errors.Is(err, errOffline):
		viewFail(w, 503, errOffline.Error())
	case errors.Is(err, errTimeout):
		viewFail(w, 504, errTimeout.Error())
	case errors.As(err, &de):
		msg := string(de)
		switch {
		case strings.HasPrefix(msg, "outside"):
			viewFail(w, 403, viewOutside)
		case msg == "does not exist" || msg == "not a file":
			viewFail(w, 404, msg)
		case msg == "file too large":
			viewFail(w, 413, msg)
		default:
			viewFail(w, 502, msg)
		}
	default:
		viewFail(w, 502, "error talking to the machine")
	}
}

// viewHandler sends every /v/ request to handleView before the mux sees it: the mux
// would otherwise redirect a path with ".." segments instead of refusing it.
func (s *Server) viewHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v/") {
			s.handleView(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleView serves GET /v/{token}/{rest...}: the link token is the only auth. The
// response is sandboxed by CSP, so the artifact gets an opaque origin and can never
// read the app's storage (device token).
func (s *Server) handleView(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Security-Policy", viewCSPHeader)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		viewFail(w, 405, "method not allowed")
		return
	}
	// r.URL.Path is already percent-decoded (once); containment is checked after that.
	tok, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/v/"), "/")
	link, ok := s.views.get(tok)
	if !ok {
		viewFail(w, 410, viewGoneText)
		return
	}
	if strings.ContainsAny(rest, "\x00\\") {
		viewFail(w, 403, viewOutside)
		return
	}
	rel := path.Clean(rest)
	if rel == ".." || strings.HasPrefix(rel, "../") || path.IsAbs(rel) {
		viewFail(w, 403, viewOutside)
		return
	}
	if viewSensitive(rel) {
		viewFail(w, 403, viewDenied)
		return
	}
	full := link.base
	if rel != "." {
		full = strings.TrimRight(strings.ReplaceAll(link.base, `\`, "/"), "/") + "/" + rel
	}
	rc := http.NewResponseController(w)
	var off int64
	for first := true; ; first = false {
		var out struct {
			Data string `json:"data"`
			Size int64  `json:"size"`
			EOF  bool   `json:"eof"`
		}
		p := map[string]any{"path": full, "base": link.base, "offset": off, "length": viewChunk}
		err := s.hub.call(r.Context(), link.machine, "file_read", p, &out)
		var data []byte
		if err == nil {
			data, err = base64.StdEncoding.DecodeString(out.Data)
		}
		if first {
			if err == nil && out.Size > viewMaxSize {
				viewFail(w, 413, "file too large")
				return
			}
			if err != nil {
				viewRPCFail(w, err)
				return
			}
			h.Set("Content-Type", viewContentType(rel))
			h.Set("Content-Length", strconv.FormatInt(out.Size, 10))
			_ = rc.SetWriteDeadline(time.Now().Add(viewWriteWait)) // ErrNotSupported is fine
			w.WriteHeader(200)
			if r.Method == http.MethodHead {
				return
			}
		} else if err != nil {
			panic(http.ErrAbortHandler) // headers already sent: cut the response
		}
		_ = rc.SetWriteDeadline(time.Now().Add(viewWriteWait)) // ErrNotSupported is fine
		if _, err := w.Write(data); err != nil {
			return
		}
		_ = rc.Flush()
		off += int64(len(data))
		if out.EOF || off >= out.Size {
			return
		}
		if len(data) == 0 {
			panic(http.ErrAbortHandler) // no progress and no eof
		}
	}
}
