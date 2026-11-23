package daemon

import (
	"os"
	"sync"
	"time"
)

// LogEnv lleva al daemon lanzado por ensure la ruta de su quorumd.log, para que
// escriba su log con rotación (ver RotatingLog).
const LogEnv = "QUORUMD_LOG"

// maxLogSize: al pasar de 5 MiB quorumd.log se renombra a quorumd.log.1 (se guarda uno viejo).
const maxLogSize = 5 << 20

// rotateLog renombra path a path.1 (pisando el anterior) si pasa de max bytes.
func rotateLog(path string, max int64) {
	if st, err := os.Stat(path); err == nil && st.Size() > max {
		_ = os.Rename(path, path+".1")
	}
}

// renameRetry: tras un renombre fallido (en Windows, p. ej., otro handle mantiene
// abierto el fichero) no se reintenta hasta pasado este tiempo.
const renameRetry = time.Minute

// RotatingLog es un io.Writer de log que rota el fichero al pasar de max bytes.
// Con redirect (el daemon lanzado por ensure, cuyo stdout/stderr es este mismo
// fichero) también reapunta stdout y stderr al fichero nuevo tras rotar, donde el
// sistema lo permite (Unix); en Windows siguen en el viejo hasta el próximo arranque.
type RotatingLog struct {
	mu       sync.Mutex
	path     string
	max      int64
	f        *os.File
	size     int64
	redirect bool
	now      func() time.Time
	failedAt time.Time // último renombre fallido
	opens    int       // aperturas (para tests)
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
		l.f.Close() // Windows no renombra un fichero abierto
		l.f = nil
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			l.failedAt = l.now() // sigue en el mismo fichero; no reabrir en cada escritura
		}
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}
