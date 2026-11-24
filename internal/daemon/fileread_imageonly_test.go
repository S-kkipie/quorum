package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func callImageOnly(t *testing.T, path, base string) error {
	t.Helper()
	p, _ := json.Marshal(map[string]any{"path": path, "base": base, "offset": 0, "length": 0, "imageOnly": true})
	_, err := rpcHandlers["file_read"](context.Background(), nil, p)
	return err
}

// A single-file image link (pasted or read image): the RESOLVED file must still be an image and
// not a sensitive path, so x.png -> .env (same folder, inside the base) is refused.
func TestFileReadImageOnlyChecksTheResolvedPath(t *testing.T) {
	base := t.TempDir()
	write := func(name, data string) string {
		f := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		return f
	}
	link := func(name, target string) string {
		l := filepath.Join(base, name)
		if err := os.Symlink(target, l); err != nil {
			t.Skip("symlinks unavailable:", err)
		}
		return l
	}
	img := write("shot.png", "PNG")
	env := write(".env", "SECRET=1")
	notes := write("notes.txt", "x")
	key := write(".ssh/id.png", "KEY")
	other := write("real.JPG", "JPG")

	if err := callImageOnly(t, img, base); err != nil {
		t.Fatalf("a plain image: %v", err)
	}
	if err := callImageOnly(t, link("ok.png", other), base); err != nil {
		t.Fatalf("a link to another image: %v", err)
	}
	for name, target := range map[string]string{"x.png": env, "y.png": notes, "z.png": key} {
		if err := callImageOnly(t, link(name, target), base); err != errOutsideBase {
			t.Fatalf("%s -> %s: err = %v, want %v", name, target, err, errOutsideBase)
		}
	}
	// a non-image or sensitive path asked directly is refused too
	for _, p := range []string{env, notes, key} {
		if err := callImageOnly(t, p, base); err != errOutsideBase {
			t.Fatalf("%s: err = %v", p, err)
		}
	}
	// without imageOnly (a project link) the same symlink is served: nothing changes there
	if _, err := callFileRead(t, filepath.Join(base, "y.png"), base, 0, 0); err != nil {
		t.Fatalf("project link: %v", err)
	}
}
