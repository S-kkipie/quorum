package summary

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// "Where you left off": a second cached text per project, beside the summary, written through the same model
// (ccapi / Haiku) and guards: generated only when touched (a session turn end or close, a change of the owner's
// tickets), after a quiet period, at most once per 10 minutes per project, and never when its input did not change.
const (
	leftGap        = 10 * time.Minute
	leftQuiet      = 30 * time.Second // debounce: a burst of triggers generates once, after it settles
	leftSessions   = 3
	leftExcerpt    = 600
	leftRecap      = 200
	leftMaxTickets = 15
	maxLeftOff     = 600
	leftSentences  = 3
)

// TouchLeftOff marks the project's "where you left off" text as stale; the loop regenerates it when due.
func (s *Summarizer) TouchLeftOff(projectID string) {
	if projectID == "" {
		return
	}
	s.mu.Lock()
	s.ldirty[projectID] = s.now()
	s.mu.Unlock()
}

// LeftOffPending says whether a regeneration of the project's "where you left off" is waiting.
func (s *Summarizer) LeftOffPending(projectID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.ldirty[projectID]
	return ok
}

// seedLeftOff marks the projects that never had a "where you left off" text (one first generation each; a
// project without sessions costs nothing).
func (s *Summarizer) seedLeftOff(ps []proto.Project) {
	for _, p := range ps {
		if _, _, at, err := s.st.WhereLeftOff(p.ID); err == nil && at == 0 {
			s.TouchLeftOff(p.ID)
		}
	}
}

func (s *Summarizer) runLeftOff(ctx context.Context) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.ldirty))
	for id := range s.ldirty {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		s.processLeftOff(ctx, id)
	}
}

func (s *Summarizer) processLeftOff(ctx context.Context, id string) {
	s.gen.Lock()
	defer s.gen.Unlock()
	p, err := s.st.GetProject(id)
	if errors.Is(err, store.ErrNotFound) {
		s.Forget(id)
		return
	}
	if err != nil {
		log.Printf("summary: where you left off %s: %v", id, err)
		return
	}
	text, _, at, err := s.st.WhereLeftOff(id)
	if err != nil {
		log.Printf("summary: where you left off %s: %v", id, err)
		return
	}
	now := s.now()
	s.mu.Lock()
	touched, ok := s.ldirty[id]
	switch {
	case !ok:
	case now.Sub(touched) < leftQuiet:
		ok = false
	case at != 0 && now.Sub(time.UnixMilli(at)) < leftGap:
		ok = false
	case now.Before(s.lretry[id]):
		ok = false
	default:
		delete(s.ldirty, id) // a trigger during generation marks it again
	}
	s.mu.Unlock()
	if !ok {
		return
	}

	sessions, tickets, err := s.leftOffInputs(p)
	if err != nil {
		s.leftOffFailed(id, touched, now, err)
		return
	}
	if len(sessions) == 0 {
		if text != "" || at != 0 {
			if err := s.st.SetWhereLeftOff(id, "", 0, 0); err != nil {
				log.Printf("summary: where you left off %s: %v", id, err)
				return
			}
			if text != "" {
				s.leftOffChanged(id)
			}
		}
		return
	}
	sum := sha256.Sum256([]byte(buildLeftOffPrompt(p, sessions, tickets, false)))
	h := hex.EncodeToString(sum[:])
	s.mu.Lock()
	same := s.lhash[id] == h
	s.mu.Unlock()
	if same && text != "" {
		return // the input did not change: no model call
	}
	out, err := s.model.Complete(ctx, buildLeftOffPrompt(p, sessions, tickets, true))
	if err == nil {
		if out = CleanLeftOff(out); out == "" {
			err = fmt.Errorf("the model returned an empty text")
		}
	}
	if err != nil {
		s.leftOffFailed(id, touched, now, err)
		return
	}
	if err := s.st.SetWhereLeftOff(id, out, len(sessions), now.UnixMilli()); err != nil {
		log.Printf("summary: save where you left off %s: %v", id, err)
		return
	}
	s.mu.Lock()
	s.lhash[id] = h
	delete(s.lretry, id)
	s.mu.Unlock()
	s.leftOffChanged(id)
}

