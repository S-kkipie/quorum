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
	views *viewLinks
}

// Options configures the server; all fields are optional.
type Options struct {
	// Model generates the project summaries; nil uses ccapi (CCAPIURL/CCAPITokenFile) or `claude -p`.
	Model          summary.Model
	CCAPIURL       string
	CCAPITokenFile string
	// FCMKeyFile is the Firebase service-account key that turns phone push on ("" = push off,
	// silently; quorum-hub serve passes DefaultFCMKeyFile, and a missing file there is logged once).
	FCMKeyFile string
}

func NewServer(st *store.Store, opts ...Options) *Server {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	s := &Server{st: st, mux: http.NewServeMux(), hub: newHub(st), asks: newAskTracker(), fails: newFailLimiter(), views: newViewLinks()}
	// After a restart nobody is connected: each machine comes back online with its hello.
	if err := st.MarkAllMachinesOffline(); err != nil {
		log.Printf("hub: mark machines offline: %v", err)
	}
	if open, err := st.OpenAsks(); err != nil {
		log.Printf("hub: recover open asks: %v", err)
	} else {
		s.asks.open = open
	}
	if err := st.FailInterruptedProposals(); err != nil {
		log.Printf("hub: interrupted proposals: %v", err)
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
	s.hub.leftOff = s.sum.TouchLeftOff
	s.sum.OnLeftOff = s.hub.briefingChanged
	s.sync.OnSynced = s.onSynced
	s.sync.OnChange = func(id string) {
		s.sum.Touch(id)
		s.hub.suggestProject(id) // the branch ticket of an open session may have arrived by now
	}
	if o.FCMKeyFile != "" {
		gone := func(token string) {
			if err := st.ForgetPushToken(token); err != nil {
				log.Printf("hub: push: forget token: %v", err)
			}
		}
		if p := loadPusher(o.FCMKeyFile, gone, log.Printf); p != nil {
			s.hub.setPusher(p)
		}
	}
	s.hub.startupGrace()
	s.routes()
	return s
}

// Hub exposes the machine connections.
func (s *Server) Hub() *Hub { return s.hub }

// StartSync starts the ticket syncer (does not block); stops when ctx is cancelled.
func (s *Server) StartSync(ctx context.Context) {
	s.sync.Start(ctx)
	s.sum.Start(ctx)
	s.startRetention(ctx)
}

func (s *Server) Handler() http.Handler { return s.viewHandler(s.mux) }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) issue(w http.ResponseWriter, r *http.Request, codeKind, code, tokKind, name string) {
	key := clientKey(r)
	if s.fails.blocked(key) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, wait a minute"})
		return
	}
	tok, err := NewToken()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal error"})
		return
	}
	// Code and token in one transaction: if the token is not saved, the code stays valid.
	name, err = s.st.Pair(codeKind, code, tokKind, name, tok)
	if err != nil {
		if errors.Is(err, store.ErrInvalidCode) {
			s.fails.fail(key)
			writeJSON(w, 400, map[string]string{"error": "invalid or expired code"})
		} else {
			writeJSON(w, 500, map[string]string{"error": "internal error"})
		}
		return
	}
	writeJSON(w, 200, map[string]string{"token": tok, "name": name})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(v); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid request"})
		return false
	}
	return true
}

const maxDeviceName = 64

// deviceName trims whitespace and limits the name to 64 characters ("device" if empty).
func deviceName(n string) string {
	n = strings.TrimSpace(n)
	if utf8.RuneCountInString(n) > maxDeviceName {
		n = strings.TrimSpace(string([]rune(n)[:maxDeviceName]))
	}
	if n == "" {
		n = "device"
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
		writeJSON(w, 400, map[string]string{"error": "missing machine name"})
		return
	}
	s.issue(w, r, "link", b.Code, "machine", b.Machine)
}
