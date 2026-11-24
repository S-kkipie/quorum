package hub

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/S-kkipie/quorum/internal/viewguard"
)

const (
	viewTTL       = 6 * time.Hour
	viewChunk     = 1 << 20
	viewMaxSize   = 50 << 20
	viewGoneText  = "Open it again from Quorum"
	viewOutside   = "outside the project folder"
	viewNoImage   = "This image is not available."
	viewDenied    = "this file is not served"
	viewCSPHeader = "sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'; " +
		"default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'"
	viewWriteWait = 30 * time.Second
)

// viewLink is what a /v/ token grants: reading files under base on machine. A link
// with only set (a pasted image) serves that one file below base and nothing else.
type viewLink struct {
	machine string
	base    string
	only    string
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
func (v *viewLinks) create(machine, base, only string) (string, error) {
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
	v.links[tok] = viewLink{machine: machine, base: base, only: only, expires: now.Add(viewTTL)}
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

var (
	// claudeTempDir is Claude Code's temp folder name, claude-<uid>.
	claudeTempDir = regexp.MustCompile(`^claude-[0-9]{1,10}$`)
	// pastedImage is the name Claude Code gives a pasted image: <N>.<ext>.
	pastedImage = regexp.MustCompile(`^[0-9]{1,4}\.(png|jpg|jpeg|gif|webp)$`)
	nonAlnum    = regexp.MustCompile(`[^a-zA-Z0-9]`)
)

// imagesDirOf returns the session's pasted-images folder as the mod reported it, only when its
// shape is the one Claude Code uses for this very session:
// <abs tmp>/claude-<uid>/<root or cwd, every non-alphanumeric a dash>/<session id>/images.
// Anything else (empty, relative, "." or ".." segments, another session's id, a folder
// not named after the session's project) gives "", so a wrong report never widens a link.
func imagesDirOf(si proto.SessionInfo, fold bool) string {
	dir := si.ImagesDir
	if dir == "" || si.ID == "" || !isAbsAnyOS(dir) || strings.ContainsRune(dir, 0) {
		return ""
	}
	for _, seg := range strings.FieldsFunc(dir, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == "." || seg == ".." {
			return ""
		}
	}
	segs := pathSegs(dir)
	n := len(segs)
	if n < 4 || segs[n-1] != "images" || segs[n-2] != si.ID || !claudeTempDir.MatchString(segs[n-4]) {
		return ""
	}
	for _, p := range []string{si.Root, si.Cwd} {
		if p != "" && normRoot(segs[n-3], fold) == normRoot(nonAlnum.ReplaceAllString(p, "-"), fold) {
			return dir
		}
	}
	return ""
}

func (s *Server) handleCreateView(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
		// Images: the path is an image the owner pasted in the terminal; the base is the
		// session's images folder and the link serves that one file.
		Images bool `json:"images"`
		// Read: the path is an image Claude read with the Read tool in this session; the base
		// is its folder and the link serves that one file.
		Read bool `json:"read"`
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
	fold := s.hub.caseInsensitiveOS(m)
	base, only := sessionBase(si.Root, si.Cwd), ""
	switch {
	case b.Images && b.Read:
		base = ""
	case b.Images:
		base = imagesDirOf(si, fold)
	case b.Read:
		base, err = s.readImageBase(si.ID, b.Path)
		if err != nil {
			apiErr(w, 500, "internal error")
			return
		}
	}
	rel, ok := relInside(base, b.Path, fold)
	if b.Images && ok {
		// exactly one pasted image right in the folder
		ok = len(rel) == 1 && pastedImage.MatchString(rel[0])
	}
	if b.Read && ok {
		ok = len(rel) == 1
	}
	if (b.Images || b.Read) && ok {
		only = rel[0]
	}
	if base == "" || !ok {
		if b.Images || b.Read {
			apiErr(w, 403, viewNoImage)
		} else {
			apiErr(w, 403, viewOutside)
		}
		return
	}
	tok, err := s.views.create(m, base, only)
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

// readImageBase returns the folder of p when p is an image Claude read in session sid: an
// absolute path with no "." or ".." segment, an image extension, not a sensitive path, and a
// Read tool_start of exactly p among the session's stored events. Otherwise "".
func (s *Server) readImageBase(sid, p string) (string, error) {
	if !isAbsAnyOS(p) || strings.ContainsRune(p, 0) || !viewguard.IsImage(p) {
		return "", nil
	}
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == "." || seg == ".." {
			return "", nil
		}
	}
	if viewSensitive(strings.Join(pathSegs(p), "/")) {
		return "", nil
	}
	if ok, err := s.st.HasReadOf(sid, p); err != nil || !ok {
		return "", err
	}
	i := strings.LastIndexAny(p, `/\`)
	if i == 0 || (i == 2 && p[1] == ':') {
		return p[:i+1], nil // a file right in the root: "/", "C:\"
	}
	return p[:i], nil
}

// viewSensitive reports whether a cleaned relative path names something a link must never serve.
func viewSensitive(rel string) bool { return viewguard.Sensitive(rel) }

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

// viewRPCFail maps a file_read error to the /v/ response; outside is the refusal text.
func viewRPCFail(w http.ResponseWriter, err error, outside string) {
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
			viewFail(w, 403, outside)
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
	// a pasted-image link does not mention the project folder: the image is simply not available
	outside := viewOutside
	if link.only != "" {
		outside = viewNoImage
	}
	if strings.ContainsAny(rest, "\x00\\") {
		viewFail(w, 403, outside)
		return
	}
	rel := path.Clean(rest)
	if rel == ".." || strings.HasPrefix(rel, "../") || path.IsAbs(rel) || (link.only != "" && rel != link.only) {
		viewFail(w, 403, outside)
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
		if link.only != "" {
			// a single-file image link: the daemon checks the file it resolves to is still an image and not sensitive
			p["imageOnly"] = true
		}
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
				viewRPCFail(w, err, outside)
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
