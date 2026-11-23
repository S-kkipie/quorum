//go:build !windows

package daemon

import (
	"os"

	"golang.org/x/sys/unix"
)

// redirectStdio repoints stdout and stderr (descriptors 1 and 2) to f: panics and
// any direct output follow the rotated log.
func redirectStdio(f *os.File) {
	fd := int(f.Fd())
	_ = unix.Dup2(fd, 1)
	_ = unix.Dup2(fd, 2)
}
