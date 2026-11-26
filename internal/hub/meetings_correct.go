package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// The transcript correction pass (Plan 15b): before a ccapi summary, the summary model proofreads the
// transcript for misheard words, names and domain terms. Corrections must stay surgical: the model
// returns only the segments it changed, and the hub drops every change that is not a small edit of the
// segment. The raw text of each changed segment is kept (orig_text). A failed correction never blocks the
// meeting: the raw transcript goes on to the summary.

const (
	// correctChunk is the number of segments of one correction prompt.
	correctChunk = 120
	// correctMaxEditPct is the largest accepted word edit distance, in percent of the segment's words.
	correctMaxEditPct = 40
	// correctMaxChunkPct is the largest share of a chunk's spoken segments that may change, in percent.
	correctMaxChunkPct = 50
	// correctMinShareSegs is the spoken-segment count below which the share rule is relaxed (a chunk of
	// one segment with one fix is not a rewrite).
	correctMinShareSegs = 10
)

var errCorrectionFailed = errors.New("every correction call failed")

// correctTranscript asks chat for the corrections of segs, in chunks of correctChunk segments, and returns
// the accepted ones keyed by the segment's index in segs. A chunk that fails or answers something
// unparseable is skipped; the error is non-nil only when every chunk failed. progress gets 0–100.
func correctTranscript(ctx context.Context, chat chatFunc, segs []proto.MeetingSegment, project string, glossary []string, names map[string]string, progress func(pct int)) (map[int]string, error) {
	if progress == nil {
		progress = func(int) {}
	}
	fixes := map[int]string{}
	if len(segs) == 0 {
		return fixes, nil
	}
	speakers := correctSpeakers(segs, names)
	chunks := (len(segs) + correctChunk - 1) / correctChunk
	failed := 0
	var lastErr error
	for c := 0; c < chunks; c++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		progress(100 * c / chunks)
		lo, hi := c*correctChunk, min((c+1)*correctChunk, len(segs))
		ans, err := chat(ctx, correctPrompt(segs, lo, hi, project, glossary, speakers, names))
		if err != nil {
			failed++
			lastErr = err
			continue
		}
		items, ok := parseCorrections(ans)
		if !ok {
			failed++
			lastErr = errors.New("the correction answer is not a JSON array")
			continue
		}
		chunk := map[int]string{}
		changed := 0
		for _, it := range items {
			if it.i < lo || it.i >= hi {
				continue // not a segment of this chunk
			}
			if _, dup := chunk[it.i]; dup {
				continue // the first answer for a segment wins
			}
			if t, ok := acceptCorrection(segs[it.i].Text, it.text); ok {
				chunk[it.i] = t
				if wordEditDistance(segs[it.i].Text, t) > 0 {
					changed++ // punctuation and case fixes do not count as rewriting
				}
			}
		}
		// a proofread changes a few segments: a chunk that changed most of them was rewritten
		spoken := 0
		for i := lo; i < hi; i++ {
			if oneLine(segs[i].Text) != "" {
				spoken++
			}
		}
		// (a chunk of fewer than correctMinShareSegs spoken segments is judged as if it had that many)
		if changed*100 > correctMaxChunkPct*max(spoken, correctMinShareSegs) {
			log.Printf("hub: meetings: correction: %d of %d segments changed in segments %d–%d, the chunk's fixes are dropped", changed, spoken, lo, hi-1)
			continue
		}
		for i, t := range chunk {
			fixes[i] = t
		}
	}
	progress(100)
	if failed == chunks {
		return nil, fmt.Errorf("%w: %v", errCorrectionFailed, lastErr)
	}
	return fixes, nil
}

// correctPrompt is the correction prompt of segs[lo:hi], each segment one "index<TAB>speaker<TAB>text"
// line (the global index; empty segments left out).
func correctPrompt(segs []proto.MeetingSegment, lo, hi int, project string, glossary []string, speakers string, names map[string]string) []chatMsg {
	var lines []string
	for i := lo; i < hi; i++ {
		text := oneLine(segs[i].Text)
		if text == "" {
			continue
		}
		lines = append(lines, strconv.Itoa(i)+"\t"+oneLine(speakerName(segs[i].Speaker, names))+"\t"+text)
	}
	g := strings.TrimSpace(strings.Join(nonEmpty(glossary), ", "))
	if g == "" {
		g = "(none)"
	}
	if project = strings.TrimSpace(project); project == "" {
		project = "(none)"
	}
	user := fill(prompts.CorrectUser, map[string]string{
		"project": project, "glossary": g, "speakers": speakers, "segments": strings.Join(lines, "\n"),
	})
	return []chatMsg{{"system", prompts.CorrectSystem}, {"user", user}}
}

func speakerName(label string, names map[string]string) string {
	if n := strings.TrimSpace(names[label]); n != "" {
		return n
	}
	return label
}

