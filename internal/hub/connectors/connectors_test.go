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
		"open": "por_hacer", "TODO": "por_hacer", "backlog": "por_hacer", "In Progress": "en_curso", "doing": "en_curso",
		"review": "en_review", "in review": "en_review", "closed": "hecho", "Done": "hecho", "resolved": "hecho",
		"blocked": "bloqueado", "raro": "por_hacer", "": "por_hacer", "hecho": "hecho", "in_progress": "en_curso",
	} {
		require.Equal(t, want, StatusMap(in, nil), in)
	}
	require.Equal(t, "bloqueado", StatusMap("waiting", map[string]string{"waiting": "bloqueado"}))
	require.Equal(t, "hecho", StatusMap("open", map[string]string{"open": "hecho"}))
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
	require.ErrorContains(t, err, "tiempo de espera")
	require.Less(t, time.Since(start), 5*time.Second)
	require.ErrorContains(t, run("garbage", time.Second*10), "respuesta inválida del conector")
	err = run("fail", time.Second*10)
	require.ErrorContains(t, err, "se rompió todo")
	require.ErrorContains(t, run("huge", time.Second*20), "respuesta demasiado grande")
	require.EqualError(t, run("err", time.Second*10), "sin permiso")
}

func TestExecCommentAndStatus(t *testing.T) {
	log := filepath.Join(t.TempDir(), "log")
	c, err := newExec(cfg(t, "ok", "log", log), "secreto", os.Environ(), 10*time.Second)
	require.NoError(t, err)
	require.NoError(t, c.Comment(context.Background(), "A-1", "hola"))
	require.NoError(t, c.SetStatus(context.Background(), "A-1", "hecho"))
	b, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	require.Len(t, lines, 2)
	require.Contains(t, lines[0], `"op":"comment"`)
	require.Contains(t, lines[0], `"body":"hola"`)
	require.Contains(t, lines[0], `"token":"secreto"`)
	require.Contains(t, lines[1], `"status":"hecho"`)
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
	require.NoError(t, st.SetConnectorToken(p.ID, "tok-secreto"))
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
	require.Equal(t, "por_hacer", by["A-1"].Status)
	require.Equal(t, "en_curso", by["A-2"].Status)
	require.Equal(t, "In Progress", by["A-2"].RawStatus)
	p, _ := f.st.GetProject(f.proj.ID)
	require.Equal(t, "", p.SyncError)
	require.NotZero(t, p.SyncedAt)
	require.Equal(t, []string{"project_upsert", "tickets"}, f.types())
	require.NotContains(t, string(f.pubs[0].Payload), "tok-secreto")

	// Cambia el conector a uno roto: los tickets se conservan y SyncError se fija.
	broken := f.proj
	broken.Connector = cfg(t, "fail")
	require.NoError(t, f.st.UpdateProject(broken))
	require.Error(t, f.sy.SyncNow(f.proj.ID))
	p, _ = f.st.GetProject(f.proj.ID)
	require.Contains(t, p.SyncError, "se rompió todo")
	ts, _ = f.st.ListTickets(f.proj.ID)
	require.Len(t, ts, 2)
	require.Equal(t, []string{"project_upsert", "tickets", "project_upsert"}, f.types())
}

func TestSyncWhoasProfileAndNone(t *testing.T) {
	f := newFx(t, cfg(t, "env"), "perfil-x")
	require.NoError(t, f.sy.SyncNow(f.proj.ID))
	ts, _ := f.st.ListTickets(f.proj.ID)
	require.Len(t, ts, 1)
	require.Equal(t, "perfil-x", ts[0].Title)

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
	require.NotContains(t, err.Error(), "tok-secreto")
	p, _ := f.st.GetProject(f.proj.ID)
	require.NotContains(t, p.SyncError, "tok-secreto")
	require.Contains(t, p.SyncError, "***")
	for _, e := range f.pubs {
		require.NotContains(t, string(e.Payload), "tok-secreto")
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
	require.Equal(t, "hecho", StatusMap("Won't_Fix", map[string]string{"won't-fix": "hecho"}))
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
	require.Equal(t, "en_curso", StatusMap("open:en curso", nil))
	require.Equal(t, "en_review", StatusMap("open:review", nil))
	require.Equal(t, "por_hacer", StatusMap("jira:in progress", nil))
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
	require.Empty(t, ts, "lo traído del origen viejo se descarta")
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
	require.NoError(t, f.sy.SyncNow(f.proj.ID)) // en curso: queda pendiente
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
	return []proto.Ticket{{ExternalID: "V-1", Title: "viejo", Status: "open"}}, nil
}
func (blockConn) Comment(context.Context, string, string) error   { return nil }
func (blockConn) SetStatus(context.Context, string, string) error { return nil }
