//go:build !windows

package daemon

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the worker in its own process group, so a kill also reaches ffmpeg.
func setProcessGroup(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killProcessGroup kills the worker and everything it started.
func killProcessGroup(c *exec.Cmd) error {
	if c.Process == nil {
		return nil
	}
	if err := syscall.Kill(-c.Process.Pid, syscall.SIGKILL); err != nil {
		return c.Process.Kill()
	}
	return nil
}
