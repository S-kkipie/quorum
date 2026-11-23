package launch

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestArgv(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu")
	now = func() time.Time { return time.Unix(36*36, 0) }
	t.Cleanup(func() { now = time.Now })
	r := proto.LaunchRequest{ReqID: "abc", Dir: "/home/u/p", Continue: true}

	bin, a := Argv(Linux, r, false)
	require.Equal(t, "tmux", bin)
	require.Equal(t, []string{"new-session", "-d", "-s", "quorum-100-abc", "-c", "/home/u/p", "bash -lc 'QUORUM_LAUNCH_REQ=abc claude --continue'"}, a)

	bin, a = Argv(WSL, r, false)
	require.Equal(t, "wt.exe", bin)
	require.Equal(t, []string{"wsl.exe", "-d", "Ubuntu", "--cd", "/home/u/p", "--", "bash", "-lic", "QUORUM_LAUNCH_REQ=abc claude --continue"}, a)

	bin, a = Argv(Windows, proto.LaunchRequest{Dir: `C:\a;b`, PermissionMode: "plan"}, false)
	require.Equal(t, "wt.exe", bin)
	require.Equal(t, []string{"-d", `C:\a\;b`, "claude", "--permission-mode", "plan"}, a)

	bin, a = Argv(Darwin, proto.LaunchRequest{Dir: "/Users/u/my dir", PermissionMode: "bypass"}, false)
	require.Equal(t, "osascript", bin)
	require.Equal(t, []string{"-e", `tell app "Terminal" to do script "cd '/Users/u/my dir' && claude --dangerously-skip-permissions"`}, a)

	bin, a = Argv(Darwin, proto.LaunchRequest{Dir: `/Users/u/o'b "q"`}, false)
	require.Equal(t, "osascript", bin)
	require.Equal(t, `tell app "Terminal" to do script "cd '/Users/u/o'\\''b \"q\"' && claude"`, a[1])

	for _, e := range []Env{Linux, WSL, Windows, Darwin} {
		_, a := Argv(e, r, true)
		for _, x := range a {
			require.NotContains(t, x, "/claude")
		}
	}
	_, a = Argv(WSL, proto.LaunchRequest{Dir: "/x;y"}, false)
	require.Contains(t, a, `/x\;y`)
	_, a = Argv(Linux, proto.LaunchRequest{Dir: "/x", PermissionMode: "default"}, false)
	require.Equal(t, "bash -lc 'claude --permission-mode default'", a[len(a)-1], "Normal (asks for permissions) must force default mode even if the user has auto")
	_, a = Argv(Linux, proto.LaunchRequest{Dir: "/x"}, false)
	require.Equal(t, "bash -lc 'claude'", a[len(a)-1])
}

func TestShellQuote(t *testing.T) {
	require.Equal(t, `'a b'`, shellQuote("a b"))
	require.Equal(t, `'it'\''s'`, shellQuote("it's"))
	require.Equal(t, `'$HOME "x"'`, shellQuote(`$HOME "x"`))
}

func TestRunMissingDir(t *testing.T) {
	r := Run(context.Background(), proto.LaunchRequest{ReqID: "r1", Dir: "/no/existe/xyz"})
	require.Equal(t, proto.LaunchResult{ReqID: "r1", OK: false, Error: "the folder does not exist: /no/existe/xyz"}, r)
}

func TestRunRelativeDir(t *testing.T) {
	r := Run(context.Background(), proto.LaunchRequest{Dir: "rel/dir"})
	require.False(t, r.OK)
	require.Equal(t, "the folder must be an absolute path", r.Error)
}

func TestSuffix(t *testing.T) {
	require.Equal(t, "ab12cd", suffix("ab12cd9999"))
	require.Len(t, suffix(""), 6)
}

func TestRunInvalidMode(t *testing.T) {
	r := Run(context.Background(), proto.LaunchRequest{Dir: t.TempDir(), PermissionMode: "x; rm"})
	require.False(t, r.OK)
	require.Equal(t, "invalid permission mode", r.Error)
}

