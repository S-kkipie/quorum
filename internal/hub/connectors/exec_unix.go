//go:build !windows

package connectors

import (
	"os/exec"
	"syscall"
	"time"
)

// setupProcessGroup pone el conector en su propio grupo y mata el grupo entero al cancelar,
// para que los scripts hijos no queden colgados.
func setupProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
}
