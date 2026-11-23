//go:build windows

package connectors

import (
	"os/exec"
	"time"
)

func setupProcessGroup(cmd *exec.Cmd) { cmd.WaitDelay = 2 * time.Second }
