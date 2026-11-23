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

// El timeout mata el grupo de procesos: el nieto no queda vivo.
func TestExecTimeoutKillsGrandchild(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	c0, _ := newExec(cfg(t, "orphan", "pidfile", pidfile), "", os.Environ(), 500*time.Millisecond)
	_, err0 := c0.List(context.Background(), 0)
	require.ErrorContains(t, err0, "tiempo de espera")
	pb, rerr := os.ReadFile(pidfile)
	require.NoError(t, rerr)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(pb)))
	require.Eventually(t, func() bool { return syscall.Kill(pid, 0) != nil }, 3*time.Second, 50*time.Millisecond, "el hijo sigue vivo")
}

// gh va por el shell de login: el PATH del perfil aplica y los argumentos llegan intactos.
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
	require.True(t, os.IsNotExist(statErr), "los argumentos no se interpretan")

	// sin gh en el PATH del perfil: error claro
	require.NoError(t, os.WriteFile(filepath.Join(home, ".bash_profile"), []byte("export PATH=/nonexistent\n"), 0o644))
	_, err = defaultGhRunner(5*time.Second)(context.Background(), env, "api")
	require.EqualError(t, err, "GitHub: no encontré el comando gh en el hub")
}
