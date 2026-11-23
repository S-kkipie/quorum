package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	defaultTimeout = 30 * time.Second
	maxStdout      = 8 << 20
	maxStderr      = 500
)

type execConnector struct {
	argv     []string
	settings map[string]string
	token    string
	env      []string
	timeout  time.Duration
}

func newExec(cfg proto.ConnectorConfig, token string, env []string, timeout time.Duration) (*execConnector, error) {
	argv := strings.Fields(cfg.Settings["command"])
	if len(argv) == 0 {
		return nil, errors.New("missing connector command")
	}
	return &execConnector{argv: argv, settings: cfg.Settings, token: token, env: env, timeout: timeout}, nil
}

type execRequest struct {
	Op         string            `json:"op"`
	Since      int64             `json:"since"`
	ExternalID string            `json:"externalId,omitempty"`
	Body       string            `json:"body,omitempty"`
	Status     string            `json:"status,omitempty"`
	Settings   map[string]string `json:"settings"`
	Token      string            `json:"token"`
}

type execResponse struct {
	Tickets []proto.Ticket `json:"tickets"`
	OK      bool           `json:"ok"`
	Error   string         `json:"error"`
}

// capWriter keeps up to max bytes; when exceeded it kills the process.
type capWriter struct {
	buf      bytes.Buffer
	max      int
	overflow bool
	cancel   context.CancelFunc
}

func (w *capWriter) Write(p []byte) (int, error) {
	if room := w.max - w.buf.Len(); len(p) > room {
		w.buf.Write(p[:room])
		w.overflow = true
		w.cancel()
		return len(p), nil
	}
	return w.buf.Write(p)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func (e *execConnector) run(ctx context.Context, req execRequest) (execResponse, error) {
	resp, err := e.run1(ctx, req)
	if err != nil {
		err = errors.New(redact(err.Error(), e.token))
	}
	return resp, err
}

func (e *execConnector) run1(ctx context.Context, req execRequest) (execResponse, error) {
	var resp execResponse
	req.Settings, req.Token = e.settings, e.token
	in, err := json.Marshal(req)
	if err != nil {
		return resp, err
	}
	cctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, e.argv[0], e.argv[1:]...)
	cmd.Env = e.env
	cmd.Stdin = bytes.NewReader(append(in, '\n'))
	out := &capWriter{max: maxStdout, cancel: cancel}
	errb := capWriter{max: maxStderr * 4, cancel: func() {}}
	cmd.Stdout, cmd.Stderr = out, &errb
	setupProcessGroup(cmd)
	runErr := cmd.Run()
	if out.overflow {
		return resp, errors.New("response too large")
	}
	if runErr != nil {
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return resp, fmt.Errorf("timed out (%s)", e.timeout)
		}
		if ctx.Err() != nil {
			return resp, ctx.Err()
		}
		msg := fmt.Sprintf("the connector failed: %v", runErr)
		if s := clip(errb.buf.String(), maxStderr); s != "" {
			msg += ": " + s
		}
		return resp, errors.New(msg)
	}
	if err := json.Unmarshal(out.buf.Bytes(), &resp); err != nil {
		msg := "invalid connector response"
		if s := clip(errb.buf.String(), maxStderr); s != "" {
			msg += ": " + s
		}
		return resp, errors.New(msg)
	}
	if resp.Error != "" {
		return resp, errors.New(clip(resp.Error, maxStderr))
	}
	return resp, nil
}

func (e *execConnector) List(ctx context.Context, since int64) ([]proto.Ticket, error) {
	resp, err := e.run(ctx, execRequest{Op: "list", Since: since})
	if err != nil {
		return nil, err
	}
	return resp.Tickets, nil
}

func (e *execConnector) ack(ctx context.Context, req execRequest) error {
	resp, err := e.run(ctx, req)
	if err != nil {
		return err
	}
	if !resp.OK {
		return errors.New("invalid connector response")
	}
	return nil
}

func (e *execConnector) Comment(ctx context.Context, externalID, body string) error {
	return e.ack(ctx, execRequest{Op: "comment", ExternalID: externalID, Body: body})
}

func (e *execConnector) SetStatus(ctx context.Context, externalID, status string) error {
	return e.ack(ctx, execRequest{Op: "set_status", ExternalID: externalID, Status: status})
}
