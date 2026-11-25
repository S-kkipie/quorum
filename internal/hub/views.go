package hub

import (
	"context"
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
	viewMaxSize   = 100 << 20
	viewGoneText  = "Open it again from Quorum"
	viewOutside   = "outside the project folder"
	viewNoImage   = "This image is not available."
	viewNoFile    = "This file is not available."
	viewDenied    = "this file is not served"
	viewNotFound  = "File not found in this project's folders"
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
	// upload: a file a device attached to a message; any type, so the daemon does not check it is an image
	upload  bool
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
	return v.createLink(viewLink{machine: machine, base: base, only: only})
}

// createLink stores l (its expiry is set here) under a new token.
func (v *viewLinks) createLink(l viewLink) (string, error) {
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
	l.expires = now.Add(viewTTL)
	v.links[tok] = l
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
		// Upload: the path is a file a device attached to a message of this session (recorded by
		// the hub when it was uploaded); the base is its folder and the link serves that one file.
		Upload bool `json:"upload"`
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
	var base, only string
	var rel []string
	ok := false
	single := b.Images || b.Read || b.Upload
	switch {
	case (b.Images && b.Read) || (b.Upload && (b.Images || b.Read)):
		base = ""
	case b.Upload:
		var file string
		base, file, ok, err = s.uploadBase(si.ID, b.Path)
		if err != nil {
			apiErr(w, 500, "internal error")
			return
		}
		rel = []string{file}
	case b.Images:
		base = imagesDirOf(si, fold)
	case b.Read:
		base, err = s.readImageBase(si.ID, b.Path)
		if err != nil {
			apiErr(w, 500, "internal error")
			return
		}
	default:
		base, rel, ok = s.viewBaseOf(r.Context(), m, si, b.Path, fold)
	}
	if b.Images || b.Read {
		rel, ok = relInside(base, b.Path, fold)
	}
	if b.Upload && ok && viewSensitive(rel[0]) {
		ok = false
	}
	if b.Images && ok {
		// exactly one pasted image right in the folder
		ok = len(rel) == 1 && pastedImage.MatchString(rel[0])
	}
	if b.Read && ok {
		ok = len(rel) == 1
	}
	if single && ok {
		only = rel[0]
	}
	if base == "" || !ok {
		if b.Upload {
			apiErr(w, 403, viewDenied)
		} else if b.Images || b.Read {
			apiErr(w, 403, viewNoImage)
		} else {
			apiErr(w, 403, viewOutside)
		}
		return
	}
	tok, err := s.views.createLink(viewLink{machine: m, base: base, only: only, upload: b.Upload})
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

// viewBases are the folders a session's view links may serve from: its base (root, else cwd),
// then the git worktrees of its repo the daemon reported (absolute, without duplicates).
func viewBases(si proto.SessionInfo, fold bool) []string {
	out := []string{sessionBase(si.Root, si.Cwd)}
	seen := map[string]bool{normRoot(out[0], fold): true}
	for _, w := range si.Worktrees {
		if len(out) >= 1+maxViewWorktrees {
			break
		}
		if !worktreeOK(w) || seen[normRoot(w, fold)] {
			continue
		}
		seen[normRoot(w, fold)] = true
		out = append(out, w)
	}
	return out
}

// worktreeOK: an absolute folder with no NUL, no "." or ".." segment, and not a bare root ("/", "C:\\").
func worktreeOK(w string) bool {
	if !isAbsAnyOS(w) || strings.ContainsRune(w, 0) {
		return false
	}
	for _, seg := range strings.FieldsFunc(w, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == "." || seg == ".." {
			return false
		}
	}
	segs := pathSegs(w)
	return len(segs) > 1 || (len(segs) == 1 && !(len(segs[0]) == 2 && segs[0][1] == ':'))
}

// maxViewWorktrees caps the worktrees a link may be looked up in.
const maxViewWorktrees = 20

// viewBaseOf picks the base of a link to p and p's segments below it: the first of viewBases
// holding p. When that is the session base and the session has worktrees, the app may have joined a
// path relative to a worktree onto the session base: the daemon is asked which of the session base
// and each worktree (same relative path) has the file, and the first that does is used. Any failure
// of that question keeps the session base (an older daemon never reports worktrees).
func (s *Server) viewBaseOf(ctx context.Context, m string, si proto.SessionInfo, p string, fold bool) (string, []string, bool) {
	bases := viewBases(si, fold)
	for i, b := range bases {
		rel, ok := relInside(b, p, fold)
		if !ok {
			continue
		}
		if i > 0 || len(bases) == 1 || len(rel) == 0 || viewSensitive(strings.Join(rel, "/")) {
			return b, rel, true
		}
		paths, cands := []string{p}, []string{b}
		for _, w := range bases[1:] {
			paths = append(paths, strings.TrimRight(strings.ReplaceAll(w, `\`, "/"), "/")+"/"+strings.Join(rel, "/"))
			cands = append(cands, w)
		}
		var out struct {
			Index int `json:"index"`
		}
		if err := s.hub.call(ctx, m, "file_stat", map[string]any{"paths": paths, "bases": cands}, &out); err == nil && out.Index > 0 && out.Index < len(cands) {
			return cands[out.Index], rel, true
		}
		return b, rel, true
	}
	return "", nil, false
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
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
	".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
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
		case msg == "does not exist":
			viewFail(w, 404, viewNotFound)
		case msg == "not a file":
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
	if link.upload {
		outside = viewNoFile
	} else if link.only != "" {
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
	h.Set("Accept-Ranges", "bytes")
	// a single "bytes=a-b" or "bytes=a-" range (what a <video> asks for); anything else gets the whole file
	start, last, ranged := int64(0), int64(-1), false
	if r.Method == http.MethodGet {
		start, last, ranged = parseRange(r.Header.Get("Range"))
	}
	off := start
	var end int64 // last byte served, inclusive
	for first := true; ; first = false {
		var out struct {
			Data string `json:"data"`
			Size int64  `json:"size"`
			EOF  bool   `json:"eof"`
		}
		p := map[string]any{"path": full, "base": link.base, "offset": off, "length": viewChunk}
		if link.only != "" && !link.upload {
			// a single-file image link: the daemon checks the file it resolves to is still an image and not sensitive
			p["imageOnly"] = true
		}
		err := s.hub.call(r.Context(), link.machine, "file_read", p, &out)
		var data []byte
		if err == nil {
			data, err = base64.StdEncoding.DecodeString(out.Data)
		}
		if first {
			var de daemonError
			if ranged && errors.As(err, &de) && string(de) == "invalid offset" {
				h.Set("Content-Range", "bytes */*")
				viewFail(w, http.StatusRequestedRangeNotSatisfiable, "range not satisfiable")
				return
			}
			if err == nil && out.Size > viewMaxSize {
				viewFail(w, 413, "file too large")
				return
			}
			if err != nil {
				viewRPCFail(w, err, outside)
				return
			}
			end = out.Size - 1
			if ranged && last >= 0 && last < end {
				end = last
			}
			if ranged && start >= out.Size {
				h.Set("Content-Range", "bytes */"+strconv.FormatInt(out.Size, 10))
				viewFail(w, http.StatusRequestedRangeNotSatisfiable, "range not satisfiable")
				return
			}
			h.Set("Content-Type", viewContentType(rel))
			h.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
			code := 200
			if ranged {
				code = http.StatusPartialContent
				h.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(out.Size, 10))
			}
			_ = rc.SetWriteDeadline(time.Now().Add(viewWriteWait)) // ErrNotSupported is fine
			w.WriteHeader(code)
			if r.Method == http.MethodHead {
				return
			}
		} else if err != nil {
			panic(http.ErrAbortHandler) // headers already sent: cut the response
		}
		if rest := end - off + 1; int64(len(data)) > rest {
			data = data[:max(rest, 0)]
		}
		_ = rc.SetWriteDeadline(time.Now().Add(viewWriteWait)) // ErrNotSupported is fine
		if _, err := w.Write(data); err != nil {
			return
		}
		_ = rc.Flush()
		off += int64(len(data))
		if out.EOF || off > end || off >= out.Size {
			return
		}
		if len(data) == 0 {
			panic(http.ErrAbortHandler) // no progress and no eof
		}
	}
}

// parseRange reads a single "bytes=a-b" or "bytes=a-" range; ok is false for anything else
// (no header, suffix ranges, several ranges), which is then served whole.
func parseRange(v string) (start, last int64, ok bool) {
	spec, found := strings.CutPrefix(strings.TrimSpace(v), "bytes=")
	if !found || strings.Contains(spec, ",") {
		return 0, -1, false
	}
	a, b, found := strings.Cut(strings.TrimSpace(spec), "-")
	if !found || a == "" {
		return 0, -1, false
	}
	start, err := strconv.ParseInt(a, 10, 64)
	if err != nil || start < 0 {
		return 0, -1, false
	}
	last = -1
	if b != "" {
		if last, err = strconv.ParseInt(b, 10, 64); err != nil || last < start {
			return 0, -1, false
		}
	}
	return start, last, true
}
