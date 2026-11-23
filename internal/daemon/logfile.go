package daemon

import (
	"os"
	"sync"
	"time"
)

// LogEnv carries to the daemon launched by ensure the path of its quorumd.log, so that
// it writes its log with rotation (see RotatingLog).
const LogEnv = "QUORUMD_LOG"

// maxLogSize: past 5 MiB quorumd.log is renamed to quorumd.log.1 (one old file is kept).
const maxLogSize = 5 << 20

// rotateLog renames path to path.1 (overwriting the previous one) if it exceeds max bytes.
func rotateLog(path string, max int64) {
	if st, err := os.Stat(path); err == nil && st.Size() > max {
		_ = os.Rename(path, path+".1")
	}
}

// renameRetry: after a failed rename (on Windows, e.g., another handle keeps
// the file open) it is not retried until this time has passed.
const renameRetry = time.Minute

// RotatingLog is a log io.Writer that rotates the file when it exceeds max bytes.
// With redirect (the daemon launched by ensure, whose stdout/stderr is this same
// file) it also repoints stdout and stderr to the new file after rotating, where the
// system allows it (Unix); on Windows they stay on the old one until the next start.
type RotatingLog struct {
	mu       sync.Mutex
	path     string
	max      int64
	f        *os.File
	size     int64
	redirect bool
	now      func() time.Time
	failedAt time.Time // last failed rename
	opens    int       // opens (for tests)
}

func NewRotatingLog(path string) *RotatingLog {
	l := newRotatingLog(path, maxLogSize)
	l.redirect = true
	return l
}

func newRotatingLog(path string, max int64) *RotatingLog {
	return &RotatingLog{path: path, max: max, now: time.Now}
}

func (l *RotatingLog) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, st.Size()
	l.opens++
	if l.redirect {
		redirectStdio(f)
	}
	return nil
}

func (l *RotatingLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	if l.size > 0 && l.size+int64(len(p)) > l.max && l.now().Sub(l.failedAt) >= renameRetry {
		l.f.Close() // Windows does not rename an open file
		l.f = nil
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			l.failedAt = l.now() // stays on the same file; do not reopen on every write
		}
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}
