package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
)

var httpClient = &http.Client{Timeout: 20 * time.Second}

// ErrUnauthorized: the hub answered 401 to this device's token (revoked); retrying will not help.
var ErrUnauthorized = errors.New("the hub rejected this device's token (revoked?): run `quorum pair <hubURL> <code>`")

func base(hub string) string { return strings.TrimRight(hub, "/") }

func apiError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil && e.Error != "" {
		return fmt.Errorf("hub: %s", e.Error)
	}
	return fmt.Errorf("hub: HTTP %d", resp.StatusCode)
}

// Pair exchanges a pairing code for a device token.
func Pair(ctx context.Context, hub, code, device string) (string, error) {
	body, _ := json.Marshal(map[string]string{"code": code, "deviceName": device})
	req, err := http.NewRequestWithContext(ctx, "POST", base(hub)+"/api/pair", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", apiError(resp)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		return "", errors.New("hub: invalid pair response")
	}
	return out.Token, nil
}

// Do performs an authenticated REST call; body may be nil. The caller closes the response body.
// A non-2xx status becomes an error.
func Do(ctx context.Context, cfg Config, method, path string, body []byte) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, base(cfg.Hub)+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusUnauthorized {
			return nil, ErrUnauthorized
		}
		return nil, apiError(resp)
	}
	return resp, nil
}

// GetJSON GETs path and decodes the JSON answer into out.
func GetJSON(ctx context.Context, cfg Config, path string, out any) error {
	resp, err := Do(ctx, cfg, "GET", path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

// Sessions lists the sessions the hub knows.
func Sessions(ctx context.Context, cfg Config) ([]proto.SessionInfo, error) {
	var ss []proto.SessionInfo
	if err := GetJSON(ctx, cfg, "/api/sessions", &ss); err != nil {
		return nil, err
	}
	return ss, nil
}

// Backoff is the reconnect delay after `attempt` consecutive failures: 1 s, doubling, capped at 30 s.
func Backoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt >= 5 {
		return 30 * time.Second
	}
	return time.Second << attempt
}

// EnvConnected is a local marker (never sent by the hub) that Live delivers each time a connection
// is established, right before that connection's snapshot: what the previous connection reported
// may be stale from then on.
const EnvConnected = "quorum.connected"

// Live is the /api/live connection; it reconnects by itself, except after a 401.
type Live struct {
	ch     chan proto.Envelope
	cancel context.CancelFunc
	err    error // set before ch closes
}

// Envelopes delivers EnvConnected and the snapshot first, then updates, and both again after each reconnect.
func (l *Live) Envelopes() <-chan proto.Envelope { return l.ch }

// Err is why Envelopes closed: ErrUnauthorized when the hub rejected the token, else nil. Only
// read it after the channel is closed.
func (l *Live) Err() error { return l.err }

// Close stops the connection and the reconnects.
func (l *Live) Close() { l.cancel() }

// Dial starts the connection in the background; it only fails if the hub URL is invalid.
func Dial(ctx context.Context, cfg Config) (*Live, error) {
	if _, err := url.Parse(cfg.Hub); err != nil {
		return nil, err
	}
	return dial(ctx, cfg, Backoff), nil
}

func liveURL(cfg Config) string {
	u := base(cfg.Hub)
	switch {
	case strings.HasPrefix(u, "https://"):
		u = "wss://" + u[len("https://"):]
	case strings.HasPrefix(u, "http://"):
		u = "ws://" + u[len("http://"):]
	}
	return u + "/api/live?token=" + url.QueryEscape(cfg.Token)
}

func dial(ctx context.Context, cfg Config, delay func(int) time.Duration) *Live {
	ctx, cancel := context.WithCancel(ctx)
	l := &Live{ch: make(chan proto.Envelope, 16), cancel: cancel}
	go func() {
		defer close(l.ch)
		fails := 0
		for ctx.Err() == nil {
			got, err := l.session(ctx, cfg)
			if got {
				fails = 0
			}
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, ErrUnauthorized) {
				logf("live: %v", err)
				l.err = err
				return
			}
			if err != nil {
				logf("live: %v", redact(err, cfg.Token))
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay(fails)):
			}
			fails++
		}
	}()
	return l
}

// session runs one connection; got reports whether it was established.
func (l *Live) session(ctx context.Context, cfg Config) (got bool, err error) {
	c, resp, err := websocket.Dial(ctx, liveURL(cfg), nil)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return false, ErrUnauthorized
		}
		return false, err
	}
	defer c.CloseNow()
	c.SetReadLimit(32 << 20)
	select {
	case l.ch <- proto.Envelope{Type: EnvConnected}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return got, err
		}
		got = true
		var env proto.Envelope
		if json.Unmarshal(data, &env) != nil {
			continue
		}
		select {
		case l.ch <- env:
		case <-ctx.Done():
			return got, ctx.Err()
		}
	}
}

// redact hides the token if a library error echoes the URL.
func redact(err error, token string) string {
	s := err.Error()
	if token != "" {
		s = strings.ReplaceAll(s, url.QueryEscape(token), "***")
		s = strings.ReplaceAll(s, token, "***")
	}
	return s
}
