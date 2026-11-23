package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/connectors"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/hub/summary"
	"github.com/S-kkipie/quorum/internal/proto"
)

type Server struct {
	st  *store.Store
	mux *http.ServeMux
	hub *Hub

	live  *Live
	sum   *summary.Summarizer
	sync  *connectors.Syncer
	asks  *askTracker
	fails *failLimiter
}

// Options configura el servidor; todos los campos son opcionales.
type Options struct {
	// Model genera los resúmenes de proyecto; nil usa ccapi (CCAPIURL/CCAPITokenFile) o `claude -p`.
	Model          summary.Model
	CCAPIURL       string
	CCAPITokenFile string
}

func NewServer(st *store.Store, opts ...Options) *Server {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	s := &Server{st: st, mux: http.NewServeMux(), hub: newHub(st), asks: newAskTracker(), fails: newFailLimiter()}
	// Tras un reinicio nadie está conectado: cada máquina vuelve a en línea con su hello.
	if err := st.MarkAllMachinesOffline(); err != nil {
		log.Printf("hub: marcar máquinas fuera de línea: %v", err)
	}
	if open, err := st.OpenAsks(); err != nil {
		log.Printf("hub: recuperar asks abiertos: %v", err)
	} else {
		s.asks.open = open
	}
	if err := st.FailInterruptedProposals(); err != nil {
		log.Printf("hub: propuestas interrumpidas: %v", err)
	}
	s.mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": proto.Version})
	})
	s.mux.HandleFunc("POST /api/pair", s.handlePair)
	s.mux.HandleFunc("POST /api/link", s.handleLink)
	s.mux.Handle("GET /api/machine/ws", s.requireMachine(http.HandlerFunc(s.handleMachineWS)))
	s.live = newLive(s)
	s.hub.SetBroadcaster(s.live)
	s.sync = connectors.NewSyncer(st, s.hub.publish)
	if o.Model == nil {
		o.Model = summary.NewAuto(o.CCAPIURL, o.CCAPITokenFile)
	}
	s.sum = summary.New(st, o.Model, s.hub.publish)
	s.hub.touch = s.sum.Touch
	s.sync.OnChange = func(id string) {
		s.sum.Touch(id)
		s.hub.suggestProject(id) // el ticket de la rama de una sesión abierta pudo llegar ahora
	}
	s.hub.startupGrace()
	s.routes()
	return s
}

// Hub expone las conexiones de máquinas.
func (s *Server) Hub() *Hub { return s.hub }

// StartSync arranca el sincronizador de tickets (no bloquea); para al cancelarse ctx.
func (s *Server) StartSync(ctx context.Context) {
	s.sync.Start(ctx)
	s.sum.Start(ctx)
}

func (s *Server) Handler() http.Handler { return s.mux }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) issue(w http.ResponseWriter, r *http.Request, codeKind, code, tokKind, name string) {
	key := clientKey(r)
	if s.fails.blocked(key) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "demasiados intentos, espera un minuto"})
		return
	}
	tok, err := NewToken()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "error interno"})
		return
	}
	// Código y token en una transacción: si el token no se guarda, el código sigue valiendo.
	name, err = s.st.Pair(codeKind, code, tokKind, name, tok)
	if err != nil {
		if errors.Is(err, store.ErrInvalidCode) {
			s.fails.fail(key)
			writeJSON(w, 400, map[string]string{"error": "código inválido o vencido"})
		} else {
			writeJSON(w, 500, map[string]string{"error": "error interno"})
		}
		return
	}
	writeJSON(w, 200, map[string]string{"token": tok, "name": name})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(v); err != nil {
		writeJSON(w, 400, map[string]string{"error": "solicitud inválida"})
		return false
	}
	return true
}

const maxDeviceName = 64

// deviceName recorta espacios y limita el nombre a 64 caracteres ("dispositivo" si queda vacío).
func deviceName(n string) string {
	n = strings.TrimSpace(n)
	if utf8.RuneCountInString(n) > maxDeviceName {
		n = strings.TrimSpace(string([]rune(n)[:maxDeviceName]))
	}
	if n == "" {
		n = "dispositivo"
	}
	return n
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Code       string `json:"code"`
		DeviceName string `json:"deviceName"`
	}
	if !decode(w, r, &b) {
		return
	}
	b.DeviceName = deviceName(b.DeviceName)
	s.issue(w, r, "pair", b.Code, "device", b.DeviceName)
}

func (s *Server) handleLink(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Code    string `json:"code"`
		Machine string `json:"machine"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Machine == "" {
		writeJSON(w, 400, map[string]string{"error": "falta el nombre de la máquina"})
		return
	}
	s.issue(w, r, "link", b.Code, "machine", b.Machine)
}
