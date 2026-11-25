package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// z joins porcelain -z records: fields end in NUL, an empty field ends a record.
func z(records ...[]string) string {
	var b strings.Builder
	for _, r := range records {
		for _, f := range r {
			b.WriteString(f + "\x00")
		}
		b.WriteString("\x00")
	}
	return b.String()
}

var porcelain = z(
	[]string{"worktree /home/u/work/acme/app", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main"},
	[]string{"worktree /home/u/work/acme/app-rewrite/", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/rewrite"},
)

func TestParseWorktrees(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix paths")
	}
	out := z(
		[]string{"worktree /home/u/work/acme/app", "HEAD 1", "branch refs/heads/main"},
		[]string{"worktree /home/u/work/acme/app-rewrite/", "HEAD 2"},
		[]string{"worktree /home/u/work/acme/app.git", "bare"},
		[]string{"worktree /home/u/work/acme/gone", "HEAD 3", "prunable gitdir file points to non-existent location"},
		[]string{"worktree /home/u/work/acme/gone2", "prunable"},
		[]string{"worktree relative/path", "detached"},
		[]string{"worktree /home/u/work/acme/app"},
	)
	require.Equal(t, []string{"/home/u/work/acme/app", "/home/u/work/acme/app-rewrite"}, parseWorktrees([]byte(out)))
	require.Empty(t, parseWorktrees(nil))
	require.Empty(t, parseWorktrees([]byte("fatal: not a git repository\n")))
}

// A newline in a worktree's folder name cannot forge another entry: -z keeps it in one field.
func TestParseWorktreesNewlineInPath(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix paths")
	}
	out := z([]string{"worktree /home/u/work/acme/x\nworktree /home", "HEAD 1"})
	got := parseWorktrees([]byte(out))
	require.NotContains(t, got, "/home")
	require.Equal(t, []string{"/home/u/work/acme/x\nworktree /home"}, got)
}

func TestParseWorktreesCap(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix paths")
	}
	var b strings.Builder
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&b, "worktree /home/u/wt%d\x00HEAD x\x00\x00", i)
	}
	got := parseWorktrees([]byte(b.String()))
	require.Len(t, got, worktreesMax)
	require.Equal(t, "/home/u/wt0", got[0])
	require.Equal(t, "/home/u/wt19", got[19])
}

// fakeFS makes every worktree look present, with no symlinks.
func fakeFS(f *worktreeFinder) {
	f.lstat = func(string) (os.FileInfo, error) { return nil, nil }
	f.resolve = func(p string) (string, error) { return filepath.Clean(p), nil }
}

// fakeFinder: a finder whose git answers out (or err) and counts its runs.
func fakeFinder(out string, err error) (*worktreeFinder, *atomic.Int32, *time.Time) {
	f := newWorktreeFinder()
	var runs atomic.Int32
	now := time.Unix(1000, 0)
	f.now = func() time.Time { return now }
	fakeFS(f)
	f.run = func(context.Context, string) ([]byte, error) {
		runs.Add(1)
		return []byte(out), err
	}
	return f, &runs, &now
}

func TestWorktreeFinderCache(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix paths")
	}
	f, runs, now := fakeFinder(porcelain, nil)
	list, fresh := f.lookup("/home/u/work/acme/app")
	require.Nil(t, list)
	require.False(t, fresh)
	require.Len(t, f.find("/home/u/work/acme/app"), 2)
	list, fresh = f.lookup("/home/u/work/acme/app")
	require.Len(t, list, 2)
	require.True(t, fresh)
	*now = now.Add(worktreesTTL)
	list, fresh = f.lookup("/home/u/work/acme/app")
	require.Len(t, list, 2) // stale entries are still used until the refresh lands
	require.False(t, fresh)
	require.EqualValues(t, 1, runs.Load())
}

func TestWorktreeFinderFailureIsEmpty(t *testing.T) {
	f, _, _ := fakeFinder("", errors.New("exit status 128"))
	require.Empty(t, f.find("/home/u/not-a-repo"))
	list, fresh := f.lookup("/home/u/not-a-repo")
	require.Empty(t, list)
	require.True(t, fresh) // cached: not retried until the TTL passes
	// a failure after a good answer keeps that answer
	if filepath.Separator == '/' {
		g, _, now := fakeFinder(porcelain, nil)
		require.Len(t, g.find("/home/u/work/acme/app"), 2)
		g.run = func(context.Context, string) ([]byte, error) { return nil, errors.New("signal: killed") }
		*now = now.Add(worktreesTTL)
		require.Len(t, g.find("/home/u/work/acme/app"), 2)
		list, fresh = g.lookup("/home/u/work/acme/app")
		require.Len(t, list, 2)
		require.True(t, fresh)
	}
	f2, runs, _ := fakeFinder(porcelain, nil)
	require.Empty(t, f2.find("relative"))
	require.EqualValues(t, 0, runs.Load())
}

