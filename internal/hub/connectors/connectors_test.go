package connectors

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func script(t *testing.T) string {
	p, err := filepath.Abs("testdata/fake-connector.sh")
	require.NoError(t, err)
	return p
}

func cfg(t *testing.T, mode string, extra ...string) proto.ConnectorConfig {
	s := map[string]string{"command": script(t), "mode": mode}
	for i := 0; i+1 < len(extra); i += 2 {
		s[extra[i]] = extra[i+1]
	}
	return proto.ConnectorConfig{Kind: "exec", Settings: s}
}

func TestStatusMap(t *testing.T) {
	for in, want := range map[string]string{
		"open": "todo", "TODO": "todo", "backlog": "todo", "In Progress": "in_progress", "doing": "in_progress",
		"review": "in_review", "in review": "in_review", "closed": "done", "Done": "done", "resolved": "done",
		"blocked": "blocked", "weird": "todo", "": "todo", "done": "done", "in_progress": "in_progress",
	} {
		require.Equal(t, want, StatusMap(in, nil), in)
	}
	// Spanish values written before the English migration still normalize.
	for in, want := range map[string]string{"por_hacer": "todo", "en_curso": "in_progress", "en curso": "in_progress", "en_review": "in_review", "hecho": "done", "bloqueado": "blocked"} {
		require.Equal(t, want, StatusMap(in, nil), in)
		require.Equal(t, want, StatusMap("x", map[string]string{"x": want}), in)
		// a custom statusMap value written in Spanish is normalized too
		require.Equal(t, want, StatusMap("x", map[string]string{"x": in}), in)
	}
	require.Equal(t, "blocked", StatusMap("waiting", map[string]string{"waiting": "blocked"}))
	require.Equal(t, "done", StatusMap("open", map[string]string{"open": "done"}))
}

func TestNewNone(t *testing.T) {
	_, err := New(proto.ConnectorConfig{Kind: "none"}, "", nil)
	require.ErrorIs(t, err, ErrNoConnector)
}

func TestExecErrors(t *testing.T) {
	ctx := context.Background()
	run := func(mode string, d time.Duration) error {
		c, err := newExec(cfg(t, mode), "tok", os.Environ(), d)
		require.NoError(t, err)
		_, err = c.List(ctx, 0)
		return err
	}
	start := time.Now()
	err := run("sleep", 300*time.Millisecond)
	require.ErrorContains(t, err, "timed out")
	require.Less(t, time.Since(start), 5*time.Second)
	require.ErrorContains(t, run("garbage", time.Second*10), "invalid connector response")
	err = run("fail", time.Second*10)
	require.ErrorContains(t, err, "everything broke")
	require.ErrorContains(t, run("huge", time.Second*20), "response too large")
	require.EqualError(t, run("err", time.Second*10), "no permission")
}

func TestExecCommentAndStatus(t *testing.T) {
	log := filepath.Join(t.TempDir(), "log")
	c, err := newExec(cfg(t, "ok", "log", log), "secret", os.Environ(), 10*time.Second)
	require.NoError(t, err)
	require.NoError(t, c.Comment(context.Background(), "A-1", "hola"))
	require.NoError(t, c.SetStatus(context.Background(), "A-1", "done"))
	b, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	require.Len(t, lines, 2)
	require.Contains(t, lines[0], `"op":"comment"`)
	require.Contains(t, lines[0], `"body":"hola"`)
	require.Contains(t, lines[0], `"token":"secret"`)
	require.Contains(t, lines[1], `"status":"done"`)
}

func TestExecNoCommand(t *testing.T) {
	_, err := New(proto.ConnectorConfig{Kind: "exec", Settings: map[string]string{}}, "", nil)
	require.Error(t, err)
}

type fx struct {
	st   *store.Store
	sy   *Syncer
	proj proto.Project
	mu   sync.Mutex
	pubs []proto.Envelope
}

