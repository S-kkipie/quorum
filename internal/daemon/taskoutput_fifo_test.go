//go:build linux

package daemon

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestTaskOutputFIFONotFoundPromptly(t *testing.T) {
	ctx, dir := toSetup(t)
	if err := syscall.Mkfifo(filepath.Join(dir, "t1.output"), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan toResult, 1)
	go func() { r, _ := toCall(ctx, toSession, "t1"); done <- r }()
	select {
	case r := <-done:
		if r.Found {
			t.Fatal("a FIFO must not be found")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("handler blocked on a FIFO")
	}
}

func TestFileHoldersSkipsDaemon(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "x.output"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	resolved, _ := filepath.EvalSymlinks(f.Name())
	procs, ok := fileHolders(resolved)
	if !ok {
		t.Skip("no /proc")
	}
	for _, p := range procs {
		if p.Pid == os.Getpid() {
			t.Fatalf("daemon listed as holder: %+v", procs)
		}
	}
}
