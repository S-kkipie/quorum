package launch

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestPromptFileExcludedFromGit(t *testing.T) {
	repo := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(repo, ".git", "info"), 0o755))
	excl := filepath.Join(repo, ".git", "info", "exclude")
	require.NoError(t, os.WriteFile(excl, []byte("# git ls-files --others --exclude-from=.git/info/exclude\n*.log"), 0o644))
	for _, id := range []string{"a", "b"} {
		_, err := promptToFile(proto.LaunchRequest{ReqID: id, Dir: repo, Prompt: "x"}, true)
		require.NoError(t, err)
	}
	b, err := os.ReadFile(excl)
	require.NoError(t, err)
	require.Equal(t, "# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n.claude/quorum/\n", string(b), "appended once")
	_, err = os.Stat(filepath.Join(repo, ".gitignore"))
	require.True(t, os.IsNotExist(err), ".gitignore is never touched")

	// a session in a subfolder of the repository: the line is anchored to that folder
	sub := filepath.Join(repo, "app")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	_, err = promptToFile(proto.LaunchRequest{ReqID: "c", Dir: sub, Prompt: "x"}, true)
	require.NoError(t, err)
	b, _ = os.ReadFile(excl)
	require.True(t, strings.HasSuffix(string(b), "\n/app/.claude/quorum/\n"), string(b))
}

func TestPromptFileNoGitDir(t *testing.T) {
	dir := t.TempDir()
	_, err := promptToFile(proto.LaunchRequest{ReqID: "a", Dir: dir, Prompt: "x"}, true)
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(dir, ".git"))
	require.True(t, os.IsNotExist(err), "no .git is created")

	// a .git file pointing nowhere is left alone
	wt := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /nonexistent/elsewhere\n"), 0o644))
	_, err = promptToFile(proto.LaunchRequest{ReqID: "b", Dir: wt, Prompt: "x"}, true)
	require.NoError(t, err)
	b, _ := os.ReadFile(filepath.Join(wt, ".git"))
	require.Equal(t, "gitdir: /nonexistent/elsewhere\n", string(b))
}

// A git worktree (.git is a file): the line goes to the main repository's common info/exclude, once, and git
// really ignores the prompt files in the worktree.
func TestPromptFileExcludedInWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(cleanGitEnv(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return string(out)
	}
	repo := t.TempDir()
	git(repo, "init", "-q")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a"), 0o644))
	git(repo, "add", "a.txt")
	git(repo, "commit", "-q", "-m", "init")
	wt := filepath.Join(t.TempDir(), "wt")
	git(repo, "worktree", "add", "-q", wt)
	st, err := os.Lstat(filepath.Join(wt, ".git"))
	require.NoError(t, err)
	require.False(t, st.IsDir())

	for _, id := range []string{"a", "b"} {
		_, err := promptToFile(proto.LaunchRequest{ReqID: id, Dir: wt, Prompt: "x"}, true)
		require.NoError(t, err)
	}
	b, err := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude"))
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(b), ".claude/quorum/"), "appended once")
	require.Empty(t, strings.TrimSpace(git(wt, "status", "--porcelain")), "the prompt files are ignored")
	_, err = os.Stat(filepath.Join(wt, ".gitignore"))
	require.True(t, os.IsNotExist(err))
}

// cleanGitEnv is the environment without the GIT_* variables of the test runner.
func cleanGitEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "GIT_") {
			env = append(env, kv)
		}
	}
	return env
}
