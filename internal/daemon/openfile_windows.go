//go:build windows

package daemon

import "os"

// openNoFollow: Windows has no FIFOs to block on, so a plain open is enough.
func openNoFollow(path string) (*os.File, error) {
	return os.Open(path)
}
