package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	ghMaxBody     = 20000
	ghMaxComments = 5
	ghMaxFetches  = 30 // tope de peticiones de comentarios por sync
	ghTimeout     = 3 * time.Minute
	ghMaxStdout   = 64 << 20
)

// ghRunner ejecuta `gh` con el entorno del conector y devuelve su stdout.
type ghRunner func(ctx context.Context, env []string, args ...string) ([]byte, error)

type githubConnector struct {
	repo           string
	labelsAsStatus bool
	env            []string
	token          string
	run            ghRunner
}

func init() {
	Register("github", func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
		return newGitHub(cfg, token, env, defaultGhRunner(ghTimeout))
	})
}

func newGitHub(cfg proto.ConnectorConfig, token string, env []string, run ghRunner) (*githubConnector, error) {
	repo := strings.TrimSpace(cfg.Settings["repo"])
	if repo == "" {
		return nil, errors.New("GitHub: falta el repo (owner/nombre)")
	}
	return &githubConnector{
		repo:           repo,
		labelsAsStatus: strings.EqualFold(strings.TrimSpace(cfg.Settings["labelsAsStatus"]), "true"),
		env:            env,
		token:          token,
		run:            run,
	}, nil
}

// errNoGh: gh no está ni en el PATH del hub ni en el de su shell de login.
var errNoGh = errors.New("GitHub: no encontré el comando gh en el hub")

// ghLoginScript ejecuta gh con los argumentos como parámetros posicionales ("$@"):
// nunca se interpolan en el texto del script.
const ghLoginScript = `exec gh "$@"`

// ghCommand decide cómo lanzar gh. Fuera de Windows va por un shell de login
// (bash -lc) para que apliquen los shims de whoas también bajo systemd; en Windows
// (o sin bash) se ejecuta gh del PATH directamente.
func ghCommand(goos string, lookPath func(string) (string, error), args []string) (name string, argv []string, err error) {
	if goos != "windows" {
		if bash, e := lookPath("bash"); e == nil {
			return bash, append([]string{"-lc", ghLoginScript, "gh"}, args...), nil
		}
	}
	path, err := lookPath("gh")
	if err != nil {
		return "", nil, errNoGh
	}
	return path, args, nil
}

var ghRouteOnce sync.Once

// logGhRoute deja en el log, una vez, por dónde se resuelve gh.
func logGhRoute(ctx context.Context, name string, env []string) {
	ghRouteOnce.Do(func() {
		if filepath.Base(name) != "bash" {
			log.Printf("connectors: gh directo (%s)", name)
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		c := exec.CommandContext(cctx, name, "-lc", "command -v gh")
		c.Env = env
		out, _ := c.Output()
		where := strings.TrimSpace(string(out))
		if where == "" {
			where = "no encontrado"
		}
		log.Printf("connectors: gh por shell de login (%s -lc): %s", name, where)
	})
}

// defaultGhRunner ejecuta gh (ver ghCommand) con timeout, tope de stdout y grupo de procesos.
func defaultGhRunner(timeout time.Duration) ghRunner {
	return func(ctx context.Context, env []string, args ...string) ([]byte, error) {
		name, argv, err := ghCommand(runtime.GOOS, exec.LookPath, args)
		if err != nil {
			return nil, err
		}
		logGhRoute(ctx, name, env)
		cctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		cmd := exec.CommandContext(cctx, name, argv...)
		cmd.Env = env
		out := &capWriter{max: ghMaxStdout, cancel: cancel}
		errb := capWriter{max: maxStderr * 4, cancel: func() {}}
		cmd.Stdout, cmd.Stderr = out, &errb
		setupProcessGroup(cmd)
		runErr := cmd.Run()
		if out.overflow {
			return nil, errors.New("respuesta demasiado grande")
		}
		if runErr != nil {
			if errors.Is(cctx.Err(), context.DeadlineExceeded) {
				return nil, fmt.Errorf("tiempo de espera agotado (%s)", timeout)
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var ee *exec.ExitError
			if errors.As(runErr, &ee) && ee.ExitCode() == 127 && filepath.Base(name) == "bash" {
				return nil, errNoGh // exec de bash: gh no está en el PATH del shell de login
			}
			if s := clip(errb.buf.String(), maxStderr); s != "" {
				return nil, errors.New(s)
			}
			return nil, runErr
		}
		return out.buf.Bytes(), nil
	}
}

func (g *githubConnector) gh(ctx context.Context, args ...string) ([]byte, error) {
	out, err := g.run(ctx, g.env, args...)
	if err != nil {
		return nil, errors.New(redact(g.friendly(err), g.token))
	}
	return out, nil
}

func (g *githubConnector) friendly(err error) string {
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, "GitHub:"):
		return msg
	case strings.Contains(msg, "HTTP 401") || strings.Contains(strings.ToLower(msg), "authentication"):
		return "GitHub: credenciales inválidas (revisa el perfil de whoas)"
	case strings.Contains(msg, "HTTP 404"):
		return fmt.Sprintf("GitHub: repositorio no encontrado (%s)", g.repo)
	case errors.Is(err, exec.ErrNotFound):
		return "GitHub: no encontré el comando gh en el hub"
	}
	return "GitHub: " + clip(msg, maxStderr)
}

type ghIssue struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	State       string          `json:"state"`
	Body        string          `json:"body"`
	HTMLURL     string          `json:"html_url"`
	UpdatedAt   time.Time       `json:"updated_at"`
	PullRequest json.RawMessage `json:"pull_request"`
	Labels      []struct {
		Name string `json:"name"`
	} `json:"labels"`
	Assignees []struct {
		Login string `json:"login"`
	} `json:"assignees"`
}

