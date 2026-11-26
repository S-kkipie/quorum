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
	"sync/atomic"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Serve brings up the local API on 127.0.0.1 and blocks until ctx.Done.
// With cfg.Hub empty the envelopes from Out() are dropped; otherwise RunHubLink carries them.
func Serve(ctx context.Context, cfg Config) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		if healthy(cfg) {
			return nil // a healthy quorumd already exists on the saved port
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
	if dir, err := ConfigDir(); err == nil {
		reg.SetTranscriptIndex(loadTranscriptIndex(filepath.Join(dir, "transcripts.json"), maxIndexedTranscripts))
	}
	go runUploadSweep(ctx)
	defer meetingJobs.shutdown() // a meeting worker never outlives the daemon
	defer liveWorkers.shutdown()
	SweepMeetingTmp()            // job folders of workers killed with an earlier daemon
	lk := &linker{reg: reg, parent: ctx}
	lk.start(cfg)
	var curCfg atomic.Pointer[Config]
	curCfg.Store(&cfg)
	reload := func() error {
		c, err := LoadConfig()
		if err != nil {
			return err
		}
		lk.start(c)
		curCfg.Store(&c)
		return nil
	}
	srv := &http.Server{Handler: NewLocalAPIFull(reg, cfg.LocalToken, proto.Version, reload, func() Config { return *curCfg.Load() })}
	go func() { <-ctx.Done(); srv.Close() }()
	defer reg.FlushTranscriptIndex()
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

// health queries /v1/health and returns the version of the daemon that answers (not that of
// this binary: it may be an old quorumd that is still alive).
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

// Ensure guarantees a healthy daemon exists, launching it detached if needed.
func Ensure() EnsureResult { return ensureWith(spawnDetached) }

// ensureWith does check-spawn-wait under an exclusive lock across processes,
// so that simultaneous sessions launch a single daemon.
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
	return EnsureResult{Error: "daemon did not answer in 5s (see quorumd.log)"}
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
	go cmd.Wait() // avoids a zombie if we die first; the child stays alive
	return nil
}

func PrintJSON(r EnsureResult) { json.NewEncoder(os.Stdout).Encode(r) }

// linker manages the task that consumes reg.Out(): RunHubLink if there is a hub, or a
// drain if not. start replaces the previous task (to reload the config).
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
		<-l.done // a single consumer of Out() at a time
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

// ReloadRunning asks the healthy local daemon to reread the config and link.
func ReloadRunning(cfg Config) error {
	if !healthy(cfg) {
		return errors.New("no quorumd is running")
	}
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/v1/reload", cfg.Port), nil)
	req.Header.Set("Authorization", "Bearer "+cfg.LocalToken)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("the daemon answered %s", resp.Status)
	}
	return nil
}
