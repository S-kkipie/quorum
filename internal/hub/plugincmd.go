package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"unicode/utf16"

	"github.com/S-kkipie/quorum/internal/proto"
)

// The device may only run these better-claude commands, with bounded single-line
// arguments. Mirrors validatePluginCommand in mod/src/plugincmd.ts (the same shared
// cases run against both).
var pluginCommands = map[string]bool{"after": true, "before": true, "timeline": true}

const pluginArgsMax = 2000

var timelineArgs = regexp.MustCompile(`^(undo|redo|\d{1,4})$`)

func isControlRune(r rune) bool {
	return r <= 0x1f || (r >= 0x7f && r <= 0x9f) || r == 0x2028 || r == 0x2029
}

// validatePluginCommand returns "" when the command may run, else an English error.
func validatePluginCommand(command, args string) string {
	if !pluginCommands[command] {
		short := []rune(command)
		if len(short) > 40 {
			short = short[:40]
		}
		return "Unsupported plugin command: " + string(short)
	}
	// length counted in UTF-16 units, like the mod's String.length
	if len(utf16.Encode([]rune(args))) > pluginArgsMax {
		return fmt.Sprintf("Arguments for /%s exceed %d characters", command, pluginArgsMax)
	}
	for _, r := range args {
		if isControlRune(r) {
			return fmt.Sprintf("Arguments for /%s must be a single line without control characters", command)
		}
	}
	if command == "timeline" && !timelineArgs.MatchString(args) {
		return "/timeline takes undo, redo or a state number"
	}
	return ""
}

// handlePluginState returns the session's state of a better-claude plugin (read by the
// session's daemon from the plugin's store file), or JSON null.
func (s *Server) handlePluginState(w http.ResponseWriter, r *http.Request) {
	plugin := r.PathValue("plugin")
	if plugin != "after" && plugin != "time-machine" {
		apiErr(w, 400, "unknown plugin")
		return
	}
	si, ok := s.target(w, r)
	if !ok {
		return
	}
	if si.ConfigDir == "" {
		writeJSON(w, 200, nil)
		return
	}
	var out json.RawMessage
	p := map[string]string{"configDir": si.ConfigDir, "plugin": plugin, "session": si.ID}
	if err := s.hub.call(r.Context(), si.Machine, "plugin_state", p, &out); err != nil {
		rpcFail(w, err)
		return
	}
	if len(out) == 0 {
		out = json.RawMessage("null")
	}
	writeJSON(w, 200, out)
}

// handlePluginCommand runs an allow-listed plugin command in the session.
func (s *Server) handlePluginCommand(w http.ResponseWriter, r *http.Request) {
	var b struct{ Command, Args string }
	if !decode(w, r, &b) {
		return
	}
	if msg := validatePluginCommand(b.Command, b.Args); msg != "" {
		apiErr(w, 400, msg)
		return
	}
	si, ok := s.target(w, r)
	if !ok || !s.dispatch(w, si, proto.Command{Type: "plugin", Command: b.Command, Args: b.Args}) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