func TestRunExec(t *testing.T) {
	old := execFn
	t.Cleanup(func() { execFn = old })
	var got []string
	execFn = func(_ context.Context, bin string, args ...string) ([]byte, error) {
		got = append([]string{bin}, args...)
		return nil, nil
	}
	dir := t.TempDir()
	r := Run(context.Background(), proto.LaunchRequest{ReqID: "r", Dir: dir})
	require.True(t, r.OK)
	require.NotEmpty(t, got)
	require.True(t, strings.Contains(strings.Join(got, " "), dir))

	execFn = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("boom\n"), errors.New("exit 1")
	}
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r", Dir: dir})
	require.False(t, r.OK)
	require.Contains(t, r.Error, "boom")
}

const nastyPrompt = "Ticket 41: it's \"q\"\n$HOME `id` ; \\ fin"

func TestArgvPrompt(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu")
	r := proto.LaunchRequest{ReqID: "abc", Dir: "/p", PermissionMode: "plan", Prompt: nastyPrompt}
	q := shellQuote(nastyPrompt)

	_, a := Argv(Linux, r, false)
	require.Equal(t, "bash -lc "+shellQuote("QUORUM_LAUNCH_REQ=abc claude --permission-mode plan -- "+q), a[len(a)-1])

	_, a = Argv(WSL, r, false)
	require.Equal(t, "QUORUM_LAUNCH_REQ=abc claude --permission-mode plan -- "+q, a[len(a)-1])

	r.Dir = `C:\p`
	_, a = Argv(Windows, r, false)
	require.Equal(t, []string{"-d", `C:\p`, "claude", "--permission-mode", "plan", "--", nastyPrompt}, a)

	r.Dir = "/p"
	_, a = Argv(Darwin, r, false)
	require.Equal(t, `tell app "Terminal" to do script "`+appleScriptEscape("cd '/p' && QUORUM_LAUNCH_REQ=abc claude --permission-mode plan -- "+q)+`"`, a[1])
}

func TestRunCollapsesLongPrompt(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	old := execFn
	t.Cleanup(func() { execFn = old })
	var got []string
	execFn = func(_ context.Context, bin string, args ...string) ([]byte, error) {
		got = append([]string{bin}, args...)
		return nil, nil
	}
	work := t.TempDir()
	qdir := filepath.Join(work, ".claude", "quorum")
	require.NoError(t, os.MkdirAll(qdir, 0o700))
	past := time.Now().Add(-48 * time.Hour)
	stale := filepath.Join(qdir, "ticket-old.md")
	require.NoError(t, os.WriteFile(stale, []byte("x"), 0o600))
	require.NoError(t, os.Chtimes(stale, past, past))
	fresh := filepath.Join(qdir, "ticket-fresh.md")
	require.NoError(t, os.WriteFile(fresh, []byte("x"), 0o600))
	legacy := tmp + "/quorum-ticket-old.md" // from earlier versions, in the temp dir
	require.NoError(t, os.WriteFile(legacy, []byte("x"), 0o600))
	require.NoError(t, os.Chtimes(legacy, past, past))

	r := Run(context.Background(), proto.LaunchRequest{ReqID: "r1/../x", Dir: work, Prompt: nastyPrompt})
	require.True(t, r.OK, r.Error)
	path := filepath.Join(qdir, "ticket-r1x.md")
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, nastyPrompt, string(b))
	st, _ := os.Stat(path)
	require.Equal(t, os.FileMode(0o600), st.Mode().Perm())
	require.Contains(t, strings.Join(got, " "), "Read the file "+path)
	require.NotContains(t, strings.Join(got, " "), "$HOME")
	_, err = os.Stat(stale)
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(legacy)
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(fresh)
	require.NoError(t, err, "files under 24 h are kept")

	// new folders: 0700; and O_EXCL: the same reqId does not overwrite an existing file
	work2 := t.TempDir()
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r3", Dir: work2, Prompt: nastyPrompt})
	require.True(t, r.OK, r.Error)
	for _, d := range []string{filepath.Join(work2, ".claude"), filepath.Join(work2, ".claude", "quorum")} {
		st, err := os.Stat(d)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o700), st.Mode().Perm(), d)
	}
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r3", Dir: work2, Prompt: nastyPrompt})
	require.False(t, r.OK)
	require.Contains(t, r.Error, "could not prepare the prompt")

	// short one-line prompt: goes directly, with no file
	got = nil
	work3 := t.TempDir()
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r2", Dir: work3, Prompt: "hello"})
	require.True(t, r.OK)
	require.Contains(t, strings.Join(got, " "), "hello")
	_, err = os.Stat(filepath.Join(work3, ".claude"))
	require.True(t, os.IsNotExist(err))
}

