// Package daemon implementa quorumd: API local, registro de sesiones y config.
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
	// HerdrSocket cambia la ruta del socket de herdr (por defecto ~/.config/herdr/herdr.sock).
	HerdrSocket string `json:"herdrSocket,omitempty"`
	// Terminal apaga la terminal remota si es false; nil equivale a true.
	Terminal *bool `json:"terminal,omitempty"`
}

// TerminalOn dice si la terminal remota está permitida por la config.
func (c Config) TerminalOn() bool { return c.Terminal == nil || *c.Terminal }

// ConfigDir devuelve QUORUM_CONFIG_DIR o ~/.config/quorum.
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

// LoadConfig lee la config; si falta, la crea con valores por defecto y token.
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

// lockConfig toma el lock exclusivo (daemon.lock) entre procesos.
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
		return nil, errors.New("no se pudo tomar el lock de configuración (otro quorumd arrancando)")
	}
	if err != nil {
		return nil, fmt.Errorf("lock de configuración: %w", err)
	}
	return func() { fl.Unlock() }, nil
}

// configLockWait: cuánto se espera el lock de configuración; variable para tests.
var configLockWait = 15 * time.Second

// loadConfigLocked carga y completa la config; el llamador ya tiene el lock.
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
