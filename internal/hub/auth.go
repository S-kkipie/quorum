package hub

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// failLimiter bounds failed attempts at /api/pair and /api/link per remote IP
// (per minute) so a 6-digit code cannot be brute-forced
// without a third party being able to lock everyone out with a few attempts.
type failLimiter struct {
	mu    sync.Mutex
	max   int // per key
	total int // global ceiling (all keys): rotating IPs does not multiply the rate
	win   time.Duration
	times map[string][]time.Time
	all   []time.Time
	now   func() time.Time
}

// maxLimiterKeys bounds the map; if it fills up, new IPs share the global key.
const maxLimiterKeys = 4096

func newFailLimiter() *failLimiter {
	return &failLimiter{max: 10, total: 30, win: time.Minute, times: map[string][]time.Time{}, now: time.Now}
}

func (l *failLimiter) trim(key string) []time.Time { // with l.mu held
	cut := l.now().Add(-l.win)
	ts := l.times[key]
	i := 0
	for i < len(ts) && !ts[i].After(cut) {
		i++
	}
	ts = ts[i:]
	if len(ts) == 0 {
		delete(l.times, key)
	} else {
		l.times[key] = ts
	}
	return ts
}

func (l *failLimiter) trimAll() { // with l.mu held
	cut := l.now().Add(-l.win)
	i := 0
	for i < len(l.all) && !l.all[i].After(cut) {
		i++
	}
	l.all = l.all[i:]
}

// blocked: there were already max failures for key, or total failures overall, in the window.
func (l *failLimiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.trimAll()
	if len(l.all) >= l.total {
		return true
	}
	if _, ok := l.times[key]; !ok && len(l.times) >= maxLimiterKeys {
		key = ""
	}
	return len(l.trim(key)) >= l.max
}

func (l *failLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.times[key]; !ok && len(l.times) >= maxLimiterKeys {
		for k := range l.times { // drop expired keys before giving up
			l.trim(k)
		}
		if len(l.times) >= maxLimiterKeys {
			key = ""
		}
	}
	l.times[key] = append(l.trim(key), l.now())
	l.trimAll()
	l.all = append(l.all, l.now())
}

// clientKey identifies the client for the limiter: its remote IP. If the connection
// comes from loopback (local proxy, e.g. tailscale serve) the LAST entry of
// X-Forwarded-For is used: the one added by that trusted proxy; the earlier ones are set by the
// client and can be forged. With no recognizable IP, the global key "".
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	if ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			last := strings.TrimSpace(parts[len(parts)-1])
			if fip := net.ParseIP(last); fip != nil {
				return fip.String()
			}
		}
	}
	return ip.String()
}

type ctxKey struct{}
type tokKey struct{}

// tokenRecheck: how often a live WebSocket (app or machine) revalidates its
// token. `quorum-hub revoke` runs in another process and only touches the DB, so the
// server does not find out: a revoked token's connection is closed at the next
// check (at most tokenRecheck later). In nanoseconds; tests shorten it.
var tokenRecheck atomic.Int64

func init() { tokenRecheck.Store(int64(60 * time.Second)) }

// watchToken closes the connection (calling closeFn) if the context's token stops
// validating; ends with ctx.
func (s *Server) watchToken(ctx context.Context, kind string, closeFn func()) {
	tok, _ := ctx.Value(tokKey{}).(string)
	t := time.NewTicker(time.Duration(tokenRecheck.Load()))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, ok := s.st.CheckToken(kind, tok); !ok {
				closeFn()
				return
			}
		}
	}
}

// NewToken generates 32 random bytes in unpadded base64url.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// AuthName returns the authenticated name (device or machine) of the context.
func AuthName(ctx context.Context) string {
	n, _ := ctx.Value(ctxKey{}).(string)
	return n
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func isWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func (s *Server) requireDevice(h http.Handler) http.Handler {
	return s.require("device", true, h)
}

func (s *Server) requireMachine(h http.Handler) http.Handler {
	return s.require("machine", false, h)
}

func (s *Server) require(kind string, allowQuery bool, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := bearer(r)
		if tok == "" && allowQuery && isWebSocket(r) {
			tok = r.URL.Query().Get("token")
		}
		if tok != "" {
			if name, ok := s.st.CheckToken(kind, tok); ok {
				ctx := context.WithValue(context.WithValue(r.Context(), ctxKey{}, name), tokKey{}, tok)
				h.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	})
}
