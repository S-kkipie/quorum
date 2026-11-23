//go:build windows

package daemon

import "os"

// redirectStdio does nothing on Windows: stdout/stderr stay on the inherited file
// (which also prevents renaming it; RotatingLog retries every minute).
func redirectStdio(*os.File) {}
