package hub

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

var taskIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

const taskOutputTimeout = 5 * time.Second

// handleTaskOutput asks the session's machine for a background task's output tail and
// process facts, and passes the daemon's JSON through unchanged.
func (s *Server) handleTaskOutput(w http.ResponseWriter, r *http.Request) {
	sid, task := r.PathValue("sid"), r.PathValue("task")
	if !taskIDRe.MatchString(sid) || !taskIDRe.MatchString(task) {
		apiErr(w, 400, "invalid id")
		return
	}
	si, err := s.st.Session(sid)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "session not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), taskOutputTimeout)
	defer cancel()
	var out json.RawMessage
	if err := s.hub.call(ctx, si.Machine, "task_output", map[string]string{"session": sid, "task": task}, &out); err != nil {
		apiErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

// handleStopTask asks the session's Claude Code to stop one background task or subagent
// (a stop_task command; the mod runs TaskStop). Its end then arrives as a task notification.
func (s *Server) handleStopTask(w http.ResponseWriter, r *http.Request) {
	task := r.PathValue("task")
	if !taskIDRe.MatchString(task) {
		apiErr(w, 400, "invalid id")
		return
	}
	si, ok := s.target(w, r)
	if !ok || !s.dispatch(w, si, proto.Command{Type: "stop_task", TaskID: task}) {
		return
	}
	w.WriteHeader(http.StatusAccepted)
}