func TestWorktreeFinderTimeout(t *testing.T) {
	f := newWorktreeFinder()
	f.timeout = 50 * time.Millisecond
	f.run = func(ctx context.Context, _ string) ([]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	start := time.Now()
	require.Empty(t, f.find("/home/u/slow"))
	require.Less(t, time.Since(start), 2*time.Second)
}

func TestWorktreeFinderRefreshSingleFlight(t *testing.T) {
	f := newWorktreeFinder()
	fakeFS(f)
	release := make(chan struct{})
	var runs atomic.Int32
	f.run = func(context.Context, string) ([]byte, error) {
		runs.Add(1)
		<-release
		return []byte(porcelain), nil
	}
	var wg sync.WaitGroup
	wg.Add(1)
	done := func(string, []string) { wg.Done() }
	f.refresh("/home/u/work/acme/app", done)
	f.refresh("/home/u/work/acme/app", done) // already running: ignored
	close(release)
	wg.Wait()
	require.EqualValues(t, 1, runs.Load())
}

// The session upsert never waits for git: it goes out at once, and a second upsert carries the list.
func TestUpsertFillsWorktreesOffThePath(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix paths")
	}
	r := NewRegistry("m1")
	fakeFS(r.wt)
	release := make(chan struct{})
	r.wt.run = func(context.Context, string) ([]byte, error) {
		<-release
		return []byte(porcelain), nil
	}
	r.Upsert(proto.SessionInfo{ID: "s1", Root: "/home/u/work/acme/app", Worktrees: []string{"/etc"}})
	e := <-r.out
	var si proto.SessionInfo
	require.NoError(t, json.Unmarshal(e.Payload, &si))
	require.Empty(t, si.Worktrees) // what the mod sent is dropped; nothing known yet
	close(release)
	// the refresh lands and the session is re-sent with its worktrees
	select {
	case e = <-r.out:
	case <-time.After(5 * time.Second):
		t.Fatal("no re-sent upsert")
	}
	require.Equal(t, "session_upsert", e.Type)
	require.NoError(t, json.Unmarshal(e.Payload, &si))
	require.Equal(t, []string{"/home/u/work/acme/app", "/home/u/work/acme/app-rewrite"}, si.Worktrees)
	r.Upsert(proto.SessionInfo{ID: "s1", Root: "/home/u/work/acme/app"})
	require.NoError(t, json.Unmarshal((<-r.out).Payload, &si))
	require.Len(t, si.Worktrees, 2)
	require.Len(t, r.Snapshot()[0].Worktrees, 2)
}

// A worktree without its .git entry is dropped; a list that does not include the session folder
// (git walked up to a parent repository) is no list at all.
func TestWorktreeFinderChecks(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix paths")
	}
	f, _, _ := fakeFinder(porcelain, nil)
	f.lstat = func(p string) (os.FileInfo, error) {
		if p == "/home/u/work/acme/app-rewrite/.git" {
			return nil, os.ErrNotExist
		}
		return nil, nil
	}
	require.Equal(t, []string{"/home/u/work/acme/app"}, f.find("/home/u/work/acme/app"))
	g, _, _ := fakeFinder(porcelain, nil)
	require.Empty(t, g.find("/home/u/work/acme/app/sub"))
}

func TestGitEnvDropsGitVariables(t *testing.T) {
	t.Setenv("GIT_DIR", "/home/u/elsewhere/.git")
	t.Setenv("GIT_WORK_TREE", "/home/u/elsewhere")
	env := gitEnv()
	for _, kv := range env {
		require.False(t, strings.HasPrefix(kv, "GIT_DIR=") || strings.HasPrefix(kv, "GIT_WORK_TREE="), kv)
	}
	require.Contains(t, env, "GIT_OPTIONAL_LOCKS=0")
	require.Contains(t, env, "GIT_TERMINAL_PROMPT=0")
}

