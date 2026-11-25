//go:build windows

package daemon

import "os/exec"

// The meeting worker only runs on Linux (and WSL); on Windows the process is killed alone.
func setProcessGroup(*exec.Cmd) {}

func killProcessGroup(c *exec.Cmd) error {
	if c.Process == nil {
		return nil
	}
	return c.Process.Kill()
}
