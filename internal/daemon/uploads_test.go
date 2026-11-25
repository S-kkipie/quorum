package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSanitizeUploadName(t *testing.T) {
	long := strings.Repeat("a", 150)
	cases := []struct{ name, mime, want string }{
		{"photo.jpg", "image/jpeg", "photo.jpg"},
		{"Café niño.PNG", "image/png", "Cafe_nino.PNG"},
		{"Ångström résumé.pdf", "", "Angstrom_resume.pdf"},
		{"../../etc/passwd", "", "passwd"},
		{`C:\Users\u\Desktop\report.docx`, "", "report.docx"},
		{"..hidden", "", "file.hidden"},
		{".._.secret.tar", "", "secret.tar"},
		{"...", "image/png", "file.png"},
		{"__init__.py", "", "init__.py"},
		{"._.x", "", "file.x"},
		{"a b&c.txt", "text/plain", "a_b_c.txt"},
		{"image", "image/jpeg", "image.jpg"},
		{"clip", "video/quicktime", "clip.mov"},
		{"noext", "application/x-unknown", "noext"},
		{"", "", "file"},
		{"日本語.txt", "", "file.txt"},
		{long + ".pdf", "", strings.Repeat("a", 96) + ".pdf"},
		{long, "", strings.Repeat("a", 100)},
		{"emoji😀.png", "", "emoji_.png"},
		{"a..pdf", "", "a.pdf"},
		{"report. .pdf", "", "report._.pdf"},
		{"x" + strings.Repeat(".", 120), "", "x"},
	}
	for _, c := range cases {
		got := SanitizeUploadName(c.name, c.mime)
		require.Equal(t, c.want, got, "name %q", c.name)
		require.LessOrEqual(t, len(got), 100)
		require.Regexp(t, `^[A-Za-z0-9][\w.-]*$`, got)
	}
}

// uploadFx points the uploads at a temp folder and returns it.
func uploadFx(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "cfg", "uploads")
	old := uploadsRoot
	uploadsRoot = func() (string, error) { return root, nil }
	t.Cleanup(func() {
		uploadsRoot = old
		uploads.reapIdle(time.Now().Add(100 * 365 * 24 * time.Hour)) // drops every upload left
	})
	return root
}

func callUp(t *testing.T, method string, params any) (map[string]any, error) {
	t.Helper()
	p, _ := json.Marshal(params)
	res, err := rpcHandlers[method](context.Background(), nil, p)
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(res)
	var out map[string]any
	require.NoError(t, json.Unmarshal(b, &out))
	return out, nil
}

func beginUp(t *testing.T, name, mime string, size int) string {
	t.Helper()
	out, err := callUp(t, "upload_begin", map[string]any{"name": name, "mime": mime, "size": size})
	require.NoError(t, err)
	return out["token"].(string)
}

