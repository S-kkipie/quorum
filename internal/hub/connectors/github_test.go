package connectors

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

type call struct {
	env  []string
	args []string
}

func fakeGh(calls *[]call, resp func(args []string) ([]byte, error)) ghRunner {
	return func(ctx context.Context, env []string, args ...string) ([]byte, error) {
		*calls = append(*calls, call{env, args})
		return resp(args)
	}
}

func ghConn(t *testing.T, labels string, run ghRunner) *githubConnector {
	g, err := newGitHub(proto.ConnectorConfig{Kind: "github", Settings: map[string]string{"repo": "o/r", "labelsAsStatus": labels}}, "", []string{"WHOAS_PROFILE=p"}, run)
	require.NoError(t, err)
	return g
}

const issuesJSON = `[{"number":1,"title":"A","state":"open","body":"b","html_url":"u1","updated_at":"2026-01-02T03:04:05Z","labels":[{"name":"In Progress"}],"assignees":[{"login":"ana"},{"login":"bo"}]},
{"number":2,"title":"PR","state":"open","pull_request":{"url":"x"},"updated_at":"2026-01-02T03:04:05Z"}][
{"number":3,"title":"C","state":"closed","labels":[{"name":"blocked"}],"updated_at":"2026-01-03T00:00:00Z"}]`

func TestGitHubList(t *testing.T) {
	var calls []call
	g := ghConn(t, "true", fakeGh(&calls, func(a []string) ([]byte, error) {
		if strings.Contains(a[len(a)-1], "/comments") {
			return []byte(`[{"body":"1","user":{"login":"x"},"created_at":"2026-01-01T00:00:00Z"},{"body":"2"},{"body":"3"}][{"body":"4"},{"body":"5"},{"body":"6"},{"body":"7"}]`), nil
		}
		return []byte(issuesJSON), nil
	}))
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	ts, err := g.List(context.Background(), since)
	require.NoError(t, err)
	require.Len(t, ts, 2)
	require.Equal(t, []string{"api", "--paginate", "repos/o/r/issues?state=all&since=2026-01-01T00:00:00Z&per_page=100"}, calls[0].args)
	require.Equal(t, []string{"WHOAS_PROFILE=p"}, calls[0].env)
	require.Equal(t, "1", ts[0].ExternalID)
	require.Equal(t, "open:in progress", ts[0].RawStatus)
	require.Equal(t, "en_curso", StatusMap(ts[0].RawStatus, nil))
	require.Equal(t, "ana", ts[0].Assignee)
	require.Equal(t, "u1", ts[0].URL)
	require.Len(t, ts[0].Comments, 5)
	require.Equal(t, "3", ts[0].Comments[0].Body)
	require.Equal(t, "7", ts[0].Comments[4].Body)
	require.Equal(t, "closed", ts[1].RawStatus)
	require.Equal(t, "hecho", StatusMap(ts[1].RawStatus, nil))
	require.Equal(t, []string{"api", "--paginate", "repos/o/r/issues/1/comments?per_page=100"}, calls[1].args)
	require.Len(t, calls, 2) // un solo fetch de comentarios: el cerrado no
}

func TestGitHubListNoSinceNoLabels(t *testing.T) {
	var calls []call
	g := ghConn(t, "false", fakeGh(&calls, func(a []string) ([]byte, error) {
		if strings.Contains(a[len(a)-1], "/comments") {
			return []byte(`[]`), nil
		}
		return []byte(issuesJSON), nil
	}))
	ts, err := g.List(context.Background(), 0)
	require.NoError(t, err)
	require.Equal(t, "repos/o/r/issues?state=open&per_page=100", calls[0].args[2])
	require.Equal(t, "open", ts[0].RawStatus)
}

