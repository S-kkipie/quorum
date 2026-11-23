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
	require.Equal(t, []string{"new-session", "-d", "-s", "quorum-100-abc", "-c", "/home/u/p", "bash -lc 'claude --continue'"}, a)

	bin, a = Argv(WSL, r, false)
	require.Equal(t, "wt.exe", bin)
	require.Equal(t, []string{"wsl.exe", "-d", "Ubuntu", "--cd", "/home/u/p", "--", "bash", "-lic", "claude --continue"}, a)

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
	require.Equal(t, "bash -lc 'claude --permission-mode default'", a[len(a)-1], "Normal (pide permisos) debe forzar el modo default aunque el usuario tenga auto")
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
	require.Equal(t, proto.LaunchResult{ReqID: "r1", OK: false, Error: "la carpeta no existe: /no/existe/xyz"}, r)
}

func TestRunRelativeDir(t *testing.T) {
	r := Run(context.Background(), proto.LaunchRequest{Dir: "rel/dir"})
	require.False(t, r.OK)
	require.Equal(t, "la carpeta debe ser una ruta absoluta", r.Error)
}

func TestSuffix(t *testing.T) {
	require.Equal(t, "ab12cd", suffix("ab12cd9999"))
	require.Len(t, suffix(""), 6)
}

func TestRunInvalidMode(t *testing.T) {
	r := Run(context.Background(), proto.LaunchRequest{Dir: t.TempDir(), PermissionMode: "x; rm"})
	require.False(t, r.OK)
	require.Equal(t, "modo de permisos inválido", r.Error)
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
	require.Equal(t, "bash -lc "+shellQuote("claude --permission-mode plan -- "+q), a[len(a)-1])

	_, a = Argv(WSL, r, false)
	require.Equal(t, "claude --permission-mode plan -- "+q, a[len(a)-1])

	r.Dir = `C:\p`
	_, a = Argv(Windows, r, false)
	require.Equal(t, []string{"-d", `C:\p`, "claude", "--permission-mode", "plan", "--", nastyPrompt}, a)

	r.Dir = "/p"
	_, a = Argv(Darwin, r, false)
	require.Equal(t, `tell app "Terminal" to do script "`+appleScriptEscape("cd '/p' && claude --permission-mode plan -- "+q)+`"`, a[1])
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
	legacy := tmp + "/quorum-ticket-old.md" // de versiones anteriores, en el temporal
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
	require.Contains(t, strings.Join(got, " "), "Lee el archivo "+path)
	require.NotContains(t, strings.Join(got, " "), "$HOME")
	_, err = os.Stat(stale)
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(legacy)
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(fresh)
	require.NoError(t, err, "lo de menos de 24 h se conserva")

	// carpetas nuevas: 0700; y O_EXCL: el mismo reqId no pisa un fichero existente
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
	require.Contains(t, r.Error, "no se pudo preparar el prompt")

	// prompt corto de una línea: va directo, sin fichero
	got = nil
	work3 := t.TempDir()
	r = Run(context.Background(), proto.LaunchRequest{ReqID: "r2", Dir: work3, Prompt: "hola"})
	require.True(t, r.OK)
	require.Contains(t, strings.Join(got, " "), "hola")
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
		require.Contains(t, r.Prompt, "Lee el archivo")
		_, a := Argv(env, r, false)
		require.NotContains(t, strings.Join(a, " "), ";")
	}
	// fuera de wt.exe un prompt corto con ';' va directo
	r, _ := collapsePrompt(Linux, proto.LaunchRequest{ReqID: "l", Prompt: "a; b"})
	require.Equal(t, "a; b", r.Prompt)
}
