package launch

import (
	"os"
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

	// a worktree: .git is a file, left alone
	wt := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /elsewhere\n"), 0o644))
	_, err = promptToFile(proto.LaunchRequest{ReqID: "b", Dir: wt, Prompt: "x"}, true)
	require.NoError(t, err)
	b, _ := os.ReadFile(filepath.Join(wt, ".git"))
	require.Equal(t, "gitdir: /elsewhere\n", string(b))
}
