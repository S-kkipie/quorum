package daemon

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

const maxBody = 4 << 20

// NewLocalAPI builds the loopback HTTP handler used by the mod.
func NewLocalAPI(reg *Registry, token, version string) http.Handler {
	return NewLocalAPIWithReload(reg, token, version, nil)
}

// NewLocalAPIWithReload adds POST /v1/reload, which rereads the config and restarts the hub link.
func NewLocalAPIWithReload(reg *Registry, token, version string, reload func() error) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/reload", auth(token, func(w http.ResponseWriter, r *http.Request) {
		if reload == nil {
			http.Error(w, "reload no disponible", http.StatusNotImplemented)
			return
		}
		if err := reload(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": version, "machine": reg.machine})
	})
	mux.HandleFunc("POST /v1/sessions/register", auth(token, func(w http.ResponseWriter, r *http.Request) {
		var si proto.SessionInfo
		if !decode(w, r, &si) {
			return
		}
		if si.ID == "" {
			http.Error(w, "id required", http.StatusBadRequest)
			return
		}
		reg.Upsert(si)
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /v1/sessions/{id}/events", auth(token, func(w http.ResponseWriter, r *http.Request) {
		var evs []proto.Event
		if !decode(w, r, &evs) {
			return
		}
		id := r.PathValue("id")
		reg.EmitBatch(id, evs)
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /v1/sessions/{id}/gone", auth(token, func(w http.ResponseWriter, r *http.Request) {
		reg.Gone(r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /v1/sessions/{id}/attach", auth(token, attachHandler(reg)))
	return mux
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		code := http.StatusBadRequest
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			code = http.StatusRequestEntityTooLarge
		}
		http.Error(w, "bad body", code)
		return false
	}
	return true
}

func auth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}
