//go:build !windows

package daemon

import "golang.org/x/sys/unix"

// freeSpace returns the bytes available to this user on the disk holding path.
func freeSpace(path string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil //nolint:unconvert // the field types differ per OS
}
