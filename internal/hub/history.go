package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

var cursorRe = regexp.MustCompile(`^(s?\d{1,19})?$`)

const (
	historyPageLimit = 100
	maxDeltaEvents   = 500
	// retentionDays: a session closed this long ago loses its hub events. Longer than Claude
	// Code's own transcript cleanup (cleanupPeriodDays, 30 by default), so the hub's copy never
	// goes at the same time as the machine's.
	retentionDays = 90
)

// handleHistory serves one page of a session's history from its machine's transcript. The page
// is filtered to events older than the oldest event the hub still stores (the daemon skips them
// too, with beforeTs; the filter stays for older daemons), and events that duplicate a hub event
// at the seam (same kind and content within seamNearMS, the two clocks may differ) are dropped, so
// the app never gets duplicates at the seam (live events carry no transcript key). A page served
// marks the session's history as reachable (history_ok).
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	cursor := r.URL.Query().Get("cursor")
	if !cursorRe.MatchString(cursor) {
		apiErr(w, 400, "invalid cursor")
		return
	}
	si, err := s.st.Session(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "session not found")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	offline := "Older history is on " + si.Machine + ", which is offline."
	if !s.hub.Connected(si.Machine) {
		apiErr(w, 409, offline)
		return
	}
	beforeTS, hasBefore, err := s.st.OldestEventTS(si.ID)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	var page proto.TranscriptPage
	p := proto.TranscriptPageParams{Session: si.ID, Cursor: cursor, Limit: historyPageLimit}
	if hasBefore && beforeTS > 0 {
		p.BeforeTS = beforeTS
	}
	if err := s.hub.call(r.Context(), si.Machine, "transcript_page", p, &page); err != nil {
		var de daemonError
		switch {
		case errors.Is(err, errOffline):
			apiErr(w, 409, offline)
		case errors.Is(err, errTimeout):
			apiErr(w, 504, "Older history is on "+si.Machine+", which did not respond.")
		case errors.As(err, &de) && (string(de) == "unknown session" || string(de) == "the session has no readable transcript"):
			apiErr(w, 404, "No older history on the machine.")
		case errors.As(err, &de) && string(de) == "invalid cursor":
			apiErr(w, 400, "invalid cursor")
		case errors.As(err, &de) && string(de) == "unknown method":
			apiErr(w, 404, "Update quorumd on "+si.Machine+" to load older history.")
		case errors.As(err, &de):
			apiErr(w, 502, string(de))
		default:
			apiErr(w, 502, "error talking to the machine")
		}
		return
	}
	if err := s.st.SetHistoryOK(si.ID); err != nil {
		log.Printf("hub: history: %v", err)
	}
	var seam []proto.Event
	if hasBefore {
		if seam, err = s.st.OldestEvents(si.ID, seamEvents); err != nil {
			apiErr(w, 500, "internal error")
			return
		}
	}
	evs := make([]proto.Event, 0, len(page.Events))
	for _, e := range page.Events {
		if hasBefore && e.TS >= beforeTS {
			continue
		}
		if dupAtSeam(e, seam) {
			continue
		}
		evs = append(evs, e)
	}
	writeJSON(w, 200, proto.TranscriptPage{Events: evs, Cursor: page.Cursor, Done: page.Done})
}

const (
	// seamNearMS: a history event this close to a hub event with the same signature is the same event.
	seamNearMS = 5000
	// seamEvents: how many of the hub's oldest events are compared with a history page.
	seamEvents = 200
)

// dupAtSeam reports whether history event e repeats one of the hub's oldest events.
func dupAtSeam(e proto.Event, hub []proto.Event) bool {
	var sig string
	for i := range hub {
		h := &hub[i]
		if h.Kind != e.Kind || h.TS-e.TS > seamNearMS || e.TS-h.TS > seamNearMS {
			continue
		}
		if sig == "" {
			if sig = eventSig(e); sig == "" {
				return false // nothing to compare: not a duplicate
			}
		}
		if eventSig(*h) == sig {
			return true
		}
	}
	return false
}

// eventSig is what identifies an event's content across the live feed and the transcript: its
// kind plus its text, tool name and summary, or task id (each clipped, the two sides clip
// differently). A compact is identified by its kind alone; an event with none of them has no
// signature ("").
func eventSig(e proto.Event) string {
	var d struct {
		Text    string `json:"text"`
		Name    string `json:"name"`
		Summary string `json:"summary"`
		TaskID  string `json:"taskId"`
	}
	if e.Kind != proto.KindCompact {
		_ = json.Unmarshal(e.Data, &d)
		if strings.TrimSpace(d.Text) == "" && d.Name == "" && d.Summary == "" && d.TaskID == "" {
			return ""
		}
	}
	return string(e.Kind) + "\x00" + clipSig(d.Text) + "\x00" + d.Name + "\x00" + clipSig(d.Summary) + "\x00" + d.TaskID
}

func clipSig(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 200 {
		return string(r[:200])
	}
	return s
}

// startRetention deletes the events of long-closed sessions (see PruneClosedEvents) once a minute after startup and then daily.
func (s *Server) startRetention(ctx context.Context) {
	go runRetention(ctx, s.st, time.Now, time.After)
}

// runRetention is the retention loop with an injectable clock and timer (tests).
func runRetention(ctx context.Context, st *store.Store, now func() time.Time, after func(time.Duration) <-chan time.Time) {
	wait := time.Minute
	for {
		select {
		case <-ctx.Done():
			return
		case <-after(wait):
		}
		cutoff := now().AddDate(0, 0, -retentionDays)
		if n, err := st.PruneClosedEvents(cutoff); err != nil {
			log.Printf("hub: retention: %v", err)
		} else if n > 0 {
			log.Printf("hub: retention: removed %d events of sessions closed before %s", n, cutoff.Format("2006-01-02"))
		}
		wait = 24 * time.Hour
	}
}
