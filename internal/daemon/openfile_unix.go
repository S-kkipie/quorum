//go:build !windows

package daemon

import (
	"os"
	"syscall"
)

// openNoFollow opens path read-only without blocking on FIFOs and without following a
// final symlink (the caller checks that the result is a regular file).
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
}