func newFx(t *testing.T, c proto.ConnectorConfig, profile string) *fx {
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	ws, err := st.CreateWorkspace(proto.Workspace{Name: "w", WhoasProfile: profile})
	require.NoError(t, err)
	p, err := st.CreateProject(proto.Project{WorkspaceID: ws.ID, Name: "p", Connector: c})
	require.NoError(t, err)
	f := &fx{st: st, proj: p}
	require.NoError(t, st.SetConnectorToken(p.ID, "tok-secret"))
	f.sy = NewSyncer(st, func(e proto.Envelope) { f.mu.Lock(); f.pubs = append(f.pubs, e); f.mu.Unlock() })
	return f
}

func (f *fx) types() (out []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.pubs {
		out = append(out, e.Type)
	}
	return
}

func TestSyncOKThenError(t *testing.T) {
	f := newFx(t, cfg(t, "ok"), "")
	require.NoError(t, f.sy.SyncNow(f.proj.ID))
	ts, _ := f.st.ListTickets(f.proj.ID)
	require.Len(t, ts, 2)
	by := map[string]proto.Ticket{}
	for _, x := range ts {
		by[x.ExternalID] = x
	}
	require.Equal(t, "todo", by["A-1"].Status)
	require.Equal(t, "in_progress", by["A-2"].Status)
	require.Equal(t, "In Progress", by["A-2"].RawStatus)
	p, _ := f.st.GetProject(f.proj.ID)
	require.Equal(t, "", p.SyncError)
	require.NotZero(t, p.SyncedAt)
	require.Equal(t, []string{"project_upsert", "tickets"}, f.types())
	require.NotContains(t, string(f.pubs[0].Payload), "tok-secret")

	// Switch the connector to a broken one: the tickets are kept and SyncError is set.
	broken := f.proj
	broken.Connector = cfg(t, "fail")
	require.NoError(t, f.st.UpdateProject(broken))
	require.Error(t, f.sy.SyncNow(f.proj.ID))
	p, _ = f.st.GetProject(f.proj.ID)
	require.Contains(t, p.SyncError, "everything broke")
	ts, _ = f.st.ListTickets(f.proj.ID)
	require.Len(t, ts, 2)
	require.Equal(t, []string{"project_upsert", "tickets", "project_upsert"}, f.types())
}

func TestSyncWhoasProfileAndNone(t *testing.T) {
	f := newFx(t, cfg(t, "env"), "profile-x")
	require.NoError(t, f.sy.SyncNow(f.proj.ID))
	ts, _ := f.st.ListTickets(f.proj.ID)
	require.Len(t, ts, 1)
	require.Equal(t, "profile-x", ts[0].Title)

	g := newFx(t, proto.ConnectorConfig{Kind: "none"}, "")
	require.ErrorIs(t, g.sy.SyncNow(g.proj.ID), ErrNoConnector)
}

func TestSyncDedupe(t *testing.T) {
	f := newFx(t, cfg(t, "ok"), "")
	f.sy.mu.Lock()
	f.sy.running[f.proj.ID] = true
	f.sy.mu.Unlock()
	require.NoError(t, f.sy.SyncNow(f.proj.ID))
	ts, _ := f.st.ListTickets(f.proj.ID)
	require.Empty(t, ts)
}

func TestStartPeriodic(t *testing.T) {
	f := newFx(t, cfg(t, "ok"), "")
	none, err := f.st.CreateProject(proto.Project{WorkspaceID: f.proj.WorkspaceID, Name: "n"})
	require.NoError(t, err)
	f.sy.tick = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.sy.Start(ctx)
	require.Eventually(t, func() bool { ts, _ := f.st.ListTickets(f.proj.ID); return len(ts) == 2 }, 5*time.Second, 20*time.Millisecond)
	p, _ := f.st.GetProject(none.ID)
	require.Zero(t, p.SyncedAt)
}