type ghComment struct {
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
	User      struct {
		Login string `json:"login"`
	} `json:"user"`
}

// decodePages lee los arrays JSON concatenados que produce `gh api --paginate`.
func decodePages[T any](data []byte) ([]T, error) {
	var all []T
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var page []T
		if err := dec.Decode(&page); err != nil {
			if errors.Is(err, io.EOF) {
				return all, nil
			}
			return nil, fmt.Errorf("GitHub: respuesta inválida: %v", err)
		}
		all = append(all, page...)
	}
}

var ghStatusLabels = []struct {
	status string
	names  []string
}{
	{"en_curso", []string{"en curso", "in progress"}},
	{"en_review", []string{"review", "in review"}},
	{"bloqueado", []string{"blocked", "bloqueado"}},
}

func (g *githubConnector) rawStatus(is ghIssue) string {
	if is.State == "closed" {
		return "closed"
	}
	if g.labelsAsStatus {
		for _, sl := range ghStatusLabels {
			for _, l := range is.Labels {
				for _, n := range sl.names {
					if strings.EqualFold(strings.TrimSpace(l.Name), n) {
						return is.State + ":" + n
					}
				}
			}
		}
	}
	return is.State
}

func (g *githubConnector) List(ctx context.Context, since int64) ([]proto.Ticket, error) {
	// Primer sync: solo abiertos (los cerrados históricos pueden ser miles).
	q := "state=open&per_page=100"
	if since > 0 {
		q = "state=all&since=" + time.UnixMilli(since).UTC().Format(time.RFC3339) + "&per_page=100"
	}
	out, err := g.gh(ctx, "api", "--paginate", "repos/"+g.repo+"/issues?"+q)
	if err != nil {
		return nil, err
	}
	issues, err := decodePages[ghIssue](out)
	if err != nil {
		return nil, err
	}
	var tickets []proto.Ticket
	fetches := 0
	for _, is := range issues {
		if len(is.PullRequest) > 0 && string(is.PullRequest) != "null" {
			continue
		}
		t := proto.Ticket{
			ExternalID: strconv.Itoa(is.Number),
			Title:      is.Title,
			RawStatus:  g.rawStatus(is),
			URL:        is.HTMLURL,
			Body:       clipRunes(is.Body, ghMaxBody),
			UpdatedAt:  is.UpdatedAt.UnixMilli(),
		}
		if len(is.Assignees) > 0 {
			t.Assignee = is.Assignees[0].Login
		}
		if is.State == "open" && fetches < ghMaxFetches {
			fetches++
			cs, err := g.comments(ctx, is.Number)
			if err == nil { // un fallo aislado no aborta el sync: Comments nil conserva los guardados
				t.Comments = cs
			}
		}
		tickets = append(tickets, t)
	}
	return tickets, nil
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// comments devuelve los últimos 5 comentarios (el endpoint los entrega del más viejo al más nuevo).
func (g *githubConnector) comments(ctx context.Context, n int) ([]proto.TicketComment, error) {
	path := fmt.Sprintf("repos/%s/issues/%d/comments?per_page=100", g.repo, n)
	out, err := g.gh(ctx, "api", "--paginate", path)
	if err != nil {
		return nil, err
	}
	cs, err := decodePages[ghComment](out)
	if err != nil {
		return nil, err
	}
	if len(cs) > ghMaxComments {
		cs = cs[len(cs)-ghMaxComments:]
	}
	res := make([]proto.TicketComment, 0, len(cs))
	for _, c := range cs {
		res = append(res, proto.TicketComment{Author: c.User.Login, Body: c.Body, At: c.CreatedAt.UnixMilli()})
	}
	return res, nil
}

func (g *githubConnector) Comment(ctx context.Context, externalID, body string) error {
	_, err := g.gh(ctx, "api", "-X", "POST", "repos/"+g.repo+"/issues/"+externalID+"/comments", "-f", "body="+body)
	return err
}

func (g *githubConnector) SetStatus(ctx context.Context, externalID, status string) error {
	base := "repos/" + g.repo + "/issues/" + externalID
	var err error
	switch status {
	case "hecho":
		if _, err = g.gh(ctx, "api", "-X", "PATCH", base, "-f", "state=closed"); err == nil {
			err = g.removeLabels(ctx, base, "")
		}
	case "por_hacer":
		if _, err = g.gh(ctx, "api", "-X", "PATCH", base, "-f", "state=open"); err == nil {
			err = g.removeLabels(ctx, base, "")
		}
	case "en_curso", "en_review", "bloqueado":
		label := ghSetLabels[status]
		if _, err = g.gh(ctx, "api", "-X", "POST", base+"/labels", "-f", "labels[]="+label); err == nil {
			err = g.removeLabels(ctx, base, label)
		}
	default:
		return fmt.Errorf("GitHub: estado desconocido %q", status)
	}
	return err
}

var ghSetLabels = map[string]string{"en_curso": "en curso", "en_review": "review", "bloqueado": "blocked"}

// removeLabels quita las labels de estado salvo keep; un 404 (la label no estaba) se ignora.
func (g *githubConnector) removeLabels(ctx context.Context, base, keep string) error {
	for _, l := range []string{"en curso", "review", "blocked"} {
		if l == keep {
			continue
		}
		if _, err := g.gh(ctx, "api", "-X", "DELETE", base+"/labels/"+url.PathEscape(l)); err != nil && !strings.Contains(err.Error(), "no encontrado") {
			return err
		}
	}
	return nil
}
