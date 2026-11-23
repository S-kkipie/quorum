package summary

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

type fakeModel struct {
	mu      sync.Mutex
	calls   int
	out     string
	err     error
	prompts []string
}

func (f *fakeModel) Complete(_ context.Context, p string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.prompts = append(f.prompts, p)
	return f.out, f.err
}

func setup(t *testing.T, tk []proto.Ticket) (*store.Store, proto.Project, *fakeModel, *Summarizer, *time.Time) {
	st, err := store.Open(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	w, _ := st.CreateWorkspace(proto.Workspace{Name: "w"})
	p, err := st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "Proj"})
	require.NoError(t, err)
	require.NoError(t, st.ReplaceTickets(p.ID, tk))
	m := &fakeModel{out: "  \"Going well.\nQA missing.\"  "}
	var pubs []proto.Envelope
	s := New(st, m, func(e proto.Envelope) { pubs = append(pubs, e) })
	now := time.Now()
	s.now = func() time.Time { return now }
	return st, p, m, s, &now
}

func recent() []proto.Ticket {
	return []proto.Ticket{{ExternalID: "1", Title: "Login", Status: "in_progress", UpdatedAt: time.Now().UnixMilli()}}
}

func TestThrottle30Min(t *testing.T) {
	st, p, m, s, now := setup(t, recent())
	ctx := context.Background()
	s.Touch(p.ID)
	s.RunOnce(ctx)
	require.Equal(t, 1, m.calls)
	got, _ := st.GetProject(p.ID)
	require.Equal(t, "Going well. QA missing.", got.Summary)
	require.Contains(t, m.prompts[0], "Login")
	*now = now.Add(10 * time.Minute)
	s.Touch(p.ID)
	s.RunOnce(ctx)
	require.Equal(t, 1, m.calls)
	require.NoError(t, st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "b", Title: "Tb", Status: "todo", UpdatedAt: now.UnixMilli()}}))
	*now = now.Add(21 * time.Minute)
	s.RunOnce(ctx) // still pending
	require.Equal(t, 2, m.calls)
}

func TestInactivityNoModel(t *testing.T) {
	old := time.Now().Add(-10 * 24 * time.Hour)
	st, p, m, s, _ := setup(t, []proto.Ticket{{ExternalID: "1", Title: "x", Status: "todo", UpdatedAt: old.UnixMilli()}})
	s.Touch(p.ID)
	s.RunOnce(context.Background())
	require.Equal(t, 0, m.calls)
	got, _ := st.GetProject(p.ID)
	require.Equal(t, "No activity since "+old.Format("2006-01-02"), got.Summary)
}

func TestModelErrorKeepsSummary(t *testing.T) {
	st, p, m, s, now := setup(t, recent())
	ctx := context.Background()
	s.Touch(p.ID)
	s.RunOnce(ctx)
	*now = now.Add(31 * time.Minute)
	require.NoError(t, st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "c", Title: "Tc", Status: "todo", UpdatedAt: now.UnixMilli()}}))
	s.Touch(p.ID)
	m.err = errors.New("boom")
	s.RunOnce(ctx)
	got, _ := st.GetProject(p.ID)
	require.Equal(t, "Going well. QA missing.", got.Summary)
	require.Equal(t, 2, m.calls)
	s.RunOnce(ctx) // in retry: does not hammer
	require.Equal(t, 2, m.calls)
	*now = now.Add(6 * time.Minute)
	m.err, m.out = nil, "New"
	s.RunOnce(ctx)
	got, _ = st.GetProject(p.ID)
	require.Equal(t, "New", got.Summary)
}

func TestCleanCuts200(t *testing.T) {
	require.Len(t, []rune(Clean(strings.Repeat("é", 300))), 200)
}

func TestAutoSelection(t *testing.T) {
	var gotKey, gotVer string
	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotVer = r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")
		if r.URL.Path == "/v1/models" {
			w.Write([]byte(`{}`))
			return
		}
		posts++
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		require.Equal(t, "haiku", b["model"])
		w.Write([]byte(`{"content":[{"type":"text","text":"hola"}]}`))
	}))
	defer srv.Close()
	tok := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(tok, []byte("sekret\n"), 0o600))
	cli := &fakeModel{out: "cli"}
	a := NewAuto(srv.URL, tok)
	a.CLI = cli
	out, err := a.Complete(context.Background(), "p")
	require.NoError(t, err)
	require.Equal(t, "hola", out)
	require.Equal(t, "sekret", gotKey)
	require.Equal(t, "2023-06-01", gotVer)
	require.Equal(t, 0, cli.calls)

	// no token -> CLI
	b := NewAuto(srv.URL, filepath.Join(t.TempDir(), "nope"))
	b.CLI = cli
	out, _ = b.Complete(context.Background(), "p")
	require.Equal(t, "cli", out)

	// ccapi down -> CLI
	srv.Close()
	c := NewAuto(srv.URL, tok)
	c.CLI = cli
	require.Equal(t, "claude", c.Which(context.Background()))
}

