package hub

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	terminalOnlyError = "This command only works in the terminal."
	maxSessionCmds    = 2000
)

// terminalWhenBare: /after and /timeline open a pane when run without arguments (mirrors the
// mod's TERMINAL_WHEN_BARE in mod/src/plugincmd.ts). Also applies to the Plan 6 plugin route.
var terminalWhenBare = map[string]bool{"after": true, "timeline": true}

// validateCommand returns "" when a device may run /command args in a session whose reported
// list is list (nil: never reported), else an English error. Mirrors validateCommand in
// mod/src/commands.ts.
func validateCommand(list []proto.SessionCommand, reported bool, command, args string) string {
	if !reported {
		return "The command list of this session is not available yet"
	}
	for _, c := range list {
		if c.Name != command {
			continue
		}
		if c.TerminalOnly || (terminalWhenBare[command] && strings.TrimSpace(args) == "") {
			return terminalOnlyError
		}
		return validateArgs(command, args)
	}
	return "Unknown command: /" + clip(command, 60)
}

// saveSessionCommands handles the daemon's session_commands: owned sessions only; the list is
// stored and published to the apps only when its hash changed.
func (h *Hub) saveSessionCommands(name string, env proto.Envelope) {
	var sc proto.SessionCommands
	if json.Unmarshal(env.Payload, &sc) != nil || sc.Session == "" || len(sc.Commands) > maxSessionCmds {
		return
	}
	if ok, err := h.sessionOwnedBy(name, sc.Session); err != nil || !ok {
		return // only the owner of a known session reports its commands
	}
	changed, err := h.st.SaveCommands(sc.Session, sc.Hash, sc.Commands)
	if err != nil {
		log.Printf("hub: commands of %s: %v", sc.Session, err)
		return
	}
	if !changed {
		return
	}
	if sc.Commands == nil {
		sc.Commands = []proto.SessionCommand{}
	}
	p, _ := json.Marshal(sc)
	h.publish(proto.Envelope{Type: "session_commands", Machine: name, Session: sc.Session, Payload: p})
}

// handleCommands returns the session's reported command list ({session, commands, hash}); an
// empty list with an empty hash when the mod never reported one (older mod).
func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.st.Session(id); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "session not found")
		return
	} else if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	sc, ok, err := s.st.Commands(id)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if !ok {
		sc = proto.SessionCommands{Session: id, Commands: []proto.SessionCommand{}}
	}
	writeJSON(w, 200, sc)
}

// handleRunCommand runs a slash command from the session's reported list (not terminal-only).
func (s *Server) handleRunCommand(w http.ResponseWriter, r *http.Request) {
	var b struct{ Command, Args string }
	if !decode(w, r, &b) {
		return
	}
	si, ok := s.target(w, r)
	if !ok {
		return
	}
	sc, reported, err := s.st.Commands(si.ID)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if msg := validateCommand(sc.Commands, reported, b.Command, b.Args); msg != "" {
		apiErr(w, 400, msg)
		return
	}
	if s.dispatch(w, si, proto.Command{Type: "command", Command: b.Command, Args: b.Args}) {
		w.WriteHeader(http.StatusAccepted)
	}
}

// handleSetModel switches the session's model to one of its reported options.
func (s *Server) handleSetModel(w http.ResponseWriter, r *http.Request) {
	var b struct{ Value string }
	if !decode(w, r, &b) {
		return
	}
	si, ok := s.target(w, r)
	if !ok {
		return
	}
	found := false
	for _, o := range si.ModelOptions {
		found = found || o.Value == b.Value
	}
	if !found {
		apiErr(w, 400, "Unknown model: "+clip(b.Value, 60))
		return
	}
	if s.dispatch(w, si, proto.Command{Type: "set_model", Value: b.Value}) {
		w.WriteHeader(http.StatusAccepted)
	}
}
