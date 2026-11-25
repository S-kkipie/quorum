package client

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConfigRoundTripMode0600(t *testing.T) {
	t.Setenv("QUORUM_CONFIG_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	_, err := Load()
	require.ErrorIs(t, err, ErrNotPaired)

	want := Config{Hub: "https://hub.example", Token: "tok", Device: "quorum-laptop", Machine: "laptop"}
	require.NoError(t, Save(want))
	p, err := ConfigPath()
	require.NoError(t, err)
	st, err := os.Stat(p)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), st.Mode().Perm())
	got, err := Load()
	require.NoError(t, err)
	require.Equal(t, want, got)
}

func TestConfigDirFallsBackToHome(t *testing.T) {
	t.Setenv("QUORUM_CONFIG_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/home/x")
	d, err := ConfigDir()
	require.NoError(t, err)
	require.Equal(t, "/home/x/.config/quorum", d)
}

func TestDaemonMachineUsesQuorumdsDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("QUORUM_CONFIG_DIR", "")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // quorumd ignores it
	require.Equal(t, "", DaemonMachine())
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".config", "quorum"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(home, ".config", "quorum", "daemon.json"), []byte(`{"machine":"laptop","machineToken":"x"}`), 0o600))
	require.Equal(t, "laptop", DaemonMachine())

	dir := t.TempDir()
	t.Setenv("QUORUM_CONFIG_DIR", dir)
	require.Equal(t, "", DaemonMachine())
	require.NoError(t, os.WriteFile(filepath.Join(dir, "daemon.json"), []byte(`{"machine":"vps-1","machineToken":"x"}`), 0o600))
	require.Equal(t, "vps-1", DaemonMachine())
}

func TestConfigDirHonoursQuorumConfigDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QUORUM_CONFIG_DIR", dir)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	p, err := ConfigPath()
	require.NoError(t, err)
	require.Equal(t, filepath.Join(dir, "client.json"), p)
}

func TestLoadBrokenConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QUORUM_CONFIG_DIR", dir)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "client.json"), []byte("{not json"), 0o600))
	_, err := Load()
	require.ErrorIs(t, err, ErrBadConfig)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "client.json"), []byte(`{"hub":"https://hub.example"}`), 0o600))
	_, err = Load()
	require.ErrorIs(t, err, ErrBadConfig)
}
