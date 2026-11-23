package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Serve levanta la API local en 127.0.0.1 y bloquea hasta ctx.Done.
// Con cfg.Hub vacío los envelopes de Out() se descartan; si no, los lleva RunHubLink.
func Serve(ctx context.Context, cfg Config) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		if healthy(cfg) {
			return nil // ya hay un quorumd sano en el puerto guardado
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
	}
	if p := ln.Addr().(*net.TCPAddr).Port; p != cfg.Port {
		cfg.Port = p
		if err := SaveConfig(cfg); err != nil {
			ln.Close()
			return err
		}
	}
	reg := NewRegistry(cfg.Machine)
	lk := &linker{reg: reg, parent: ctx}
	lk.start(cfg)
	reload := func() error {
		c, err := LoadConfig()
		if err != nil {
			return err
		}
		lk.start(c)
		return nil
	}
	srv := &http.Server{Handler: NewLocalAPIWithReload(reg, cfg.LocalToken, proto.Version, reload)}
	go func() { <-ctx.Done(); srv.Close() }()
	if err := srv.Serve(ln); err != http.ErrServerClosed {
		return err
	}
	return nil
}

type EnsureResult struct {
	OK      bool   `json:"ok"`
	Port    int    `json:"port,omitempty"`
	Token   string `json:"token,omitempty"`
	Machine string `json:"machine,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

func healthy(cfg Config) bool { _, ok := health(cfg); return ok }

// health consulta /v1/health y devuelve la versión del daemon que responde (no la de
// este binario: puede ser un quorumd viejo que sigue vivo).
func health(cfg Config) (version string, ok bool) {
	if cfg.Port == 0 {
		return "", false
	}
	c := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/health", cfg.Port))
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var h struct {
		OK      bool   `json:"ok"`
		Machine string `json:"machine"`
		Version string `json:"version"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&h) != nil {
		return "", false
	}
	return h.Version, h.OK && h.Machine == cfg.Machine
}

// Ensure garantiza que haya un daemon sano, lanzándolo desacoplado si hace falta.
func Ensure() EnsureResult { return ensureWith(spawnDetached) }

// ensureWith hace check-spawn-wait bajo un lock exclusivo entre procesos, de
// modo que sesiones simultáneas lancen un único daemon.
func ensureWith(spawn func() error) EnsureResult {
	unlock, err := lockConfig()
	if err != nil {
		return EnsureResult{Error: err.Error()}
	}
	defer unlock()
	cfg, err := loadConfigLocked()
	if err != nil {
		return EnsureResult{Error: err.Error()}
	}
	ok := func(c Config, v string) EnsureResult {
		return EnsureResult{OK: true, Port: c.Port, Token: c.LocalToken, Machine: c.Machine, Version: v}
	}
	if v, h := health(cfg); h {
		return ok(cfg, v)
	}
	if err := spawn(); err != nil {
		return EnsureResult{Error: err.Error()}
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		if c, _, err := readConfig(); err == nil {
			if v, h := health(c); h {
				return ok(c, v)
			}
		}
	}
	return EnsureResult{Error: "daemon no respondió en 5s (ver quorumd.log)"}
}

func spawnDetached() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir, _ := ConfigDir()
	path := filepath.Join(dir, "quorumd.log")
	rotateLog(path, maxLogSize)
	logf, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	cmd := exec.Command(exe, "serve")
	cmd.Env = append(os.Environ(), LogEnv+"="+path)
	cmd.Stdout, cmd.Stderr = logf, logf
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait() // evita zombi si morimos antes; el hijo sigue vivo
	return nil
}

func PrintJSON(r EnsureResult) { json.NewEncoder(os.Stdout).Encode(r) }

// linker gestiona la tarea que consume reg.Out(): RunHubLink si hay hub, o un
// vaciado si no. start reemplaza la tarea anterior (para recargar la config).
type linker struct {
	reg    *Registry
	parent context.Context

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

func (l *linker) start(cfg Config) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cancel != nil {
		l.cancel()
		<-l.done // un único consumidor de Out() a la vez
	}
	ctx, cancel := context.WithCancel(l.parent)
	done := make(chan struct{})
	l.cancel, l.done = cancel, done
	go func() {
		defer close(done)
		if cfg.Hub != "" && cfg.MachineToken != "" {
			RunHubLink(ctx, cfg, l.reg, NewHost(cfg))
			return
		}
		for {
			select {
			case <-l.reg.Out():
			case <-ctx.Done():
				return
			}
		}
	}()
}

// ReloadRunning pide al daemon local sano que relea la config y se enlace.
func ReloadRunning(cfg Config) error {
	if !healthy(cfg) {
		return errors.New("no hay un quorumd corriendo")
	}
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/v1/reload", cfg.Port), nil)
	req.Header.Set("Authorization", "Bearer "+cfg.LocalToken)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("el daemon respondió %s", resp.Status)
	}
	return nil
}
