package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func attEnv(session, kind string, at int64) proto.Envelope {
	p, _ := json.Marshal(proto.Attention{Session: session, Kind: kind, At: at, Title: "api · vps-1", Body: "Needs you"})
	return proto.Envelope{Type: "attention", Machine: "vps-1", Session: session, Payload: p}
}

func TestWatcherDedupesReplayAndRestart(t *testing.T) {
	t.Setenv("HERDR_BIN_PATH", "")
	path := filepath.Join(t.TempDir(), "state", "watch-seen.json")
	f := &fakeRunner{}
	w := &Watcher{Notifier: &Notifier{Run: f.run}, Seen: LoadSeen(path)}
	ctx := context.Background()
	w.Handle(ctx, proto.Envelope{Type: "session_upsert"})
	w.Handle(ctx, attEnv("s1", "needs_you", 1))
	w.Handle(ctx, attEnv("s1", "needs_you", 1)) // snapshot replay
	w.Handle(ctx, attEnv("s1", "needs_you", 2)) // new
	w.Handle(ctx, attEnv("s1", "done", 2))      // new kind
	require.Len(t, f.calls, 3)

	// restart: new watcher over the same file
	f2 := &fakeRunner{}
	w2 := &Watcher{Notifier: &Notifier{Run: f2.run}, Seen: LoadSeen(path)}
	w2.Handle(ctx, attEnv("s1", "needs_you", 1))
	w2.Handle(ctx, attEnv("s1", "done", 2))
	w2.Handle(ctx, attEnv("s1", "done", 3))
	require.Len(t, f2.calls, 1)
}

func TestSeenKeepsLast500(t *testing.T) {
	path := filepath.Join(t.TempDir(), "seen.json")
	s := LoadSeen(path)
	for i := 0; i < 600; i++ {
		require.True(t, s.Add(fmt.Sprint("k", i)))
	}
	s2 := LoadSeen(path)
	require.Len(t, s2.keys, 500)
	require.False(t, s2.Add("k599"))
	require.True(t, s2.Add("k0"))
}

func TestSeenCorruptFileStartsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "seen.json")
	require.NoError(t, writeFile(path, []byte("{not json")))
	require.True(t, LoadSeen(path).Add("a"))
}

func TestSecondInstanceDoesNotLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quorum-watch.lock")
	unlock, ok, err := AcquireLock(path)
	require.NoError(t, err)
	require.True(t, ok)
	_, ok2, err := AcquireLock(path)
	require.NoError(t, err)
	require.False(t, ok2)
	unlock()
	unlock3, ok3, err := AcquireLock(path)
	require.NoError(t, err)
	require.True(t, ok3)
	unlock3()
}

func TestWatcherStopsOnRevokedToken(t *testing.T) {
	var hits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer ts.Close()
	var logs []string
	var mu sync.Mutex
	oldLog := logf
	t.Cleanup(func() { logf = oldLog })
	logf = func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }

	w := &Watcher{Notifier: &Notifier{Run: (&fakeRunner{}).run}, Seen: LoadSeen(filepath.Join(t.TempDir(), "seen.json"))}
	done := make(chan error, 1)
	go func() { done <- w.Run(context.Background(), Config{Hub: ts.URL, Token: "revoked"}) }()
	select {
	case err := <-done:
		require.ErrorIs(t, err, ErrUnauthorized)
	case <-time.After(5 * time.Second):
		t.Fatal("watch kept retrying a revoked token")
	}
	require.Equal(t, int32(1), hits.Load())
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, logs, 1)
	require.Contains(t, logs[0], "rejected this device's token")
	require.NotContains(t, logs[0], "revoked&") // the token is not logged
}
