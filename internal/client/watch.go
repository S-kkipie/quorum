package client

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/gofrs/flock"
)

const seenMax = 500

// Seen is the persisted set of the last notified attentions (session, kind, at).
type Seen struct {
	mu   sync.Mutex
	path string
	keys []string // oldest first
	set  map[string]bool
}

// LoadSeen reads the file; a missing or corrupt one starts empty.
func LoadSeen(path string) *Seen {
	s := &Seen{path: path, set: map[string]bool{}}
	if b, err := os.ReadFile(path); err == nil {
		var keys []string
		if json.Unmarshal(b, &keys) == nil {
			if len(keys) > seenMax {
				keys = keys[len(keys)-seenMax:]
			}
			s.keys = keys
			for _, k := range keys {
				s.set[k] = true
			}
		}
	}
	return s
}

// Add records key and reports whether it was new; the file is rewritten when it was.
func (s *Seen) Add(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.set[key] {
		return false
	}
	s.set[key] = true
	s.keys = append(s.keys, key)
	if len(s.keys) > seenMax {
		delete(s.set, s.keys[0])
		s.keys = append([]string(nil), s.keys[1:]...)
	}
	if b, err := json.Marshal(s.keys); err == nil {
		if err := writeFile(s.path, b); err != nil {
			logf("seen: %v", err)
		}
	}
	return true
}

// SeenPath is ~/.local/state/quorum/watch-seen.json (honouring XDG_STATE_HOME).
func SeenPath() (string, error) {
	d := os.Getenv("XDG_STATE_HOME")
	if d == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		d = filepath.Join(h, ".local", "state")
	}
	return filepath.Join(d, "quorum", "watch-seen.json"), nil
}

// LockPath is $XDG_RUNTIME_DIR/quorum-watch.lock, falling back to the config dir.
func LockPath() (string, error) {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		return filepath.Join(d, "quorum-watch.lock"), nil
	}
	d, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "quorum-watch.lock"), nil
}

// AcquireLock takes the single-instance lock; ok is false when another process holds it.
func AcquireLock(path string) (unlock func(), ok bool, err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, err
	}
	fl := flock.New(path)
	ok, err = fl.TryLock()
	if err != nil || !ok {
		return nil, false, err
	}
	return func() { _ = fl.Unlock() }, true, nil
}

// Watcher turns attention envelopes into notifications, once each.
type Watcher struct {
	Notifier *Notifier
	Seen     *Seen
}

// Handle processes one envelope; anything but an attention is ignored.
func (w *Watcher) Handle(ctx context.Context, env proto.Envelope) {
	if env.Type != "attention" {
		return
	}
	var a proto.Attention
	if json.Unmarshal(env.Payload, &a) != nil {
		return
	}
	if a.Session == "" {
		a.Session = env.Session
	}
	if !w.Seen.Add(fmt.Sprintf("%s|%s|%d", a.Session, a.Kind, a.At)) {
		return
	}
	title, body := Text(env, a)
	w.Notifier.Notify(ctx, title, body)
}

// Run consumes the live feed until ctx ends; it returns ErrUnauthorized when the hub rejects the
// token (the device was revoked).
func (w *Watcher) Run(ctx context.Context, cfg Config) error {
	live, err := Dial(ctx, cfg)
	if err != nil {
		return err
	}
	defer live.Close()
	for {
		select {
		case <-ctx.Done():
			return nil
		case env, ok := <-live.Envelopes():
			if !ok {
				return live.Err()
			}
			w.Handle(ctx, env)
		}
	}
}
