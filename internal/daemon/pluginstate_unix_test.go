//go:build !windows

package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Only regular files are read: a FIFO or a directory named like a store file is skipped
// (a FIFO would block a plain open), and the real file is still found.
func TestPluginStateSkipsNonRegularFiles(t *testing.T) {
	dir := t.TempDir()
	d := filepath.Join(dir, "plugins", "store")
	if err := os.MkdirAll(filepath.Join(d, "after_better-claude-0dir.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(d, "after_better-claude-1fifo.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeStore(t, dir, "after_better-claude-2real.json", `{"queue:s1":"ok"}`)
	done := make(chan struct{})
	var got json.RawMessage
	var err error
	go func() { got, err = callPluginState(t, dir, "after", "s1"); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("blocked on a FIFO")
	}
	if err != nil || string(got) != `"ok"` {
		t.Fatalf("got %s %v", got, err)
	}
}
