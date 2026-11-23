//go:build !windows

package connectors

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The timeout kills the process group: the grandchild does not stay alive.
func TestExecTimeoutKillsGrandchild(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	c0, _ := newExec(cfg(t, "orphan", "pidfile", pidfile), "", os.Environ(), 500*time.Millisecond)
	_, err0 := c0.List(context.Background(), 0)
	require.ErrorContains(t, err0, "timed out")
	pb, rerr := os.ReadFile(pidfile)
	require.NoError(t, rerr)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(pb)))
	require.Eventually(t, func() bool { return syscall.Kill(pid, 0) != nil }, 3*time.Second, 50*time.Millisecond, "the child is still alive")
}

// gh goes through the login shell: the profile's PATH applies and the arguments arrive intact.
func TestDefaultGhRunnerLoginShell(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "bin")
	require.NoError(t, os.MkdirAll(bin, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(home, ".bash_profile"), []byte("export PATH="+bin+":/usr/bin:/bin\n"), 0o644))
	env := []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
	arg := `body=$(touch ` + filepath.Join(home, "pwned") + `); "x" 'y' ;`
	out, err := defaultGhRunner(5*time.Second)(context.Background(), env, "api", "-f", arg)
	require.NoError(t, err)
	require.Equal(t, "api\n-f\n"+arg+"\n", string(out))
	_, statErr := os.Stat(filepath.Join(home, "pwned"))
	require.True(t, os.IsNotExist(statErr), "the arguments are not interpreted")

	// without gh on the profile's PATH: clear error
	require.NoError(t, os.WriteFile(filepath.Join(home, ".bash_profile"), []byte("export PATH=/nonexistent\n"), 0o644))
	_, err = defaultGhRunner(5*time.Second)(context.Background(), env, "api")
	require.EqualError(t, err, "GitHub: gh command not found on the hub")
}
