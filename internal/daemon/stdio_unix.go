//go:build !windows

package daemon

import (
	"os"

	"golang.org/x/sys/unix"
)

// redirectStdio reapunta stdout y stderr (descriptores 1 y 2) a f: los panics y
// cualquier salida directa siguen al log rotado.
func redirectStdio(f *os.File) {
	fd := int(f.Fd())
	_ = unix.Dup2(fd, 1)
	_ = unix.Dup2(fd, 2)
}
