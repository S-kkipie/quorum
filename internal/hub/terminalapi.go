package hub

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/S-kkipie/quorum/internal/proto"
)

// allowedKeys: keys the app may send (herdr names).
var allowedKeys = map[string]bool{"esc": true, "tab": true, "enter": true, "ctrl+c": true, "ctrl+d": true,
	"ctrl+l": true, "up": true, "down": true, "left": true, "right": true}

// rpcFail translates a call error into the HTTP response.
func rpcFail(w http.ResponseWriter, err error) {
	var de daemonError
	switch {
	case errors.Is(err, errOffline):
		apiErr(w, 409, errOffline.Error())
	case errors.As(err, &de):
		apiErr(w, 409, string(de))
	case errors.Is(err, errTimeout):
		apiErr(w, 504, errTimeout.Error())
	default:
		apiErr(w, 502, "error talking to the machine")
	}
}

func (s *Server) handleConversations(w http.ResponseWriter, r *http.Request) {
	var out []proto.Conversation
	err := s.hub.call(r.Context(), r.PathValue("m"), "conversations", map[string]string{"root": r.URL.Query().Get("root")}, &out)
	if err != nil {
		rpcFail(w, err)
		return
	}
	if out == nil {
		out = []proto.Conversation{}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleTermOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Root  string `json:"root"`
		Label string `json:"label"`
		New   bool   `json:"new"`
	}
	if !decode(w, r, &req) {
		return
	}
	m := r.PathValue("m")
	var out struct {
		Pane string `json:"pane"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	if err := s.hub.call(r.Context(), m, "term_open", req, &out); err != nil {
		rpcFail(w, err)
		return
	}
	if err := s.st.AuditTerminal(AuthName(r.Context()), m, out.Pane, "open"); err != nil {
		log.Printf("hub: could not audit the terminal of %s: %v", m, err)
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleTermWatch(w http.ResponseWriter, r *http.Request) {
	if err := s.hub.call(r.Context(), r.PathValue("m"), "term_watch", map[string]string{"pane": r.PathValue("pane")}, nil); err != nil {
		rpcFail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) handleTermInput(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text string   `json:"text"`
		Keys []string `json:"keys"`
	}
	if !decode(w, r, &req) {
		return
	}
	for _, k := range req.Keys {
		if !allowedKeys[k] {
			apiErr(w, 400, "key not allowed: "+k)
			return
		}
	}
	if req.Keys == nil {
		req.Keys = []string{}
	}
	p := map[string]any{"pane": r.PathValue("pane"), "text": req.Text, "keys": req.Keys}
	if err := s.hub.call(r.Context(), r.PathValue("m"), "term_input", p, nil); err != nil {
		rpcFail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) handleTermRead(w http.ResponseWriter, r *http.Request) {
	lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	if lines <= 0 || lines > 2000 {
		lines = 200
	}
	var out struct {
		ANSI string `json:"ansi"`
	}
	p := map[string]any{"pane": r.PathValue("pane"), "lines": lines}
	if err := s.hub.call(r.Context(), r.PathValue("m"), "term_read", p, &out); err != nil {
		rpcFail(w, err)
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleTermClose(w http.ResponseWriter, r *http.Request) {
	m, pane := r.PathValue("m"), r.PathValue("pane")
	if err := s.hub.call(r.Context(), m, "term_close", map[string]string{"pane": pane}, nil); err != nil {
		rpcFail(w, err)
		return
	}
	if err := s.st.AuditTerminal(AuthName(r.Context()), m, pane, "close"); err != nil {
		log.Printf("hub: could not audit the terminal of %s: %v", m, err)
	}
	w.WriteHeader(204)
}