func TestUploadChunksReassemble(t *testing.T) {
	root := uploadFx(t)
	data := make([]byte, 2*uploadChunkMax+12345)
	_, _ = rand.Read(data)
	out, err := callUp(t, "upload_begin", map[string]any{"name": "Vidéo clip", "mime": "video/mp4", "size": len(data)})
	require.NoError(t, err)
	tok := out["token"].(string)
	path := out["path"].(string)
	day := time.Now().Format("2006-01-02")
	require.Equal(t, filepath.Join(root, day), filepath.Dir(path))
	require.Regexp(t, regexp.MustCompile(`^[0-9a-f]{6}-Video_clip\.mp4$`), filepath.Base(path))
	_, err = os.Lstat(path)
	require.True(t, os.IsNotExist(err), "the final file appears only on upload_end")
	for off := 0; off < len(data); off += uploadChunkMax {
		end := min(off+uploadChunkMax, len(data))
		_, err := callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": off, "data": base64.StdEncoding.EncodeToString(data[off:end])})
		require.NoError(t, err)
	}
	res, err := callUp(t, "upload_end", map[string]any{"token": tok})
	require.NoError(t, err)
	require.Equal(t, path, res["path"])
	require.Equal(t, filepath.Base(path), res["name"])
	require.EqualValues(t, len(data), res["size"])
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.True(t, bytes.Equal(data, got))
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(path)
		require.Equal(t, os.FileMode(0o600), st.Mode().Perm())
		dst, _ := os.Stat(filepath.Dir(path))
		require.Equal(t, os.FileMode(0o700), dst.Mode().Perm())
		rst, _ := os.Stat(root)
		require.Equal(t, os.FileMode(0o700), rst.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	require.Len(t, entries, 1, "no partial file left")
	// the token is spent
	_, err = callUp(t, "upload_end", map[string]any{"token": tok})
	require.ErrorIs(t, err, errUploadToken)
}

func TestUploadOffsetMismatch(t *testing.T) {
	uploadFx(t)
	tok := beginUp(t, "a.txt", "text/plain", 6)
	_, err := callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 3, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.ErrorIs(t, err, errUploadOffset)
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.NoError(t, err)
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.ErrorIs(t, err, errUploadOffset, "a replayed chunk is refused")
}

func TestUploadSizeCap(t *testing.T) {
	root := uploadFx(t)
	_, err := callUp(t, "upload_begin", map[string]any{"name": "big.bin", "size": uploadMaxSize + 1})
	require.ErrorIs(t, err, errUploadBig)
	// more bytes than declared: refused and the partial file is gone
	tok := beginUp(t, "small.bin", "", 2)
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.ErrorIs(t, err, errUploadBig)
	requireNoFiles(t, root)
	// a chunk over 1 MiB is refused
	tok = beginUp(t, "c.bin", "", uploadChunkMax+1)
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString(make([]byte, uploadChunkMax+1))})
	require.Error(t, err)
	requireNoFiles(t, root)
	// fewer bytes than declared: upload_end fails and cleans up
	tok = beginUp(t, "d.bin", "", 10)
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.NoError(t, err)
	_, err = callUp(t, "upload_end", map[string]any{"token": tok})
	require.ErrorIs(t, err, errUploadSize)
	requireNoFiles(t, root)
}

func TestUploadAbortCleansPartial(t *testing.T) {
	root := uploadFx(t)
	tok := beginUp(t, "a.txt", "text/plain", 6)
	_, err := callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.NoError(t, err)
	_, err = callUp(t, "upload_abort", map[string]any{"token": tok})
	require.NoError(t, err)
	requireNoFiles(t, root)
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 3, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.ErrorIs(t, err, errUploadToken)
}

func TestUploadIdleReaped(t *testing.T) {
	root := uploadFx(t)
	now := time.Now()
	old := uploadNow
	uploadNow = func() time.Time { return now }
	t.Cleanup(func() { uploadNow = old })
	tok := beginUp(t, "a.txt", "", 3)
	now = now.Add(uploadIdle + time.Second)
	beginUp(t, "b.txt", "", 3)
	_, err := callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
	require.ErrorIs(t, err, errUploadToken)
	n := 0
	_ = filepath.WalkDir(root, func(_ string, d os.DirEntry, _ error) error {
		if d != nil && !d.IsDir() {
			n++
		}
		return nil
	})
	require.Equal(t, 1, n, "only b's partial file is left")
}

func TestUploadRefusesSymlinkedFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root := uploadFx(t)
	elsewhere := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Dir(root), 0o700))
	require.NoError(t, os.Symlink(elsewhere, root))
	_, err := callUp(t, "upload_begin", map[string]any{"name": "a.txt", "size": 1})
	require.ErrorIs(t, err, errUploadDir)
	require.NoError(t, os.Remove(root))
	require.NoError(t, os.Mkdir(root, 0o700))
	day := filepath.Join(root, time.Now().Format("2006-01-02"))
	require.NoError(t, os.Symlink(elsewhere, day))
	_, err = callUp(t, "upload_begin", map[string]any{"name": "a.txt", "size": 1})
	require.ErrorIs(t, err, errUploadDir)
	entries, _ := os.ReadDir(elsewhere)
	require.Empty(t, entries)
}

