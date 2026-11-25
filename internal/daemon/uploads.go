package daemon

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Files the owner attaches to a message from the app are uploaded once to the session's machine
// and saved as <config dir>/uploads/<yyyy-mm-dd>/<6 hex>-<sanitized name>; the prompt then
// mentions them as @<absolute path>. The hub streams each file as upload_begin, upload_chunk
// (in order, base64, at most uploadChunkMax bytes) and upload_end; upload_abort drops it.

const (
	uploadMaxSize  int64 = 100 << 20
	uploadChunkMax       = 1 << 20
	uploadNameMax        = 100
	// uploadKeep: an upload older than this is deleted by the daily sweep.
	uploadKeep = 30 * 24 * time.Hour
	// uploadIdle: a pending upload with no chunk for this long is dropped (the hub went away).
	uploadIdle = 5 * time.Minute
	// uploadPendingMax caps the uploads in progress at once.
	uploadPendingMax = 16
	uploadPartSuffix = ".part"
)

var (
	errUploadOffset = errors.New("offset mismatch")
	errUploadBig    = errors.New("file too large")
	errUploadToken  = errors.New("unknown upload")
	errUploadSize   = errors.New("size mismatch")
	errUploadBusy   = errors.New("too many uploads in progress")
	errUploadDir    = errors.New("the uploads folder is not usable")
)

// uploadsRoot is the folder uploads live in (a variable for tests).
var uploadsRoot = func() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "uploads"), nil
}

// uploadNow is the clock of the uploads (a variable for tests).
var uploadNow = time.Now

// mimeExt gives the extension added to a name that has none.
var mimeExt = map[string]string{
	"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
	"image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif", "image/bmp": ".bmp", "image/svg+xml": ".svg",
	"video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/3gpp": ".3gp", "video/x-matroska": ".mkv",
	"audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/webm": ".weba",
	"application/pdf": ".pdf", "application/zip": ".zip", "application/json": ".json",
	"text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "text/html": ".html",
}

// SanitizeUploadName turns a file name from a device into a safe one: its basename, accents
// stripped, anything outside [A-Za-z0-9_.-] made "_", leading dots and underscores removed (a name left without one
// becomes "file"), at most 100 characters (the extension is kept), and an extension from mime when it has none.
func SanitizeUploadName(name, mime string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	for _, r := range norm.NFD.String(name) {
		switch {
		case unicode.Is(unicode.Mn, r):
			// a combining accent: dropped
		case r < utf8.RuneSelf && (r == '.' || r == '-' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'):
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	stem, ext := out, ""
	if i := strings.LastIndexByte(out, '.'); i >= 0 && len(out)-i > 1 && len(out)-i <= 16 {
		stem, ext = out[:i], out[i:]
	}
	stem = strings.TrimLeft(stem, "._")
	if ext == "" {
		if e, ok := mimeExt[strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))]; ok {
			ext = e
		}
	}
	if stem == "" {
		stem = "file"
	}
	if len(stem)+len(ext) > uploadNameMax {
		stem = stem[:uploadNameMax-len(ext)]
	}
	return stem + ext
}

type pendingUpload struct {
	mu     sync.Mutex
	f      *os.File
	part   string // the file being written
	final  string // where it goes on upload_end
	name   string
	size   int64 // declared size, -1 when unknown
	off    int64
	last   time.Time
	closed bool
}

// drop closes and removes the partial file (the caller holds u.mu).
func (u *pendingUpload) drop() {
	if u.closed {
		return
	}
	u.closed = true
	u.f.Close()
	os.Remove(u.part)
}

type uploadSet struct {
	mu      sync.Mutex
	pending map[string]*pendingUpload
}

var uploads = &uploadSet{pending: map[string]*pendingUpload{}}

func init() {
	rpcHandlers["upload_begin"] = rpcUploadBegin
	rpcHandlers["upload_chunk"] = rpcUploadChunk
	rpcHandlers["upload_end"] = rpcUploadEnd
	rpcHandlers["upload_abort"] = rpcUploadAbort
}

// realDir makes sure dir is a directory and not a symlink, creating it (0700) if missing.
func realDir(dir string) error {
	st, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		st, err = os.Lstat(dir)
	}
	if err != nil {
		return err
	}
	if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		return errUploadDir
	}
	return nil
}

// uploadDayDir returns (creating it) today's uploads folder.
func uploadDayDir(now time.Time) (string, error) {
	root, err := uploadsRoot()
	if err != nil {
		return "", errUploadDir
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
		return "", errUploadDir
	}
	if err := realDir(root); err != nil {
		return "", errUploadDir
	}
	day := filepath.Join(root, now.Format("2006-01-02"))
	if err := realDir(day); err != nil {
		return "", errUploadDir
	}
	return day, nil
}

// reapIdle drops the uploads that got no chunk for uploadIdle (the caller holds s.mu).
func (s *uploadSet) reapIdle(now time.Time) {
	for tok, u := range s.pending {
		u.mu.Lock()
		if now.Sub(u.last) > uploadIdle {
			u.drop()
			delete(s.pending, tok)
		}
		u.mu.Unlock()
	}
}

func (s *uploadSet) get(tok string) *pendingUpload {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending[tok]
}

