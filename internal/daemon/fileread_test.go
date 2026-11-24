package daemon

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func callFileRead(t *testing.T, path, base string, offset int64, length int) (fileReadResult, error) {
	t.Helper()
	p, _ := json.Marshal(map[string]any{"path": path, "base": base, "offset": offset, "length": length})
	res, err := rpcHandlers["file_read"](context.Background(), nil, p)
	if err != nil {
		return fileReadResult{}, err
	}
	return res.(fileReadResult), nil
}

func TestFileReadChunks(t *testing.T) {
	base := t.TempDir()
	orig := bytes.Repeat([]byte("abcdefghij"), 262144) // 2.5 MiB
	orig = orig[:2*1024*1024+512*1024]
	f := filepath.Join(base, "big.bin")
	if err := os.WriteFile(f, orig, 0o600); err != nil {
		t.Fatal(err)
	}
	var got []byte
	var off int64
	chunks := 0
	for {
		r, err := callFileRead(t, f, base, off, 0)
		if err != nil {
			t.Fatal(err)
		}
		d, err := base64.StdEncoding.DecodeString(r.Data)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, d...)
		off += int64(len(d))
		chunks++
		if r.Size != int64(len(orig)) {
			t.Fatalf("size = %d", r.Size)
		}
		if r.EOF {
			break
		}
		if chunks > 10 {
			t.Fatal("too many chunks")
		}
	}
	if chunks != 3 || !bytes.Equal(got, orig) {
		t.Fatalf("chunks=%d equal=%v", chunks, bytes.Equal(got, orig))
	}
}

func TestFileReadRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "proj")
	must(t, os.Mkdir(base, 0o700))
	must(t, os.WriteFile(filepath.Join(root, "secret"), []byte("x"), 0o600))
	_, err := callFileRead(t, base+"/../secret", base, 0, 0)
	if err == nil || err.Error() != "outside the project folder" {
		t.Fatalf("err = %v", err)
	}
}

func TestFileReadRejectsSymlinkOut(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "proj")
	must(t, os.Mkdir(base, 0o700))
	must(t, os.WriteFile(filepath.Join(root, "secret"), []byte("x"), 0o600))
	link := filepath.Join(base, "l")
	if err := os.Symlink(filepath.Join(root, "secret"), link); err != nil {
		t.Skip("no symlinks")
	}
	_, err := callFileRead(t, link, base, 0, 0)
	if err == nil || err.Error() != "outside the project folder" {
		t.Fatalf("err = %v", err)
	}
}

func TestFileReadTooBig(t *testing.T) {
	old := fileReadMaxSize
	fileReadMaxSize = 10
	defer func() { fileReadMaxSize = old }()
	base := t.TempDir()
	f := filepath.Join(base, "a")
	must(t, os.WriteFile(f, make([]byte, 11), 0o600))
	_, err := callFileRead(t, f, base, 0, 0)
	if err == nil || err.Error() != "file too large" {
		t.Fatalf("err = %v", err)
	}
}

func TestFileReadNotRegular(t *testing.T) {
	base := t.TempDir()
	must(t, os.Mkdir(filepath.Join(base, "d"), 0o700))
	_, err := callFileRead(t, filepath.Join(base, "d"), base, 0, 0)
	if err == nil || err.Error() != "not a file" {
		t.Fatalf("err = %v", err)
	}
}

func TestFileReadMissingAndOffsets(t *testing.T) {
	base := t.TempDir()
	_, err := callFileRead(t, filepath.Join(base, "nope"), base, 0, 0)
	if err == nil || err.Error() != "does not exist" {
		t.Fatalf("err = %v", err)
	}
	f := filepath.Join(base, "a")
	must(t, os.WriteFile(f, []byte("hello"), 0o600))
	for _, off := range []int64{-1, 6} {
		if _, err := callFileRead(t, f, base, off, 0); err == nil {
			t.Fatalf("offset %d accepted", off)
		}
	}
	r, err := callFileRead(t, f, base, 5, 0)
	if err != nil || !r.EOF || r.Data != "" {
		t.Fatalf("r=%+v err=%v", r, err)
	}
	if _, err := callFileRead(t, "rel", base, 0, 0); err == nil {
		t.Fatal("relative path accepted")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// Plan 6 Task 10: with a session's pasted-images folder as base, a symbolic link in it that
// leads out (to another session's images or anywhere else) is refused; a real file is served.
func TestFileReadImagesDirSymlinkOut(t *testing.T) {
	root := t.TempDir()
	images := filepath.Join(root, "claude-1000", "-work-proj", "S1", "images")
	other := filepath.Join(root, "claude-1000", "-work-proj", "S2", "images")
	must(t, os.MkdirAll(images, 0o700))
	must(t, os.MkdirAll(other, 0o700))
	must(t, os.WriteFile(filepath.Join(images, "1.png"), []byte("PNG"), 0o600))
	must(t, os.WriteFile(filepath.Join(other, "1.png"), []byte("other"), 0o600))
	if _, err := callFileRead(t, filepath.Join(images, "1.png"), images, 0, 0); err != nil {
		t.Fatalf("own image: %v", err)
	}
	for name, target := range map[string]string{"2.png": filepath.Join(other, "1.png"), "3.png": "/etc/passwd"} {
		if err := os.Symlink(target, filepath.Join(images, name)); err != nil {
			t.Skip("no symlinks")
		}
		_, err := callFileRead(t, filepath.Join(images, name), images, 0, 0)
		if err == nil || err.Error() != "outside the project folder" {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	// a link to a folder inside images that leads out is refused too
	must(t, os.Symlink(other, filepath.Join(images, "d")))
	if _, err := callFileRead(t, filepath.Join(images, "d", "1.png"), images, 0, 0); err == nil || err.Error() != "outside the project folder" {
		t.Fatalf("dir link: err = %v", err)
	}
}