func TestGitHubCommentFetchCap(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("[")
	for i := 1; i <= 40; i++ {
		if i > 1 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"number":` + strconv.Itoa(i) + `,"title":"t","state":"open","updated_at":"2026-01-01T00:00:00Z"}`)
	}
	sb.WriteString("]")
	var calls []call
	g := ghConn(t, "false", fakeGh(&calls, func(a []string) ([]byte, error) {
		if strings.Contains(a[len(a)-1], "/comments") {
			return []byte(`[]`), nil
		}
		return []byte(sb.String()), nil
	}))
	ts, err := g.List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, ts, 40)
	require.Len(t, calls, 1+30)
}

func TestGitHubWrites(t *testing.T) {
	var calls []call
	g := ghConn(t, "", fakeGh(&calls, func([]string) ([]byte, error) { return []byte(`{}`), nil }))
	ctx := context.Background()
	require.NoError(t, g.Comment(ctx, "7", "hola"))
	require.Equal(t, []string{"api", "-X", "POST", "repos/o/r/issues/7/comments", "-f", "body=hola"}, calls[0].args)

	calls = nil
	require.NoError(t, g.SetStatus(ctx, "7", "hecho"))
	require.Equal(t, []string{"api", "-X", "PATCH", "repos/o/r/issues/7", "-f", "state=closed"}, calls[0].args)
	require.Len(t, calls, 4)
	require.Equal(t, []string{"api", "-X", "DELETE", "repos/o/r/issues/7/labels/en%20curso"}, calls[1].args)

	calls = nil
	require.NoError(t, g.SetStatus(ctx, "7", "por_hacer"))
	require.Equal(t, []string{"api", "-X", "PATCH", "repos/o/r/issues/7", "-f", "state=open"}, calls[0].args)
	require.Len(t, calls, 4)

	calls = nil
	require.NoError(t, g.SetStatus(ctx, "7", "en_curso"))
	require.Equal(t, []string{"api", "-X", "POST", "repos/o/r/issues/7/labels", "-f", "labels[]=en curso"}, calls[0].args)
	require.Len(t, calls, 3)
	require.Equal(t, "repos/o/r/issues/7/labels/review", calls[1].args[3])
	require.Equal(t, "repos/o/r/issues/7/labels/blocked", calls[2].args[3])

	calls = nil
	require.NoError(t, g.SetStatus(ctx, "7", "en_review"))
	require.Equal(t, "labels[]=review", calls[0].args[5])
	calls = nil
	require.NoError(t, g.SetStatus(ctx, "7", "bloqueado"))
	require.Equal(t, "labels[]=blocked", calls[0].args[5])
	require.Error(t, g.SetStatus(ctx, "7", "x"))
}

func TestGitHubRemoveLabelIgnores404(t *testing.T) {
	var calls []call
	g := ghConn(t, "", fakeGh(&calls, func(a []string) ([]byte, error) {
		if a[2] == "DELETE" {
			return nil, errors.New("gh: Label does not exist (HTTP 404)")
		}
		return []byte(`{}`), nil
	}))
	require.NoError(t, g.SetStatus(context.Background(), "7", "hecho"))
}

func TestGitHubCommentFetchFailureKeepsNil(t *testing.T) {
	var calls []call
	g := ghConn(t, "false", fakeGh(&calls, func(a []string) ([]byte, error) {
		if strings.Contains(a[len(a)-1], "/comments") {
			return nil, errors.New("boom")
		}
		return []byte(issuesJSON), nil
	}))
	ts, err := g.List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, ts, 2)
	require.Nil(t, ts[0].Comments)
}

func TestGitHubErrors(t *testing.T) {
	for stderr, want := range map[string]string{
		"gh: Bad credentials (HTTP 401)":                          "GitHub: credenciales inválidas (revisa el perfil de whoas)",
		"To get started with GitHub CLI, authentication required": "GitHub: credenciales inválidas (revisa el perfil de whoas)",
		"gh: Not Found (HTTP 404)":                                "GitHub: repositorio no encontrado (o/r)",
		"boom":                                                    "GitHub: boom",
	} {
		var calls []call
		g := ghConn(t, "", fakeGh(&calls, func([]string) ([]byte, error) { return nil, errors.New(stderr) }))
		_, err := g.List(context.Background(), 0)
		require.EqualError(t, err, want)
	}
}

func TestGitHubMissingRepoAndRegistered(t *testing.T) {
	_, err := New(proto.ConnectorConfig{Kind: "github", Settings: map[string]string{}}, "", nil)
	require.EqualError(t, err, "GitHub: falta el repo (owner/nombre)")
	c, err := New(proto.ConnectorConfig{Kind: "github", Settings: map[string]string{"repo": "o/r"}}, "", nil)
	require.NoError(t, err)
	require.NotNil(t, c)
}

func TestDefaultGhRunnerNotFound(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := defaultGhRunner(time.Second)(context.Background(), nil, "api")
	require.EqualError(t, err, "GitHub: no encontré el comando gh en el hub")
}

func TestGhCommandArgv(t *testing.T) {
	look := func(n string) (string, error) { return "/bin/" + n, nil }
	args := []string{"api", "-f", `body=$(rm -rf ~); "x" 'y'`}
	name, argv, err := ghCommand("linux", look, args)
	require.NoError(t, err)
	require.Equal(t, "/bin/bash", name)
	require.Equal(t, append([]string{"-lc", `exec gh "$@"`, "gh"}, args...), argv)

	name, argv, err = ghCommand("windows", func(n string) (string, error) { return `C:\gh\` + n + ".exe", nil }, args)
	require.NoError(t, err)
	require.Equal(t, `C:\gh\gh.exe`, name)
	require.Equal(t, args, argv)

	// sin bash: gh directo; sin gh tampoco: error claro
	name, argv, err = ghCommand("linux", func(n string) (string, error) {
		if n == "bash" {
			return "", exec.ErrNotFound
		}
		return "/usr/bin/gh", nil
	}, args)
	require.NoError(t, err)
	require.Equal(t, "/usr/bin/gh", name)
	require.Equal(t, args, argv)
	_, _, err = ghCommand("linux", func(string) (string, error) { return "", exec.ErrNotFound }, args)
	require.EqualError(t, err, "GitHub: no encontré el comando gh en el hub")
}