// correctSpeakers lists the meeting's speakers (named when the owner named them), in order of appearance.
func correctSpeakers(segs []proto.MeetingSegment, names map[string]string) string {
	var out []string
	seen := map[string]bool{}
	for _, sg := range segs {
		n := oneLine(speakerName(sg.Speaker, names))
		if n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	if len(out) == 0 {
		return "(unknown)"
	}
	return strings.Join(out, ", ")
}

func nonEmpty(xs []string) []string {
	var out []string
	for _, x := range xs {
		if x = oneLine(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

// oneLine collapses the text's whitespace (tabs and newlines included) to single spaces.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

type correction struct {
	i    int
	text string
}

// parseCorrections reads the model's [{i, text}] answer, tolerating a code fence and text around the
// array. An item that is not an {i, text} object is skipped; ok is false when there is no array at all.
func parseCorrections(ans string) ([]correction, bool) {
	t := strings.TrimSpace(ans)
	if strings.HasPrefix(t, "```") {
		t = strings.TrimPrefix(t, "```")
		if nl := strings.IndexByte(t, '\n'); nl >= 0 {
			t = t[nl+1:] // the fence's language tag
		}
		t = strings.TrimSuffix(strings.TrimSpace(t), "```")
	}
	var raw []json.RawMessage
	if err := json.Unmarshal([]byte(t), &raw); err != nil {
		i, j := strings.Index(t, "["), strings.LastIndex(t, "]")
		if i < 0 || j <= i || json.Unmarshal([]byte(t[i:j+1]), &raw) != nil {
			return nil, false
		}
	}
	var out []correction
	for _, r := range raw {
		var it struct {
			I    *json.Number `json:"i"`
			Text *string      `json:"text"`
		}
		if json.Unmarshal(r, &it) != nil || it.I == nil || it.Text == nil {
			continue
		}
		n, err := it.I.Int64()
		if err != nil || n < 0 || n > int64(^uint32(0)>>1) {
			continue
		}
		out = append(out, correction{i: int(n), text: *it.Text})
	}
	return out, true
}

// acceptCorrection is the guard against rewrites: the corrected text is kept only when it is not empty,
// differs from the original, is not much longer than it, and is a small edit of it: a word edit distance of at most 1 (one misheard
// word or name, even in a short segment), or else of at most correctMaxEditPct of the original's words.
func acceptCorrection(orig, fixed string) (string, bool) {
	fixed = oneLine(fixed)
	orig = oneLine(orig)
	if fixed == "" || orig == "" || fixed == orig {
		return "", false
	}
	if len([]rune(fixed)) > maxSegText || len([]rune(fixed)) > 2*len([]rune(orig))+20 {
		return "", false // far longer than the segment: a rewrite or an insertion
	}
	d := wordEditDistance(orig, fixed)
	if d <= 1 {
		return fixed, true
	}
	if d*100 > correctMaxEditPct*len(wordTokens(orig)) {
		return "", false
	}
	return fixed, true
}

// wordTokens is the text's lowercased words with their punctuation stripped (a token of only punctuation
// is dropped).
func wordTokens(s string) []string {
	var out []string
	for _, w := range strings.Fields(strings.ToLower(s)) {
		w = strings.Map(func(r rune) rune {
			if unicode.IsPunct(r) {
				return -1
			}
			return r
		}, w)
		if w != "" {
			out = append(out, w)
		}
	}
	return out
}

// wordEditDistance is the Levenshtein distance between a and b over wordTokens.
func wordEditDistance(a, b string) int {
	x, y := wordTokens(a), wordTokens(b)
	prev := make([]int, len(y)+1)
	cur := make([]int, len(y)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(x); i++ {
		cur[0] = i
		for j := 1; j <= len(y); j++ {
			cost := 1
			if x[i-1] == y[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(y)]
}

// correctMeeting runs the correction pass of a hub summary run and returns the transcript to summarise:
// the corrected one, or segs as they were when the pass failed. Nothing is stored for a stale run.
func (s *Server) correctMeeting(ctx context.Context, id string, gen int, m proto.Meeting, segs []proto.MeetingSegment, names map[string]string, chat chatFunc, progress func(pct int, stage string)) []proto.MeetingSegment {
	project := ""
	if m.ProjectID != "" {
		if p, err := s.st.GetProject(m.ProjectID); err == nil {
			project = p.Name
		}
	}
	fixes, err := correctTranscript(ctx, chat, segs, project, s.glossary(m, names), names,
		func(pct int) { progress(pct, "correcting") })
	if !s.currentSummaryRun(id, gen) {
		return segs
	}
	if err != nil {
		log.Printf("hub: meetings: correction of %s: %v (the raw transcript is summarised)", id, err)
		return segs
	}
	// the fixes belong to the transcript they were made for: every segment is checked against the text the
	// correction saw, in the same transaction, so a transcript replaced since is left alone (and stays
	// uncorrected, so its own summary corrects it)
	all := make([]store.SegmentFix, len(segs))
	for i, sg := range segs {
		all[i] = store.SegmentFix{Idx: i, Expect: sg.Text, Text: sg.Text}
		if t, ok := fixes[i]; ok {
			all[i].Text = t
		}
	}
	applied, err := s.st.ApplySegmentCorrections(id, all, time.Now().UnixMilli())
	if err != nil || !applied {
		if err != nil {
			log.Printf("hub: meetings: store the correction of %s: %v", id, err)
		} else {
			log.Printf("hub: meetings: correction of %s: the transcript changed meanwhile, nothing applied", id)
		}
		if cur, err := s.st.MeetingSegments(id); err == nil {
			return cur
		}
		return segs
	}
	if len(fixes) > 0 {
		log.Printf("hub: meetings: corrected %d of %d segments of %s", len(fixes), len(segs), id)
	}
	out, err := s.st.MeetingSegments(id)
	if err != nil {
		return segs
	}
	return out
}
