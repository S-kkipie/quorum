//go:build !windows

package daemon

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestFileReadFIFO(t *testing.T) {
	base := t.TempDir()
	fifo := filepath.Join(base, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skip("no mkfifo")
	}
	done := make(chan error, 1)
	go func() {
		_, err := callFileRead(t, fifo, base, 0, 0)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || err.Error() != "not a file" {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("file_read blocked on a FIFO")
	}
}
