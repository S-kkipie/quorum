package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRotatingLogKeepsOneOld(t *testing.T) {
	p := filepath.Join(t.TempDir(), "quorumd.log")
	l := newRotatingLog(p, 100)
	line := strings.Repeat("a", 39) + "\n" // 40 bytes
	for i := 0; i < 7; i++ {
		_, err := l.Write([]byte(line))
		require.NoError(t, err)
	}
	cur, err := os.ReadFile(p)
	require.NoError(t, err)
	old, err := os.ReadFile(p + ".1")
	require.NoError(t, err)
	// 2 líneas por fichero: tras 7 escrituras quedan la 7ª y (en .1) la 5ª y 6ª
	require.Len(t, cur, 40)
	require.Len(t, old, 80)
	_, err = os.Stat(p + ".2")
	require.True(t, os.IsNotExist(err))
}

func TestRotateLogAtSpawn(t *testing.T) {
	p := filepath.Join(t.TempDir(), "quorumd.log")
	require.NoError(t, os.WriteFile(p, make([]byte, 200), 0o600))
	rotateLog(p, 100)
	_, err := os.Stat(p)
	require.True(t, os.IsNotExist(err))
	st, err := os.Stat(p + ".1")
	require.NoError(t, err)
	require.EqualValues(t, 200, st.Size())
	require.NoError(t, os.WriteFile(p, make([]byte, 50), 0o600))
	rotateLog(p, 100) // bajo el tope: no rota
	_, err = os.Stat(p)
	require.NoError(t, err)
}

// Revisión: si el renombre falla no se reabre el fichero en cada escritura; se
// reintenta pasado renameRetry.
func TestRotatingLogBacksOffAfterFailedRename(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "quorumd.log")
	require.NoError(t, os.MkdirAll(filepath.Join(p+".1", "x"), 0o700)) // .1 es un directorio no vacío: Rename falla
	clock := time.Unix(1000, 0)
	l := newRotatingLog(p, 100)
	l.now = func() time.Time { return clock }
	line := []byte(strings.Repeat("a", 39) + "\n")
	for i := 0; i < 20; i++ {
		_, err := l.Write(line)
		require.NoError(t, err)
	}
	require.Equal(t, 2, l.opens) // la inicial y la del único intento fallido
	require.NoError(t, os.RemoveAll(p+".1"))
	clock = clock.Add(renameRetry)
	_, err := l.Write(line)
	require.NoError(t, err)
	require.Equal(t, 3, l.opens)
	st, err := os.Stat(p + ".1")
	require.NoError(t, err)
	require.Greater(t, st.Size(), int64(100))
}