func TestTokenRedacted(t *testing.T) {
	f := newFx(t, cfg(t, "leak"), "")
	err := f.sy.SyncNow(f.proj.ID)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "tok-secret")
	p, _ := f.st.GetProject(f.proj.ID)
	require.NotContains(t, p.SyncError, "tok-secret")
	require.Contains(t, p.SyncError, "***")
	for _, e := range f.pubs {
		require.NotContains(t, string(e.Payload), "tok-secret")
	}
}

func TestSyncedAtIsStartOfFetch(t *testing.T) {
	f := newFx(t, cfg(t, "ok"), "")
	calls := 0
	f.sy.now = func() time.Time { calls++; return time.UnixMilli(int64(calls) * 1000) }
	require.NoError(t, f.sy.SyncNow(f.proj.ID))
	p, _ := f.st.GetProject(f.proj.ID)
	require.EqualValues(t, 1000, p.SyncedAt)
}

func TestStatusMapCustomNormalizedKeys(t *testing.T) {
	require.Equal(t, "done", StatusMap("Won't_Fix", map[string]string{"won't-fix": "done"}))
}

func TestTokenRedactedEscaped(t *testing.T) {
	tok := `a"b\c`
	f := newFx(t, cfg(t, "leak"), "")
	require.NoError(t, f.st.SetConnectorToken(f.proj.ID, tok))
	err := f.sy.SyncNow(f.proj.ID)
	require.Error(t, err)
	require.NotContains(t, err.Error(), tok)
	require.NotContains(t, err.Error(), `a\"b\\c`)
}

func TestStatusMapOpenLabelOnly(t *testing.T) {
	require.Equal(t, "in_progress", StatusMap("open:en curso", nil))
	require.Equal(t, "in_review", StatusMap("open:review", nil))
	require.Equal(t, "todo", StatusMap("jira:in progress", nil))
}

func TestInvalidateDiscardsInFlightSync(t *testing.T) {
	f := newFx(t, cfg(t, "ok"), "")
	gate := make(chan struct{})
	entered := make(chan struct{})
	f.sy.newConn = func(c proto.ConnectorConfig, tok string, env []string) (Connector, error) {
		return blockConn{entered, gate}, nil
	}
	done := make(chan error, 1)
	go func() { done <- f.sy.SyncNow(f.proj.ID) }()
	<-entered
	require.NoError(t, f.sy.Invalidate(f.proj.ID, func() error { return nil }))
	close(gate)
	require.NoError(t, <-done)
	ts, _ := f.st.ListTickets(f.proj.ID)
	require.Empty(t, ts, "what was fetched from the old source is discarded")
	p, _ := f.st.GetProject(f.proj.ID)
	require.Zero(t, p.SyncedAt)
}

func TestSyncNowDuringSyncReruns(t *testing.T) {
	f := newFx(t, cfg(t, "ok"), "")
	gate := make(chan struct{})
	entered := make(chan struct{}, 4)
	var mu sync.Mutex
	n := 0
	f.sy.newConn = func(c proto.ConnectorConfig, tok string, env []string) (Connector, error) {
		mu.Lock()
		n++
		first := n == 1
		mu.Unlock()
		if first {
			return blockConn{entered, gate}, nil
		}
		return blockConn{entered, nil}, nil
	}
	done := make(chan error, 1)
	go func() { done <- f.sy.SyncNow(f.proj.ID) }()
	<-entered
	require.NoError(t, f.sy.SyncNow(f.proj.ID)) // in progress: stays pending
	close(gate)
	require.NoError(t, <-done)
	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, 2, n)
}

type blockConn struct {
	entered chan struct{}
	gate    chan struct{}
}

func (b blockConn) List(ctx context.Context, since int64) ([]proto.Ticket, error) {
	b.entered <- struct{}{}
	if b.gate != nil {
		<-b.gate
	}
	return []proto.Ticket{{ExternalID: "V-1", Title: "old", Status: "open"}}, nil
}
func (blockConn) Comment(context.Context, string, string) error   { return nil }
func (blockConn) SetStatus(context.Context, string, string) error { return nil }