func (s *uploadSet) remove(tok string) *pendingUpload {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.pending[tok]
	delete(s.pending, tok)
	return u
}

func rpcUploadBegin(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		Name string `json:"name"`
		Mime string `json:"mime"`
		Size *int64 `json:"size"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	size := int64(-1)
	if p.Size != nil {
		size = *p.Size
	}
	if size > uploadMaxSize {
		return nil, errUploadBig
	}
	now := uploadNow()
	uploads.mu.Lock()
	defer uploads.mu.Unlock()
	uploads.reapIdle(now)
	if len(uploads.pending) >= uploadPendingMax {
		return nil, errUploadBusy
	}
	dir, err := uploadDayDir(now)
	if err != nil {
		return nil, err
	}
	name := SanitizeUploadName(p.Name, p.Mime)
	var u *pendingUpload
	for try := 0; try < 8 && u == nil; try++ {
		var b [3]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		final := filepath.Join(dir, hex.EncodeToString(b[:])+"-"+name)
		if _, err := os.Lstat(final); err == nil {
			continue
		}
		part := final + uploadPartSuffix
		// O_EXCL never follows a symlink and never reuses a file
		f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("could not create the file")
		}
		u = &pendingUpload{f: f, part: part, final: final, name: filepath.Base(final), size: size, last: now}
	}
	if u == nil {
		return nil, fmt.Errorf("could not create the file")
	}
	var t [16]byte
	if _, err := rand.Read(t[:]); err != nil {
		u.drop()
		return nil, err
	}
	tok := hex.EncodeToString(t[:])
	uploads.pending[tok] = u
	return map[string]any{"token": tok, "path": u.final, "name": u.name}, nil
}

func rpcUploadChunk(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		Token  string `json:"token"`
		Offset int64  `json:"offset"`
		Data   string `json:"data"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	u := uploads.get(p.Token)
	if u == nil {
		return nil, errUploadToken
	}
	if base64.StdEncoding.DecodedLen(len(p.Data)) > uploadChunkMax+3 {
		uploads.abort(p.Token)
		return nil, errors.New("chunk too large")
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil || len(data) > uploadChunkMax {
		uploads.abort(p.Token)
		return nil, errors.New("invalid chunk")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return nil, errUploadToken
	}
	if p.Offset != u.off {
		return nil, errUploadOffset
	}
	end := u.off + int64(len(data))
	if end > uploadMaxSize || (u.size >= 0 && end > u.size) {
		u.drop()
		uploads.remove(p.Token)
		return nil, errUploadBig
	}
	if _, err := u.f.Write(data); err != nil {
		u.drop()
		uploads.remove(p.Token)
		return nil, errors.New("could not write the file")
	}
	u.off = end
	u.last = uploadNow()
	return map[string]int64{"size": u.off}, nil
}

func (s *uploadSet) abort(tok string) {
	if u := s.remove(tok); u != nil {
		u.mu.Lock()
		u.drop()
		u.mu.Unlock()
	}
}

func rpcUploadEnd(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		Token string `json:"token"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	u := uploads.remove(p.Token)
	if u == nil {
		return nil, errUploadToken
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return nil, errUploadToken
	}
	if u.size >= 0 && u.off != u.size {
		u.drop()
		return nil, errUploadSize
	}
	u.closed = true
	if err := u.f.Close(); err != nil {
		os.Remove(u.part)
		return nil, errors.New("could not write the file")
	}
	if _, err := os.Lstat(u.final); err == nil {
		os.Remove(u.part)
		return nil, errors.New("could not save the file")
	}
	if err := os.Rename(u.part, u.final); err != nil {
		os.Remove(u.part)
		return nil, errors.New("could not save the file")
	}
	return map[string]any{"path": u.final, "name": u.name, "size": u.off}, nil
}

func rpcUploadAbort(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		Token string `json:"token"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	uploads.abort(p.Token)
	return map[string]bool{"ok": true}, nil
}

// sweepUploads deletes the uploads (and stray partial files) older than uploadKeep and the
// day folders left empty. Symlinks are never followed nor removed through.
func sweepUploads(now time.Time) {
	root, err := uploadsRoot()
	if err != nil {
		return
	}
	if st, err := os.Lstat(root); err != nil || st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		return
	}
	days, err := os.ReadDir(root)
	if err != nil {
		return
	}
	cutoff := now.Add(-uploadKeep)
	partCutoff := now.Add(-24 * time.Hour)
	for _, d := range days {
		if d.Type()&os.ModeSymlink != 0 || !d.IsDir() {
			continue
		}
		dir := filepath.Join(root, d.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		left := 0
		for _, f := range files {
			info, err := f.Info() // lstat
			if err != nil {
				left++
				continue
			}
			old := info.ModTime().Before(cutoff)
			if strings.HasSuffix(f.Name(), uploadPartSuffix) && info.ModTime().Before(partCutoff) {
				old = true
			}
			if old && (info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
				if os.Remove(filepath.Join(dir, f.Name())) == nil {
					continue
				}
			}
			left++
		}
		if left == 0 {
			os.Remove(dir) // only succeeds when empty
		}
	}
}

// runUploadSweep sweeps once at start and then daily until ctx ends.
func runUploadSweep(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("quorumd: uploads sweep: %v", r)
		}
	}()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		sweepUploads(uploadNow())
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