func TestWtNeverSeesSemicolon(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu")
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TEMP", tmp)
	for _, env := range []Env{WSL, Windows} {
		r, err := collapsePrompt(env, proto.LaunchRequest{ReqID: "w" + string(env), Dir: t.TempDir(), Prompt: "a; b"})
		require.NoError(t, err)
		require.Contains(t, r.Prompt, "Read the file")
		_, a := Argv(env, r, false)
		require.NotContains(t, strings.Join(a, " "), ";")
	}
	// outside wt.exe a short prompt with ';' goes directly
	r, _ := collapsePrompt(Linux, proto.LaunchRequest{ReqID: "l", Prompt: "a; b"})
	require.Equal(t, "a; b", r.Prompt)
}

func TestClaudeLineCarriesLaunchReq(t *testing.T) {
	require.Equal(t, "QUORUM_LAUNCH_REQ=r1x claude --continue", claudeLine(proto.LaunchRequest{ReqID: "r1/../x;$(id)"[:7], Continue: true}))
	require.Equal(t, "QUORUM_LAUNCH_REQ=abcid claude", claudeLine(proto.LaunchRequest{ReqID: "a'b c;$(id)"}))
	require.Equal(t, "claude", claudeLine(proto.LaunchRequest{ReqID: "';-"}))
	id := "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
	require.Equal(t, "QUORUM_LAUNCH_REQ=r claude --dangerously-skip-permissions --resume "+id,
		claudeLine(proto.LaunchRequest{ReqID: "r", PermissionMode: "bypass", Resume: id}))
	// native Windows (wt.exe without a shell): no prefix
	_, a := Argv(Windows, proto.LaunchRequest{ReqID: "r", Dir: `C:\p`, Resume: id}, false)
	require.Equal(t, []string{"-d", `C:\p`, "claude", "--resume", id}, a)
}

func TestBypassRejectedAsRoot(t *testing.T) {
	old, oldExec := geteuid, execFn
	t.Cleanup(func() { geteuid, execFn = old, oldExec })
	called := false
	execFn = func(context.Context, string, ...string) ([]byte, error) { called = true; return nil, nil }
	geteuid = func() int { return 0 }
	r := Run(context.Background(), proto.LaunchRequest{ReqID: "r", Dir: t.TempDir(), PermissionMode: "bypass"})
	require.Equal(t, proto.LaunchResult{ReqID: "r", Error: "Skip permissions does not work as root"}, r)
	require.False(t, called)
	// as root, normal mode does launch
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r", Dir: t.TempDir(), PermissionMode: "default"})
	require.True(t, r.OK, r.Error)
	require.NotEmpty(t, r.Via)
	geteuid = func() int { return 1000 }
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r", Dir: t.TempDir(), PermissionMode: "bypass"})
	require.True(t, r.OK, r.Error)
}

func TestRunRejectsBadResume(t *testing.T) {
	for _, bad := range []string{"abc", "--------", "-----------------", "x; rm -rf /", "0f1e2d3c 4b5a", strings.Repeat("a", 65)} {
		r := Run(context.Background(), proto.LaunchRequest{ReqID: "r", Dir: t.TempDir(), Resume: bad})
		require.False(t, r.OK, bad)
		require.Equal(t, "invalid conversation id", r.Error)
	}
}
