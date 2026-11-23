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

// failLimiter acota los intentos fallidos de /api/pair y /api/link por IP remota
// (por minuto) para que un código de 6 dígitos no se pueda adivinar a fuerza bruta
// sin que un tercero bloquee a todos con unos pocos intentos.
type failLimiter struct {
	mu    sync.Mutex
	max   int // por clave
	total int // techo global (todas las claves): rotar IPs no multiplica el ritmo
	win   time.Duration
	times map[string][]time.Time
	all   []time.Time
	now   func() time.Time
}

// maxLimiterKeys acota el mapa; si se llena, las IPs nuevas comparten la clave global.
const maxLimiterKeys = 4096

func newFailLimiter() *failLimiter {
	return &failLimiter{max: 10, total: 30, win: time.Minute, times: map[string][]time.Time{}, now: time.Now}
}

func (l *failLimiter) trim(key string) []time.Time { // con l.mu tomado
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

func (l *failLimiter) trimAll() { // con l.mu tomado
	cut := l.now().Add(-l.win)
	i := 0
	for i < len(l.all) && !l.all[i].After(cut) {
		i++
	}
	l.all = l.all[i:]
}

// blocked: ya hubo max fallos de key, o total fallos en conjunto, en la ventana.
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
		for k := range l.times { // limpia las claves vencidas antes de rendirse
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

// clientKey identifica al cliente para el limitador: su IP remota. Si la conexión
// viene de loopback (proxy local, p. ej. tailscale serve) se usa la ÚLTIMA entrada de
// X-Forwarded-For: la que añadió ese proxy de confianza; las anteriores las pone el
// cliente y se pueden falsificar. Sin IP reconocible, la clave global "".
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

// tokenRecheck: cada cuánto un WebSocket vivo (app o máquina) vuelve a validar su
// token. `quorum-hub revoke` corre en otro proceso y solo toca la BD, así que el
// servidor no se entera: la conexión de un token revocado se cierra en la próxima
// comprobación (como mucho tokenRecheck después). En nanosegundos; los tests lo acortan.
var tokenRecheck atomic.Int64

func init() { tokenRecheck.Store(int64(60 * time.Second)) }

// watchToken cierra la conexión (llamando a closeFn) si el token del contexto deja
// de validar; termina con ctx.
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

// NewToken genera 32 bytes aleatorios en base64url sin relleno.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// AuthName devuelve el nombre autenticado (dispositivo o máquina) del contexto.
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
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no autorizado"})
	})
}