func TestUnchangedInputsSkipModel(t *testing.T) {
	st, p, m, s, now := setup(t, recent())
	ctx := context.Background()
	s.Touch(p.ID)
	s.RunOnce(ctx)
	require.Equal(t, 1, m.calls)
	pubs := 0
	s.pub = func(proto.Envelope) { pubs++ }
	*now = now.Add(31 * time.Minute)
	s.Touch(p.ID)
	s.RunOnce(ctx)
	require.Equal(t, 0, pubs)    // only the deadline was renewed
	require.Equal(t, 1, m.calls) // same inputs: no call
	got, _ := st.GetProject(p.ID)
	require.Equal(t, now.UnixMilli(), got.SummaryAt)
	// a new ticket does regenerate
	require.NoError(t, st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "2", Title: "New", Status: "todo", UpdatedAt: now.UnixMilli()}}))
	*now = now.Add(31 * time.Minute)
	s.Touch(p.ID)
	s.RunOnce(ctx)
	require.Equal(t, 2, m.calls)
}

func TestInactivityTextNotRepublished(t *testing.T) {
	old := time.Now().Add(-10 * 24 * time.Hour)
	_, p, _, s, now := setup(t, []proto.Ticket{{ExternalID: "1", Title: "x", Status: "todo", UpdatedAt: old.UnixMilli()}})
	pubs := 0
	s.pub = func(proto.Envelope) { pubs++ }
	s.Touch(p.ID)
	s.RunOnce(context.Background())
	require.Equal(t, 1, pubs)
	*now = now.Add(31 * time.Minute)
	s.Touch(p.ID)
	s.RunOnce(context.Background())
	require.Equal(t, 1, pubs)
}

// An open session in the project overrides the inactivity rule even if the tickets are old.
func TestInactivitySkippedWithLiveSession(t *testing.T) {
	old := time.Now().Add(-10 * 24 * time.Hour)
	st, p, m, s, _ := setup(t, []proto.Ticket{{ExternalID: "1", Title: "x", Status: "todo", UpdatedAt: old.UnixMilli()}})
	_, err := st.UpsertCheckout(proto.Checkout{ProjectID: p.ID, Machine: "m", Root: "/r", RepoURL: "git@x:o/r.git"})
	require.NoError(t, err)
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m", Root: "/r", Cwd: "/r", Role: proto.RoleWork, State: proto.StateWorking, UpdatedAt: old.UnixMilli()}))
	s.Touch(p.ID)
	s.RunOnce(context.Background())
	require.Equal(t, 1, m.calls)
	got, _ := st.GetProject(p.ID)
	require.Equal(t, "Going well. QA missing.", got.Summary)
}

// Timestamps that are not real ms (1, 2…) count as unknown activity: no 1969/1970.
func TestBogusTimestampsAreUnknown(t *testing.T) {
	st, p, m, s, _ := setup(t, []proto.Ticket{{ExternalID: "1", Title: "x", Status: "todo", UpdatedAt: 1}, {ExternalID: "2", Title: "y", Status: "in_progress", UpdatedAt: 2}})
	act, err := st.ProjectActivity(p.ID)
	require.NoError(t, err)
	require.Zero(t, act)
	s.Touch(p.ID)
	s.RunOnce(context.Background())
	require.Equal(t, 1, m.calls)
	got, _ := st.GetProject(p.ID)
	require.NotContains(t, got.Summary, "No activity")
}

func TestCLICommandIsServiceAndNeutralDir(t *testing.T) {
	cmd, cleanup, err := cliCommand(context.Background(), "hola")
	require.NoError(t, err)
	dir := cmd.Dir
	require.NotEmpty(t, dir)
	wd, _ := os.Getwd()
	require.NotEqual(t, wd, dir)
	st, err := os.Stat(dir)
	require.NoError(t, err)
	require.True(t, st.IsDir())
	require.Contains(t, cmd.Env, "CCAPI_SERVER=1")
	require.Contains(t, cmd.Env, "QUORUM_DISABLE=1")
	// what comes from the hub's environment must not overwrite the markers: they go after
	last := map[string]string{}
	for _, kv := range cmd.Env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			last[k] = v
		}
	}
	require.Equal(t, "1", last["CCAPI_SERVER"])
	require.Equal(t, "1", last["QUORUM_DISABLE"])
	cleanup()
	_, err = os.Stat(dir)
	require.True(t, os.IsNotExist(err))
}

func (s *Summarizer) sizes() (int, int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.dirty), len(s.retry), len(s.hash)
}

func TestDeletedProjectIsPruned(t *testing.T) {
	st, p, m, s, now := setup(t, recent())
	ctx := context.Background()
	s.Touch(p.ID)
	s.RunOnce(ctx) // leaves a hash
	*now = now.Add(31 * time.Minute)
	require.NoError(t, st.ReplaceTickets(p.ID, []proto.Ticket{{ExternalID: "c", Title: "Tc", Status: "todo", UpdatedAt: now.UnixMilli()}}))
	s.Touch(p.ID)
	m.err = errors.New("boom")
	s.RunOnce(ctx) // leaves retry and dirty
	d, r, h := s.sizes()
	require.Equal(t, []int{1, 1, 1}, []int{d, r, h})

	// when processing, a project that no longer exists is forgotten entirely
	require.NoError(t, st.DeleteProject(p.ID))
	*now = now.Add(6 * time.Minute)
	s.RunOnce(ctx)
	d, r, h = s.sizes()
	require.Equal(t, []int{0, 0, 0}, []int{d, r, h})

	// Forget (called by the project deletion in the API) also
	s.Touch("x")
	s.mu.Lock()
	s.retry["x"], s.hash["x"] = *now, "h"
	s.mu.Unlock()
	s.Forget("x")
	d, r, h = s.sizes()
	require.Equal(t, []int{0, 0, 0}, []int{d, r, h})
}
