package summary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Completer is the extended model interface of long jobs (meeting summaries): a bigger output cap, a
// longer timeout and, when the provider supports it, JSON output. The project summary keeps Model.
type Completer interface {
	Complete(ctx context.Context, prompt string, maxTokens int, json bool) (string, error)
}

// LongTimeout bounds one call of a Completer (a 15-minute section of a meeting, or the merge).
const LongTimeout = 10 * time.Minute

const maxLongResponse = 4 << 20

// DefaultMeetingModel is the ccapi model of meeting summaries when none is configured.
const DefaultMeetingModel = "sonnet"

// Long returns a Completer that runs model (DefaultMeetingModel when "") through ccapi when it answers
// with the token, else through `claude -p` in a login shell, with LongTimeout per call.
func (a *Auto) Long(model string) Completer {
	if strings.TrimSpace(model) == "" {
		model = DefaultMeetingModel
	}
	return &longAuto{a: a, model: strings.TrimSpace(model)}
}

type longAuto struct {
	a     *Auto
	model string
}

func (l *longAuto) Complete(ctx context.Context, prompt string, maxTokens int, _ bool) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, LongTimeout)
	defer cancel()
	if c := l.a.pick(ctx); c != nil {
		out, err := c.message(ctx, l.model, prompt, maxTokens, LongTimeout)
		if err == nil {
			return out, nil
		}
		if ctx.Err() != nil {
			return "", err
		}
		l.a.mu.Lock()
		l.a.checked = false
		l.a.mu.Unlock()
	}
	return longCLI(ctx, l.model, prompt)
}

// message is POST /v1/messages with the model, the output cap and the timeout of one call.
func (c *ccapi) message(ctx context.Context, model, prompt string, maxTokens int, timeout time.Duration) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": maxTokens,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.url, "/")+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("x-api-key", c.key)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("ccapi: %w", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxLongResponse))
	if err != nil {
		return "", fmt.Errorf("ccapi: %w", err)
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("ccapi: HTTP %d", resp.StatusCode)
	}
	var r struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return "", errors.New("ccapi: invalid response")
	}
	var out strings.Builder
	for _, c := range r.Content {
		if c.Type == "" || c.Type == "text" {
			out.WriteString(c.Text)
		}
	}
	if out.Len() == 0 {
		return "", errors.New("ccapi: empty response")
	}
	return out.String(), nil
}

// longCLI runs `claude -p --model <model>` with the context's deadline.
func longCLI(ctx context.Context, model, prompt string) (string, error) {
	dir, cleanup, err := cliDir()
	if err != nil {
		return "", fmt.Errorf("claude -p: %v", err)
	}
	defer cleanup()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "claude", "-p", "--model", model, "--tools", "", "--output-format", "text", prompt)
		cmd.Env = append(environ(), cliEnv...)
	} else {
		cmd = exec.CommandContext(ctx, "bash", "-lc", `claude -p --model "$QUORUM_MODEL" --tools "" --output-format text "$QUORUM_PROMPT"`)
		cmd.Env = append(append(environ(), cliEnv...), "QUORUM_PROMPT="+prompt, "QUORUM_MODEL="+model)
	}
	cmd.Dir = dir
	out := &limitBuf{max: maxLongResponse}
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

// OpenAI is an OpenAI-compatible chat completions API (OpenAI, OpenRouter, a local vLLM, …). Key is sent
// as a bearer token and never appears in an error.
type OpenAI struct {
	BaseURL, Model, Key string
	HTTP                *http.Client
}

// ValidBaseURL: an http(s) URL with a host, no user info, no query and no fragment.
func ValidBaseURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}

func (o *OpenAI) Complete(ctx context.Context, prompt string, maxTokens int, jsonOut bool) (string, error) {
	if !ValidBaseURL(o.BaseURL) {
		return "", errors.New("the OpenAI-compatible base URL is not an http(s) URL")
	}
	if strings.TrimSpace(o.Model) == "" {
		return "", errors.New("no model is set for the OpenAI-compatible provider")
	}
	ctx, cancel := context.WithTimeout(ctx, LongTimeout)
	defer cancel()
	out, code, err := o.chat(ctx, prompt, maxTokens, jsonOut)
	if err == nil {
		return out, nil
	}
	// some compatible servers do not know response_format: once more without it
	if jsonOut && code == http.StatusBadRequest {
		out, _, err = o.chat(ctx, prompt, maxTokens, false)
	}
	return out, err
}

func (o *OpenAI) chat(ctx context.Context, prompt string, maxTokens int, jsonOut bool) (string, int, error) {
	body := map[string]any{
		"model": strings.TrimSpace(o.Model), "temperature": 0.2,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	}
	if maxTokens > 0 {
		body["max_tokens"] = maxTokens
	}
	if jsonOut {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(strings.TrimSpace(o.BaseURL), "/")+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", 0, errors.New("the OpenAI-compatible base URL is invalid")
	}
	req.Header.Set("Content-Type", "application/json")
	if o.Key != "" {
		req.Header.Set("Authorization", "Bearer "+o.Key)
	}
	hc := o.HTTP
	if hc == nil {
		hc = &http.Client{}
	}
	// a redirect is followed only to the same scheme and host: the key and the transcript never go elsewhere
	c := *hc
	c.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 || r.URL.Scheme != via[0].URL.Scheme || r.URL.Host != via[0].URL.Host {
			return http.ErrUseLastResponse
		}
		return nil
	}
	hc = &c
	resp, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", 0, fmt.Errorf("the summary provider did not answer in time (%s)", LongTimeout)
		}
		return "", 0, fmt.Errorf("the summary provider is not reachable at %s", hostOf(o.BaseURL))
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(io.LimitReader(resp.Body, maxLongResponse))
	if err != nil {
		return "", resp.StatusCode, errors.New("the summary provider's answer could not be read")
	}
	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rb, &r)
	if resp.StatusCode != 200 {
		msg := fmt.Sprintf("the summary provider answered HTTP %d", resp.StatusCode)
		if r.Error != nil && strings.TrimSpace(r.Error.Message) != "" {
			msg += ": " + clipMsg(redactKey(r.Error.Message, o.Key), 200)
		}
		return "", resp.StatusCode, errors.New(msg)
	}
	if len(r.Choices) == 0 || strings.TrimSpace(r.Choices[0].Message.Content) == "" {
		return "", resp.StatusCode, errors.New("the summary provider returned an empty answer")
	}
	return r.Choices[0].Message.Content, resp.StatusCode, nil
}

func hostOf(s string) string {
	if u, err := url.Parse(strings.TrimSpace(s)); err == nil && u.Host != "" {
		return u.Host
	}
	return "the configured address"
}

func redactKey(s, key string) string {
	if len(key) >= 4 {
		s = strings.ReplaceAll(s, key, "[redacted]")
	}
	return s
}

func clipMsg(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

var environ = os.Environ

// cliDir is a neutral temporary working directory for `claude -p`; cleanup deletes it.
func cliDir() (string, func(), error) {
	dir, err := os.MkdirTemp("", "quorum-summary-")
	if err != nil {
		return "", nil, err
	}
	return dir, func() { os.RemoveAll(dir) }, nil
}
