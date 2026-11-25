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
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Files the owner attaches to a message from the app are uploaded once to the session's machine
// and saved as <user cache dir>/quorum/uploads/<yyyy-mm-dd>/<6 hex>-<sanitized name> (Linux
// ~/.cache/quorum/uploads, Windows %LocalAppData%\quorum\uploads); the prompt then
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
	// a file being written is .<hex>.quorum-part: never a name a sanitized upload can have
	uploadPartSuffix = ".quorum-part"
	// uploadQuota caps the uploads folder (saved files plus the declared sizes in progress).
	uploadQuota int64 = 5 << 30
	// uploadFreeMin is the free disk space an upload must leave.
	uploadFreeMin uint64 = 1 << 30
)

var (
	errUploadOffset = errors.New("offset mismatch")
	errUploadBig    = errors.New("file too large")
	errUploadToken  = errors.New("unknown upload")
	errUploadSize   = errors.New("size mismatch")
	errUploadBusy   = errors.New("too many uploads in progress")
	errUploadDir    = errors.New("the uploads folder is not usable")
	errUploadFull   = errors.New("the uploads folder on the machine is full (5 GB); uploads older than 30 days are deleted")
	errUploadDisk   = errors.New("not enough free disk space on the machine (1 GB must stay free)")
)

// uploadsRoot is the folder uploads live in (a variable for tests).
var uploadsRoot = func() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "quorum", "uploads"), nil
}

// diskFree reports the bytes available to this user on the disk holding path (a variable for tests).
var diskFree = freeSpace

// uploadsUsed adds up the sizes of the regular files under root, symlinks not followed (a variable for tests).
var uploadsUsed = func(root string) int64 {
	var n int64
	_ = filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		// a partial file in progress is counted by its declared size instead
		if info, err := d.Info(); err == nil && info.Mode().IsRegular() && !isPart(d.Name()) {
			n += info.Size()
		}
		return nil
	})
	return n
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
	// no trailing dots (Windows drops them, and "a..pdf" reads badly)
	if stem = strings.TrimRight(stem, ". "); stem == "" {
		stem = "file"
	}
	return stem + ext
}