func TestSweepUploads(t *testing.T) {
	root := uploadFx(t)
	now := time.Now()
	mk := func(rel string, age time.Duration) string {
		p := filepath.Join(root, rel)
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o700))
		require.NoError(t, os.WriteFile(p, []byte("x"), 0o600))
		at := now.Add(-age)
		require.NoError(t, os.Chtimes(p, at, at))
		return p
	}
	oldF := mk("2020-01-01/abcdef-old.png", 31*24*time.Hour)
	newF := mk("2026-11-20/abcdef-new.png", 29*24*time.Hour)
	mixedOld := mk("2026-11-21/aaaaaa-a.png", 40*24*time.Hour)
	mixedNew := mk("2026-11-21/bbbbbb-b.png", time.Hour)
	stalePart := mk("2026-11-21/.0123456789abcdef.quorum-part", 2*24*time.Hour)
	freshPart := mk("2026-11-21/.fedcba9876543210.quorum-part", time.Minute)
	// an upload that happens to be named like a partial file keeps its 30 days
	realPart := mk("2026-11-21/eeeeee-backup.part", 2*24*time.Hour)
	if runtime.GOOS != "windows" {
		// a symlink is never followed: its target survives
		target := filepath.Join(t.TempDir(), "keep.txt")
		require.NoError(t, os.WriteFile(target, []byte("x"), 0o600))
		old := now.Add(-60 * 24 * time.Hour)
		require.NoError(t, os.Chtimes(target, old, old))
		require.NoError(t, os.Symlink(filepath.Dir(target), filepath.Join(root, "2019-01-01")))
		defer func() { _, err := os.Stat(target); require.NoError(t, err) }()
	}
	sweepUploads(now)
	for _, p := range []string{oldF, mixedOld, stalePart} {
		_, err := os.Lstat(p)
		require.True(t, os.IsNotExist(err), p)
	}
	for _, p := range []string{newF, mixedNew, freshPart, realPart} {
		_, err := os.Lstat(p)
		require.NoError(t, err, p)
	}
	_, err := os.Lstat(filepath.Join(root, "2020-01-01"))
	require.True(t, os.IsNotExist(err), "an emptied day folder is removed")
}

func requireNoFiles(t *testing.T, root string) {
	t.Helper()
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, _ error) error {
		if d != nil && !d.IsDir() {
			t.Fatalf("unexpected file %s", p)
		}
		return nil
	})
}

// I1: an over-size chunk (drops under u.mu, then removes the token) racing begins (reap under
// s.mu) must never deadlock.
func TestUploadChunkAndBeginDoNotDeadlock(t *testing.T) {
	uploadFx(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			tok := beginUp(t, "a.bin", "", 1)
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				_, _ = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("abc"))})
			}()
			go func() {
				defer wg.Done()
				if tk, err := callUp(t, "upload_begin", map[string]any{"name": "b.bin", "size": 1}); err == nil {
					_, _ = callUp(t, "upload_abort", map[string]any{"token": tk["token"]})
				}
				uploads.reapIdle(time.Now())
			}()
			wg.Wait()
		}
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("deadlock between upload_chunk and upload_begin")
	}
}

