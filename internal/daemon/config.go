// Package daemon implements quorumd: local API, session registry and config.
package daemon

import (
	"context"
	"fmt"
	"time"

	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/gofrs/flock"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Machine      string `json:"machine"`
	Hub          string `json:"hub"`
	MachineToken string `json:"machineToken"`
	Port         int    `json:"port"`
	LocalToken   string `json:"localToken"`
	// HerdrSocket overrides the herdr socket path (default ~/.config/herdr/herdr.sock).
	HerdrSocket string `json:"herdrSocket,omitempty"`
	// Terminal turns the remote terminal off if false; nil means true.
	Terminal *bool `json:"terminal,omitempty"`
	// OllamaURL is where the meeting worker reaches Ollama when it is not on this machine's loopback
	// ("" = http://127.0.0.1:11434). The hub can only choose loopback addresses.
	OllamaURL string `json:"ollamaUrl,omitempty"`
}

// TerminalOn reports whether the remote terminal is allowed by the config.
func (c Config) TerminalOn() bool { return c.Terminal == nil || *c.Terminal }

// ConfigDir returns QUORUM_CONFIG_DIR or ~/.config/quorum.
func ConfigDir() (string, error) {
	if d := os.Getenv("QUORUM_CONFIG_DIR"); d != "" {
		return d, nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".config", "quorum"), nil
}

func IsWSL() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	b, err := os.ReadFile("/proc/version")
	return err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft")
}

func defaultMachine() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		h = "machine"
	}
	if IsWSL() {
		h += "-wsl"
	}
	return h
}

// LoadConfig reads the config; if missing, it creates it with default values and a token.
func LoadConfig() (Config, error) {
	c, complete, err := readConfig()
	if err != nil || complete {
		return c, err
	}
	unlock, err := lockConfig()
	if err != nil {
		return Config{}, err
	}
	defer unlock()
	return loadConfigLocked()
}

func readConfig() (Config, bool, error) {
	dir, err := ConfigDir()
	if err != nil {
		return Config{}, false, err
	}
	var c Config
	b, err := os.ReadFile(filepath.Join(dir, "daemon.json"))
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &c); err != nil {
			return Config{}, false, err
		}
	case !errors.Is(err, os.ErrNotExist):
		return Config{}, false, err
	}
	return c, c.Machine != "" && c.LocalToken != "", nil
}

// lockConfig takes the exclusive (daemon.lock) lock across processes.
func lockConfig() (func(), error) {
	dir, err := ConfigDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	fl := flock.New(filepath.Join(dir, "daemon.lock"))
	ctx, cancel := context.WithTimeout(context.Background(), configLockWait)
	defer cancel()
	ok, err := fl.TryLockContext(ctx, 50*time.Millisecond)
	if errors.Is(err, context.DeadlineExceeded) || (err == nil && !ok) {
		return nil, errors.New("could not take the config lock (another quorumd is starting)")
	}
	if err != nil {
		return nil, fmt.Errorf("config lock: %w", err)
	}
	return func() { fl.Unlock() }, nil
}

// configLockWait: how long to wait for the config lock; a variable for tests.
var configLockWait = 15 * time.Second

// loadConfigLocked loads and completes the config; the caller already holds the lock.
func loadConfigLocked() (Config, error) {
	c, _, err := readConfig()
	if err != nil {
		return Config{}, err
	}
	dirty := false
	if c.Machine == "" {
		c.Machine, dirty = defaultMachine(), true
	}
	if c.LocalToken == "" {
		t := make([]byte, 32)
		if _, err := rand.Read(t); err != nil {
			return Config{}, err
		}
		c.LocalToken, dirty = base64.RawURLEncoding.EncodeToString(t), true
	}
	if dirty {
		if err := SaveConfig(c); err != nil {
			return Config{}, err
		}
	}
	return c, nil
}

func SaveConfig(c Config) error {
	dir, err := ConfigDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "daemon-*.tmp") // 0600
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, "daemon.json"))
}
