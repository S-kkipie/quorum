//go:build !windows

package launch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func tempLeft(t *testing.T, dir string) int {
	t.Helper()
	es, err := os.ReadDir(dir)
	require.NoError(t, err)
	return len(es)
}

func TestRunDetachedFinishedReturnsOutput(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	out, err := runDetached(context.Background(), "sh", "-c", "echo hello; exit 3")
	var ee *exec.ExitError
	require.True(t, errors.As(err, &ee))
	require.Equal(t, "hello\n", string(out))
	require.Zero(t, tempLeft(t, dir))
}

func TestRunDetachedGraceConsidersLaunched(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	old := graceWait
	graceWait = 50 * time.Millisecond
	t.Cleanup(func() { graceWait = old })
	t0 := time.Now()
	out, err := runDetached(context.Background(), "sleep", "0.4")
	require.NoError(t, err)
	require.Nil(t, out)
	require.Less(t, time.Since(t0), 300*time.Millisecond)
	require.Equal(t, 1, tempLeft(t, dir)) // the child is still alive with the temp file
	require.Eventually(t, func() bool { return tempLeft(t, dir) == 0 }, 3*time.Second, 20*time.Millisecond)
}

func TestRunDetachedContextKills(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	old := graceWait
	graceWait = 10 * time.Second
	t.Cleanup(func() { graceWait = old })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	t0 := time.Now()
	_, err := runDetached(ctx, "sleep", "5")
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Less(t, time.Since(t0), 2*time.Second)
	require.Eventually(t, func() bool { return tempLeft(t, dir) == 0 }, 3*time.Second, 20*time.Millisecond)
}
