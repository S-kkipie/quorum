//go:build !windows

package connectors

import (
	"os/exec"
	"syscall"
	"time"
)

// setupProcessGroup puts the connector in its own group and kills the whole group on cancel,
// so child scripts are not left hanging.
func setupProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
}
