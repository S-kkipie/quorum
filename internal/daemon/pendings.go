package daemon

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	pendingsMaxBody = 64 << 10
	pendingsTimeout = 10 * time.Second
	pendingsDownMsg = `{"error":"Quorum hub unreachable; the item was not saved"}`
)

// mountPendings registers the local routes that forward pending-item calls to the hub's machine
// routes, adding the machine token. cfgFn returns the current config (so a reload takes effect).
func mountPendings(mux *http.ServeMux, token string, cfgFn func() Config) {
	client := &http.Client{Timeout: pendingsTimeout}
	fwd := func(suffix func(r *http.Request) string) http.HandlerFunc {
		return auth(token, func(w http.ResponseWriter, r *http.Request) {
			forwardPendings(w, r, client, cfgFn, suffix(r))
		})
	}
	base := func(r *http.Request) string {
		return "/api/machine/sessions/" + url.PathEscape(r.PathValue("id")) + "/pendings"
	}
	mux.HandleFunc("GET /v1/sessions/{id}/pendings", fwd(func(r *http.Request) string {
		p := base(r)
		if q := r.URL.RawQuery; q != "" {
			p += "?" + q
		}
		return p
	}))
	mux.HandleFunc("POST /v1/sessions/{id}/pendings", fwd(base))
	mux.HandleFunc("POST /v1/sessions/{id}/pendings/{pid}/done", fwd(func(r *http.Request) string {
		return base(r) + "/" + url.PathEscape(r.PathValue("pid")) + "/done"
	}))
}

func pendingsDown(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	io.WriteString(w, pendingsDownMsg)
}

func forwardPendings(w http.ResponseWriter, r *http.Request, client *http.Client, cfgFn func() Config, pathQuery string) {
	var cfg Config
	if cfgFn != nil {
		cfg = cfgFn()
	}
	hub := strings.TrimRight(cfg.Hub, "/")
	if hub == "" || cfg.MachineToken == "" {
		pendingsDown(w)
		return
	}
	var body io.Reader
	if r.Method == http.MethodPost {
		b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, pendingsMaxBody))
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			io.WriteString(w, `{"error":"request body too large"}`)
			return
		}
		body = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(r.Context(), pendingsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, r.Method, hub+pathQuery, body)
	if err != nil {
		pendingsDown(w)
		return
	}
	req.Header.Set("Authorization", "Bearer "+cfg.MachineToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		pendingsDown(w)
		return
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, pendingsMaxBody))
	if err != nil {
		pendingsDown(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(out)
}
