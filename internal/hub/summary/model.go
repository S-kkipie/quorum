package summary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Model generates text from a prompt.
type Model interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

const (
	ccapiTimeout   = 20 * time.Second
	cliTimeout     = 60 * time.Second
	maxCLIOutput   = 64 << 10
	selectionTTL   = 5 * time.Minute
	DefaultCCAPI   = "http://127.0.0.1:18787"
	ccapiMaxTokens = 120 // the summary (200 characters); a caller can raise it with withMaxTokens
)

// DefaultTokenFile is ~/.config/ccapi/token (honors XDG_CONFIG_HOME).
func DefaultTokenFile() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "ccapi", "token")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "ccapi", "token")
}

func readToken(path string) string {
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ccapi talks to the local Anthropic-compatible API.
type ccapi struct {
	url, key string
	hc       *http.Client
}

func (c *ccapi) do(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, ccapiTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.url, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("x-api-key", c.key)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return b, resp.StatusCode, err
}

func (c *ccapi) healthy(ctx context.Context) bool {
	_, code, err := c.do(ctx, http.MethodGet, "/v1/models", nil)
	return err == nil && code == 200
}

type maxTokensKey struct{}

// withMaxTokens sets the ccapi output cap of one call (the CLI has no such option and ignores it).
func withMaxTokens(ctx context.Context, n int) context.Context {
	return context.WithValue(ctx, maxTokensKey{}, n)
}

func maxTokens(ctx context.Context) int {
	if n, ok := ctx.Value(maxTokensKey{}).(int); ok && n > 0 {
		return n
	}
	return ccapiMaxTokens
}

func (c *ccapi) Complete(ctx context.Context, prompt string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": "haiku", "max_tokens": maxTokens(ctx),
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	b, code, err := c.do(ctx, http.MethodPost, "/v1/messages", body)
	if err != nil {
		return "", err
	}
	if code != 200 {
		return "", fmt.Errorf("ccapi: HTTP %d", code)
	}
	var r struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(b, &r); err != nil || len(r.Content) == 0 {
		return "", errors.New("ccapi: invalid response")
	}
	return r.Content[0].Text, nil
}

type limitBuf struct {
	buf bytes.Buffer
	max int
}

func (l *limitBuf) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

// claudeCLI runs `claude -p --model haiku` (through a login shell so the whoas shims apply).
type claudeCLI struct{}

// cliEnv marks the summarizer's session as a service (CCAPI_SERVER=1: no recap or control)
// and turns Quorum off in it (QUORUM_DISABLE=1: the mod does not register it).
var cliEnv = []string{"CCAPI_SERVER=1", "QUORUM_DISABLE=1"}

// cliCommand builds the command in a neutral temporary directory (not the hub's cwd);
// cleanup deletes it.
func cliCommand(ctx context.Context, prompt string) (cmd *exec.Cmd, cleanup func(), err error) {
	dir, err := os.MkdirTemp("", "quorum-summary-")
	if err != nil {
		return nil, nil, err
	}
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "claude", "-p", "--model", "haiku", "--tools", "", "--output-format", "text", prompt)
		cmd.Env = append(os.Environ(), cliEnv...)
	} else {
		cmd = exec.CommandContext(ctx, "bash", "-lc", `claude -p --model haiku --tools "" --output-format text "$QUORUM_PROMPT"`)
		cmd.Env = append(append(os.Environ(), cliEnv...), "QUORUM_PROMPT="+prompt)
	}
	cmd.Dir = dir
	return cmd, func() { os.RemoveAll(dir) }, nil
}

func (claudeCLI) Complete(ctx context.Context, prompt string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd, cleanup, err := cliCommand(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("claude -p: %v", err)
	}
	defer cleanup()
	out := &limitBuf{max: maxCLIOutput}
	errb := &limitBuf{max: 2048}
	cmd.Stdout, cmd.Stderr = out, errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("claude -p: %w", ctx.Err())
		}
		return "", fmt.Errorf("claude -p: %v: %s", err, strings.TrimSpace(errb.buf.String()))
	}
	return out.buf.String(), nil
}

// Auto picks ccapi if GET /v1/models answers with the token (decision cached 5 min); otherwise the CLI.
type Auto struct {
	URL, TokenFile string
	HTTP           *http.Client
	CLI            Model
	Now            func() time.Time

	mu      sync.Mutex
	until   time.Time
	useAPI  *ccapi
	checked bool
}

// NewAuto creates the selector; empty url or tokenFile take the defaults.
func NewAuto(url, tokenFile string) *Auto {
	if url == "" {
		url = DefaultCCAPI
	}
	if tokenFile == "" {
		tokenFile = DefaultTokenFile()
	}
	return &Auto{URL: url, TokenFile: tokenFile, HTTP: &http.Client{}, CLI: claudeCLI{}, Now: time.Now}
}

func (a *Auto) pick(ctx context.Context) *ccapi {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.checked && a.Now().Before(a.until) {
		return a.useAPI
	}
	a.checked, a.until, a.useAPI = true, a.Now().Add(selectionTTL), nil
	if key := readToken(a.TokenFile); key != "" {
		c := &ccapi{url: a.URL, key: key, hc: a.HTTP}
		if c.healthy(ctx) {
			a.useAPI = c
		}
	}
	return a.useAPI
}

func (a *Auto) Complete(ctx context.Context, prompt string) (string, error) {
	if c := a.pick(ctx); c != nil {
		out, err := c.Complete(ctx, prompt)
		if err == nil {
			return out, nil
		}
		a.mu.Lock()
		a.checked = false // check again next time
		a.mu.Unlock()
	}
	return a.CLI.Complete(ctx, prompt)
}

// Which says which implementation would be used now ("ccapi" or "claude").
func (a *Auto) Which(ctx context.Context) string {
	if a.pick(ctx) != nil {
		return "ccapi"
	}
	return "claude"
}