type pendingUpload struct {
	mu     sync.Mutex
	f      *os.File
	part   string // the file being written
	final  string // where it goes on upload_end
	name   string
	size   int64 // declared size, -1 when unknown (set once, read without mu)
	off    int64
	last   atomic.Int64 // unix nanos of the last chunk (read without mu)
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

// lockedDrop takes u.mu and drops the file.
func (u *pendingUpload) lockedDrop() {
	u.mu.Lock()
	u.drop()
	u.mu.Unlock()
}

// uploadSet holds the uploads in progress. Lock order: s.mu is never held while taking a u.mu,
// and a u.mu is never held while taking s.mu.
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

// hasSpace reports whether p holds whitespace: a mention @<path> ends at the first one.
func hasSpace(p string) bool { return strings.IndexFunc(p, unicode.IsSpace) >= 0 }

// uploadRootDir returns the uploads root (created, and checked to be a real folder whose path a
// mention can carry).
func uploadRootDir() (string, error) {
	root, err := uploadsRoot()
	if err != nil {
		return "", errUploadDir
	}
	if hasSpace(root) {
		return "", fmt.Errorf("the uploads folder %s has a space in its path, which a Claude Code mention cannot hold", root)
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
		return "", errUploadDir
	}
	if err := realDir(root); err != nil {
		return "", errUploadDir
	}
	return root, nil
}

// uploadDayDir returns (creating it) the day's folder under root.
func uploadDayDir(root string, now time.Time) (string, error) {
	day := filepath.Join(root, now.Format("2006-01-02"))
	if err := realDir(day); err != nil {
		return "", errUploadDir
	}
	return day, nil
}

// reapIdle drops the uploads that got no chunk for uploadIdle: the tokens are taken out under
// s.mu, then each file is dropped under its own lock.
func (s *uploadSet) reapIdle(now time.Time) {
	var idle []*pendingUpload
	s.mu.Lock()
	for tok, u := range s.pending {
		if now.Sub(time.Unix(0, u.last.Load())) > uploadIdle {
			idle = append(idle, u)
			delete(s.pending, tok)
		}
	}
	s.mu.Unlock()
	for _, u := range idle {
		u.lockedDrop()
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

// abort takes the upload out and drops its file.
func (s *uploadSet) abort(tok string) {
	if u := s.remove(tok); u != nil {
		u.lockedDrop()
	}
}

func randHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// createPartHook runs before each partial file is created (tests).
var createPartHook = func(dir string) {}

// createPart picks a free final name in dir and creates its partial file.
func createPart(dir, name string) (part, final string, f *os.File, err error) {
	createPartHook(dir)
	for try := 0; try < 8; try++ {
		pre, err := randHex(3)
		if err != nil {
			return "", "", nil, err
		}
		final = filepath.Join(dir, pre+"-"+name)
		if _, err := os.Lstat(final); err == nil {
			continue
		}
		ph, err := randHex(8)
		if err != nil {
			return "", "", nil, err
		}
		part = filepath.Join(dir, "."+ph+uploadPartSuffix)
		// O_EXCL never follows a symlink and never reuses a file
		f, err = os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", "", nil, err
		}
		return part, final, f, nil
	}
	return "", "", nil, os.ErrExist
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
	uploads.reapIdle(now)
	root, err := uploadRootDir()
	if err != nil {
		return nil, err
	}
	// what this upload may take: its declared size, else the most a file may be
	need := size
	if need < 0 {
		need = uploadMaxSize
	}
	uploads.mu.Lock()
	defer uploads.mu.Unlock()
	if len(uploads.pending) >= uploadPendingMax {
		return nil, errUploadBusy
	}
	var inFlight int64
	for _, u := range uploads.pending {
		if u.size >= 0 {
			inFlight += u.size
		} else {
			inFlight += uploadMaxSize
		}
	}
	if uploadsUsed(root)+inFlight+need > uploadQuota {
		return nil, errUploadFull
	}
	if free, err := diskFree(root); err == nil && (free < uploadFreeMin || free-uploadFreeMin < uint64(inFlight+need)) {
		return nil, errUploadDisk
	}
	name := SanitizeUploadName(p.Name, p.Mime)
	var part, final string
	var f *os.File
	// the daily sweep may remove an empty day folder between creating it and the file: once more
	for try := 0; ; try++ {
		dir, err := uploadDayDir(root, now)
		if err != nil {
			return nil, err
		}
		part, final, f, err = createPart(dir, name)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) || try > 0 {
			return nil, errors.New("could not create the file")
		}
	}
	u := &pendingUpload{f: f, part: part, final: final, name: filepath.Base(final), size: size}
	u.last.Store(now.UnixNano())
	tok, err := randHex(16)
	if err != nil {
		u.lockedDrop()
		return nil, err
	}
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
	size, err := u.write(p.Offset, data)
	if errors.Is(err, errUploadBig) || errors.Is(err, errUploadWrite) {
		// the file is already dropped; the token goes once u.mu is released (lock order)
		uploads.remove(p.Token)
	}
	if err != nil {
		return nil, err
	}
	return map[string]int64{"size": size}, nil
}

var errUploadWrite = errors.New("could not write the file")

// write appends data at off under u.mu; on a size or disk error the file is dropped.
func (u *pendingUpload) write(off int64, data []byte) (int64, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return 0, errUploadToken
	}
	if off != u.off {
		return 0, errUploadOffset
	}
	end := u.off + int64(len(data))
	if end > uploadMaxSize || (u.size >= 0 && end > u.size) {
		u.drop()
		return 0, errUploadBig
	}
	if _, err := u.f.Write(data); err != nil {
		u.drop()
		return 0, errUploadWrite
	}
	u.off = end
	u.last.Store(uploadNow().UnixNano())
	return u.off, nil
}

// finalize moves the closed partial file to its final name without ever replacing a file: a
// hard link fails if the name exists; where links are not supported, a checked rename.
func finalize(part, final string) error {
	err := os.Link(part, final)
	if err == nil {
		os.Remove(part)
		return nil
	}
	if errors.Is(err, os.ErrExist) {
		return err
	}
	if _, err := os.Lstat(final); err == nil {
		return os.ErrExist
	}
	return os.Rename(part, final)
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
		return nil, errUploadWrite
	}
	if err := finalize(u.part, u.final); err != nil {
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

// isPart: a partial file name (.<hex>.quorum-part).
func isPart(name string) bool {
	return strings.HasPrefix(name, ".") && strings.HasSuffix(name, uploadPartSuffix)
}

// sweepUploads deletes the uploads older than uploadKeep, the partial files older than a day
// (an upload in progress is never that old) and the day folders left empty. Symlinks are never
// followed nor removed through.
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
			old := info.ModTime().Before(cutoff) || (isPart(f.Name()) && info.ModTime().Before(partCutoff))
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

// runUploadSweep sweeps once at start and then daily, and drops idle uploads every minute,
// until ctx ends.
func runUploadSweep(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("quorumd: uploads sweep: %v", r)
		}
	}()
	day := time.NewTicker(24 * time.Hour)
	defer day.Stop()
	minute := time.NewTicker(time.Minute)
	defer minute.Stop()
	sweepUploads(uploadNow())
	for {
		select {
		case <-ctx.Done():
			return
		case <-day.C:
			sweepUploads(uploadNow())
		case <-minute.C:
			uploads.reapIdle(uploadNow())
		}
	}
}