// gitRepo makes a real repository at <tmp>/app with one commit and a worktree at <tmp>/app-rewrite.
func gitRepo(t *testing.T) (app, wt string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	app, wt = filepath.Join(root, "app"), filepath.Join(root, "app-rewrite")
	require.NoError(t, os.MkdirAll(filepath.Join(app, "sub"), 0o700))
	git := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Env = gitEnv()
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	git(app, "init", "-q")
	git(app, "commit", "-q", "--allow-empty", "-m", "init")
	git(app, "worktree", "add", "-q", wt)
	return app, wt
}

func TestWorktreeFinderRealRepo(t *testing.T) {
	app, wt := gitRepo(t)
	// even a GIT_DIR pointing elsewhere does not change the answer
	t.Setenv("GIT_DIR", filepath.Join(t.TempDir(), "nope.git"))
	f := newWorktreeFinder()
	list := f.find(app)
	if list == nil {
		if out, err := gitWorktreeList(context.Background(), app); err != nil {
			t.Skipf("git without worktree list -z: %v %s", err, out)
		}
	}
	require.Equal(t, []string{app, wt}, list)
	require.Equal(t, []string{app, wt}, newWorktreeFinder().find(wt))     // a session at the worktree root
	require.Empty(t, newWorktreeFinder().find(filepath.Join(app, "sub"))) // a subfolder of the repo
	require.Empty(t, newWorktreeFinder().find(t.TempDir()))               // not a repository
	// the real file_stat finds a file of the worktree under the same relative path
	require.NoError(t, os.WriteFile(filepath.Join(wt, "x.md"), []byte("x"), 0o600))
	i, err := callFileStat(t, []string{filepath.Join(app, "x.md"), filepath.Join(wt, "x.md")}, []string{app, wt})
	require.NoError(t, err)
	require.Equal(t, 1, i)
}

func callFileStat(t *testing.T, paths, bases []string) (int, error) {
	t.Helper()
	p, _ := json.Marshal(map[string]any{"paths": paths, "bases": bases})
	res, err := rpcHandlers["file_stat"](context.Background(), nil, p)
	if err != nil {
		return 0, err
	}
	return res.(map[string]int)["index"], nil
}

func TestFileStatPicksFirstExisting(t *testing.T) {
	root := t.TempDir()
	app, wt := filepath.Join(root, "app"), filepath.Join(root, "app-rewrite")
	require.NoError(t, os.MkdirAll(filepath.Join(wt, "docs"), 0o700))
	require.NoError(t, os.MkdirAll(app, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(wt, "docs", "x.md"), []byte("x"), 0o600))
	rel := filepath.Join("docs", "x.md")
	i, err := callFileStat(t, []string{filepath.Join(app, rel), filepath.Join(wt, rel)}, []string{app, wt})
	require.NoError(t, err)
	require.Equal(t, 1, i)
	// missing everywhere
	i, err = callFileStat(t, []string{filepath.Join(app, "nope.md"), filepath.Join(wt, "nope.md")}, []string{app, wt})
	require.NoError(t, err)
	require.Equal(t, -1, i)
	// a folder is not a file
	i, err = callFileStat(t, []string{filepath.Join(wt, "docs")}, []string{wt})
	require.NoError(t, err)
	require.Equal(t, -1, i)
}

func TestFileStatSafety(t *testing.T) {
	root := t.TempDir()
	base, out := filepath.Join(root, "base"), filepath.Join(root, "out")
	require.NoError(t, os.MkdirAll(base, 0o700))
	require.NoError(t, os.MkdirAll(out, 0o700))
	secret := filepath.Join(out, "secret.txt")
	require.NoError(t, os.WriteFile(secret, []byte("s"), 0o600))
	// outside the base, lexically or through ".."
	for _, p := range []string{secret, filepath.Join(base, "..", "out", "secret.txt"), "relative.txt"} {
		i, err := callFileStat(t, []string{p}, []string{base})
		require.NoError(t, err)
		require.Equal(t, -1, i, p)
	}
	// a symlink inside the base that points outside
	if err := os.Symlink(secret, filepath.Join(base, "link.txt")); err == nil {
		i, err := callFileStat(t, []string{filepath.Join(base, "link.txt")}, []string{base})
		require.NoError(t, err)
		require.Equal(t, -1, i)
	}
	// mismatched or too many candidates
	_, err := callFileStat(t, []string{secret}, nil)
	require.Error(t, err)
	many := make([]string, fileStatMax+1)
	_, err = callFileStat(t, many, many)
	require.Error(t, err)
}
