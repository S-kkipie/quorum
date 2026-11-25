// Package client is the device side of Quorum: pairing, the hub connection and the watch service.
package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Config is what `quorum pair` stores in client.json.
type Config struct {
	Hub    string `json:"hub"`
	Token  string `json:"token"`
	Device string `json:"device"`
	// Machine is the quorumd machine name of this host, used to tell local sessions from remote ones.
	Machine string `json:"machine,omitempty"`
}

// ErrNotPaired: there is no client.json. ErrBadConfig: it is unreadable as a config. Neither goes
// away by retrying.
var (
	ErrNotPaired = errors.New("not paired: run `quorum pair <hubURL> <code>`")
	ErrBadConfig = errors.New("client.json is broken: run `quorum pair <hubURL> <code>` again")
)

// ConfigDir returns $QUORUM_CONFIG_DIR (the folder quorumd uses, when set), else
// $XDG_CONFIG_HOME/quorum, else ~/.config/quorum.
func ConfigDir() (string, error) {
	if d := os.Getenv("QUORUM_CONFIG_DIR"); d != "" {
		return d, nil
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "quorum"), nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".config", "quorum"), nil
}

// ConfigPath is the path of client.json.
func ConfigPath() (string, error) {
	d, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "client.json"), nil
}

// Load reads client.json; the error is ErrNotPaired when it does not exist and wraps ErrBadConfig
// when it is corrupt or incomplete.
func Load() (Config, error) {
	p, err := ConfigPath()
	if err != nil {
		return Config{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, ErrNotPaired
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("%w (%v)", ErrBadConfig, err)
	}
	if c.Hub == "" || c.Token == "" {
		return Config{}, fmt.Errorf("%w (no hub or token)", ErrBadConfig)
	}
	return c, nil
}

// Save writes client.json with mode 0600 (atomically).
func Save(c Config) error {
	p, err := ConfigPath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(p, b)
}

// writeFile writes b to path with mode 0600, creating the directory (0700) and renaming into place.
func writeFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// daemonConfigDir is quorumd's folder by quorumd's own rule: $QUORUM_CONFIG_DIR, else
// ~/.config/quorum (it does not read XDG_CONFIG_HOME).
func daemonConfigDir() (string, error) {
	if d := os.Getenv("QUORUM_CONFIG_DIR"); d != "" {
		return d, nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".config", "quorum"), nil
}

// DaemonMachine reads the machine name from quorumd's config (read-only); "" if it is not there.
func DaemonMachine() string {
	d, err := daemonConfigDir()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(d, "daemon.json"))
	if err != nil {
		return ""
	}
	var c struct {
		Machine string `json:"machine"`
	}
	if json.Unmarshal(b, &c) != nil {
		return ""
	}
	return c.Machine
}
