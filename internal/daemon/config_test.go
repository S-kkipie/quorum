package daemon

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/gofrs/flock"
	"github.com/stretchr/testify/require"
)

func TestConfigLockTimeoutMessage(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QUORUM_CONFIG_DIR", dir)
	old := configLockWait
	configLockWait = 150 * time.Millisecond
	t.Cleanup(func() { configLockWait = old })
	other := flock.New(filepath.Join(dir, "daemon.lock"))
	ok, err := other.TryLock()
	require.NoError(t, err)
	require.True(t, ok)
	defer other.Unlock()
	_, err = lockConfig()
	require.EqualError(t, err, "no se pudo tomar el lock de configuración (otro quorumd arrancando)")
}