func (s *Summarizer) leftOffFailed(id string, touched, now time.Time, err error) {
	log.Printf("summary: where you left off %s: %v", id, err)
	s.mu.Lock()
	if _, ok := s.ldirty[id]; !ok {
		s.ldirty[id] = touched
	}
	s.lretry[id] = now.Add(retryGap)
	s.mu.Unlock()
}

func (s *Summarizer) leftOffChanged(id string) {
	if s.OnLeftOff != nil {
		s.OnLeftOff(id)
	}
}

type leftSession struct {
	si       proto.SessionInfo
	answer   string
	activity int64
}

// leftOffInputs returns the project's 3 sessions with the latest activity (live ones included, service ones never)
// and the owner's open tickets.
func (s *Summarizer) leftOffInputs(p proto.Project) ([]leftSession, []proto.Ticket, error) {
	all, err := s.st.ListSessions(true)
	if err != nil {
		return nil, nil, err
	}
	ends, err := s.st.ProjectSessionEnds(p.ID)
	if err != nil {
		return nil, nil, err
	}
	var ss []leftSession
	for _, si := range all {
		if si.ProjectID != p.ID || si.Role == proto.RoleService {
			continue
		}
		e := ends[si.ID]
		ss = append(ss, leftSession{si: si, answer: e.Answer, activity: max(si.UpdatedAt, e.EndAt, e.ClosedAt)})
	}
	sort.SliceStable(ss, func(i, j int) bool {
		if ss[i].activity != ss[j].activity {
			return ss[i].activity > ss[j].activity
		}
		return ss[i].si.ID < ss[j].si.ID
	})
	if len(ss) > leftSessions {
		ss = ss[:leftSessions]
	}
	ts, err := s.st.ListTickets(p.ID)
	if err != nil {
		return nil, nil, err
	}
	person := store.ProjectPerson(p)
	var mine []proto.Ticket
	for _, t := range ts {
		if store.OpenTicket(t) && store.IsPerson(t.Assignee, person) {
			mine = append(mine, t)
		}
	}
	return ss, mine, nil
}

func buildLeftOffPrompt(p proto.Project, ss []leftSession, mine []proto.Ticket, withState bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Project: %s\n", p.Name)
	b.WriteString("\nThe owner's open tickets:\n")
	if len(mine) == 0 {
		b.WriteString("(none)\n")
	}
	for i, t := range mine {
		if i == leftMaxTickets {
			b.WriteString("- ...\n")
			break
		}
		fmt.Fprintf(&b, "- %s (%s)\n", cut(oneLine(t.Title), 120), t.Status)
	}
	b.WriteString("\nThe owner's most recent sessions on it, newest first:\n")
	for i, x := range ss {
		var e strings.Builder
		if r := oneLine(x.si.Recap); r != "" {
			fmt.Fprintf(&e, "Working on: %s. ", cut(r, leftRecap))
		}
		if a := oneLine(x.answer); a != "" {
			fmt.Fprintf(&e, "Last answer: %s", a)
		}
		ex := strings.TrimSpace(cut(e.String(), leftExcerpt))
		if ex == "" {
			ex = "(no text yet)"
		}
		if withState {
			fmt.Fprintf(&b, "%d. [%s] %s\n", i+1, x.si.State, ex)
		} else {
			fmt.Fprintf(&b, "%d. %s\n", i+1, ex)
		}
	}
	b.WriteString("\nIn at most 3 short sentences (max. 450 characters), tell the owner where they left off on this project " +
		"and what comes next, so they can pick it up in 30 seconds. Write in the same language as the session text above. " +
		"Use only facts from the text above. Reply with the text only, no quotes, list or preamble.")
	return strings.ReplaceAll(b.String(), "\x00", "")
}

// CleanLeftOff leaves the text on one line, without wrapping quotes, at most 3 sentences and 600 characters.
func CleanLeftOff(s string) string {
	s = strings.Trim(oneLine(s), "\"'“”«» ")
	r := []rune(s)
	n := 0
	for i, c := range r {
		if (c == '.' || c == '!' || c == '?') && (i+1 == len(r) || r[i+1] == ' ') {
			if n++; n == leftSentences {
				r = r[:i+1]
				break
			}
		}
	}
	return strings.TrimSpace(cut(string(r), maxLeftOff))
}