func TestUploadQuotaAndFreeSpace(t *testing.T) {
	uploadFx(t)
	oldUsed, oldFree := uploadsUsed, diskFree
	t.Cleanup(func() { uploadsUsed, diskFree = oldUsed, oldFree })
	used := uploadQuota - 10
	free := uint64(100 << 30)
	uploadsUsed = func(string) int64 { return used }
	diskFree = func(string) (uint64, error) { return free, nil }

	_, err := callUp(t, "upload_begin", map[string]any{"name": "a.bin", "size": 11})
	require.ErrorIs(t, err, errUploadFull)
	require.Contains(t, err.Error(), "5 GB")
	tok := beginUp(t, "a.bin", "", 6)
	// the size declared by an upload in progress counts too
	_, err = callUp(t, "upload_begin", map[string]any{"name": "b.bin", "size": 5})
	require.ErrorIs(t, err, errUploadFull)
	_, err = callUp(t, "upload_begin", map[string]any{"name": "b.bin", "size": 4})
	require.NoError(t, err)
	_, _ = callUp(t, "upload_abort", map[string]any{"token": tok})
	// an unknown size reserves the largest file
	used = uploadQuota - uploadMaxSize
	_, err = callUp(t, "upload_begin", map[string]any{"name": "c.bin"})
	require.ErrorIs(t, err, errUploadFull)

	used = 0
	free = uploadFreeMin + 100
	_, err = callUp(t, "upload_begin", map[string]any{"name": "d.bin", "size": 101})
	require.ErrorIs(t, err, errUploadDisk)
	require.Contains(t, err.Error(), "1 GB")
	_, err = callUp(t, "upload_begin", map[string]any{"name": "d.bin", "size": 50})
	require.NoError(t, err)
	free = uploadFreeMin - 1
	_, err = callUp(t, "upload_begin", map[string]any{"name": "e.bin", "size": 0})
	require.ErrorIs(t, err, errUploadDisk)
}

func TestUploadsUsedCountsSavedFilesOnly(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "2026-11-25"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "2026-11-25", "abcdef-a.bin"), make([]byte, 7), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(root, "2026-11-25", ".0011223344556677.quorum-part"), make([]byte, 5), 0o600))
	require.EqualValues(t, 7, uploadsUsed(root))
	free, err := freeSpace(root)
	require.NoError(t, err)
	require.Greater(t, free, uint64(0))
}

func TestUploadRefusesRootWithSpace(t *testing.T) {
	uploadFx(t)
	root := filepath.Join(t.TempDir(), "my files", "uploads")
	uploadsRoot = func() (string, error) { return root, nil }
	_, err := callUp(t, "upload_begin", map[string]any{"name": "a.txt", "size": 1})
	require.Error(t, err)
	require.Contains(t, err.Error(), "has a space in its path")
	_, err = os.Lstat(root)
	require.True(t, os.IsNotExist(err), "nothing is created")
}

func TestUploadsRootIsUserCache(t *testing.T) {
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Skip("no user cache dir")
	}
	root, err := uploadsRoot()
	require.NoError(t, err)
	require.Equal(t, filepath.Join(cache, "quorum", "uploads"), root)
}

func TestUploadPartNameAndNoReplace(t *testing.T) {
	root := uploadFx(t)
	out, err := callUp(t, "upload_begin", map[string]any{"name": "a.txt", "size": 3})
	require.NoError(t, err)
	tok, final := out["token"].(string), out["path"].(string)
	entries, _ := os.ReadDir(filepath.Join(root, time.Now().Format("2006-01-02")))
	require.Len(t, entries, 1)
	require.Regexp(t, `^\.[0-9a-f]{16}\.quorum-part$`, entries[0].Name())
	_, err = callUp(t, "upload_chunk", map[string]any{"token": tok, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("new"))})
	require.NoError(t, err)
	// a file that appeared at the final name meanwhile is never replaced
	require.NoError(t, os.WriteFile(final, []byte("old"), 0o600))
	_, err = callUp(t, "upload_end", map[string]any{"token": tok})
	require.Error(t, err)
	got, _ := os.ReadFile(final)
	require.Equal(t, "old", string(got))
	entries, _ = os.ReadDir(filepath.Dir(final))
	require.Len(t, entries, 1, "the partial file is gone")
}

func TestUploadRecreatesDayFolderRemovedBySweep(t *testing.T) {
	uploadFx(t)
	old := createPartHook
	t.Cleanup(func() { createPartHook = old })
	n := 0
	createPartHook = func(dir string) {
		if n++; n == 1 {
			require.NoError(t, os.Remove(dir)) // the sweep removed the empty folder just now
		}
	}
	out, err := callUp(t, "upload_begin", map[string]any{"name": "a.txt", "size": 1})
	require.NoError(t, err)
	require.Equal(t, 2, n)
	_, err = os.Stat(filepath.Dir(out["path"].(string)))
	require.NoError(t, err)
}
