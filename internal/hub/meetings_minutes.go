package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/S-kkipie/quorum/internal/proto"
	meetingworker "github.com/S-kkipie/quorum/worker/meetings"
)

// Meeting minutes: the hub side of the summary rules. The prompts and the repair rules come from the
// worker's prompts.json (meetingworker.Prompts), and this file mirrors worker.py's summarize_local step
// function by function (render_lines, split_sections, section_prompt, merge_prompt, repair_summary,
// naive_merge, parse_json_answer, run_summarize). Both sides check the shared cases in
// worker/meetings/testdata/summary_cases.json, so they cannot drift apart silently.

// minutesPrompts is prompts.json.
type minutesPrompts struct {
	Schema             string            `json:"schema"`
	Rules              string            `json:"rules"`
	SectionSystem      string            `json:"sectionSystem"`
	SectionUser        string            `json:"sectionUser"`
	SectionWhere       string            `json:"sectionWhere"`
	MergeSystem        string            `json:"mergeSystem"`
	MergeUser          string            `json:"mergeUser"`
	MergePart          string            `json:"mergePart"`
	MergePartSeparator string            `json:"mergePartSeparator"`
	Glossary           string            `json:"glossary"`
	CorrectSystem      string            `json:"correctSystem"`
	CorrectUser        string            `json:"correctUser"`
	UnknownLanguage    string            `json:"unknownLanguage"`
	Languages          map[string]string `json:"languages"`
	UnknownOwners      []string          `json:"unknownOwners"`
	GenericSpeaker     string            `json:"genericSpeaker"`
	SectionMinutes     int               `json:"sectionMinutes"`
	TitleMax           int               `json:"titleMax"`

	unknown map[string]bool
	generic *regexp.Regexp
}

var prompts = mustPrompts(meetingworker.Prompts)

func mustPrompts(b []byte) *minutesPrompts {
	var p minutesPrompts
	if err := json.Unmarshal(b, &p); err != nil {
		panic("meetings: prompts.json: " + err.Error())
	}
	p.unknown = map[string]bool{}
	for _, o := range p.UnknownOwners {
		p.unknown[o] = true
	}
	p.generic = regexp.MustCompile(p.GenericSpeaker)
	if p.CorrectSystem == "" || p.CorrectUser == "" {
		panic("meetings: prompts.json: correctSystem and correctUser are required")
	}
	if p.SectionMinutes <= 0 || p.TitleMax <= 0 {
		panic("meetings: prompts.json: sectionMinutes and titleMax must be positive")
	}
	return &p
}

func (p *minutesPrompts) sectionMs() int64 { return int64(p.SectionMinutes) * 60 * 1000 }

var placeholderRe = regexp.MustCompile(`\{(\w+)\}`)

// fill replaces each {name} of values in one pass; an unknown placeholder stays as is (worker.py fill).
func fill(tpl string, values map[string]string) string {
	return placeholderRe.ReplaceAllStringFunc(tpl, func(m string) string {
		if v, ok := values[m[1:len(m)-1]]; ok {
			return v
		}
		return m
	})
}

// chatMsg is one chat message of a prompt (system, then user).
type chatMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// minutesPoint is a decision or an open point; TsMs is nil when the model cited no usable timestamp.
type minutesPoint struct {
	Text string `json:"text"`
	TsMs *int64 `json:"ts_ms,omitempty"`
}

type minutesAction struct {
	Text  string `json:"text"`
	Owner string `json:"owner"`
	Due   string `json:"due"`
	TsMs  *int64 `json:"ts_ms,omitempty"`
}

// minutes is the summary JSON of the plan, in worker.py's field order (the merge prompt shows it as is).
type minutes struct {
	Title      string          `json:"title"`
	Summary    string          `json:"summary"`
	Topics     []string        `json:"topics"`
	Decisions  []minutesPoint  `json:"decisions"`
	OpenPoints []minutesPoint  `json:"openPoints"`
	Actions    []minutesAction `json:"actions"`
	Attendees  []string        `json:"attendees"`
}

func emptyMinutes() minutes {
	return minutes{Topics: []string{}, Decisions: []minutesPoint{}, OpenPoints: []minutesPoint{}, Actions: []minutesAction{}, Attendees: []string{}}
}

// compactJSON is worker.py's compact_json: no spaces, non-ASCII text and <>& as is.
func compactJSON(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "{}"
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func fmtTs(ms int64) string {
	s := ms / 1000
	h, m, sec := s/3600, (s%3600)/60, s%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%02d:%02d", m, sec)
}

// renderLines writes "[mm:ss] Name: text" lines, the speaker labels replaced by the names given.
func renderLines(segs []proto.MeetingSegment, names map[string]string) []string {
	var out []string
	for _, s := range segs {
		who := s.Speaker
		if n, ok := names[who]; ok {
			who = n
		}
		text := strings.TrimSpace(s.Text)
		if text == "" {
			continue
		}
		if who != "" {
			who += ": "
		}
		out = append(out, "["+fmtTs(s.StartMs)+"] "+who+text)
	}
	return out
}

// splitSections groups the segments by start time into sections of sectionMs (empty ones skipped).
func splitSections(segs []proto.MeetingSegment, sectionMs int64) [][]proto.MeetingSegment {
	by := map[int64][]proto.MeetingSegment{}
	var keys []int64
	for _, s := range segs {
		k := s.StartMs / sectionMs
		if _, ok := by[k]; !ok {
			keys = append(keys, k)
		}
		by[k] = append(by[k], s)
	}
	sort.Slice(keys, func(a, b int) bool { return keys[a] < keys[b] })
	out := make([][]proto.MeetingSegment, 0, len(keys))
	for _, k := range keys {
		out = append(out, by[k])
	}
	return out
}

func languageName(code string) string {
	base := strings.ToLower(strings.SplitN(code, "-", 2)[0])
	if n, ok := prompts.Languages[base]; ok {
		return n
	}
	if code != "" {
		return code
	}
	return prompts.UnknownLanguage
}

func glossaryText(g []string) string {
	var keep []string
	for _, x := range g {
		if strings.TrimSpace(x) != "" {
			keep = append(keep, x)
		}
	}
	t := strings.TrimSpace(strings.Join(keep, ", "))
	if t == "" {
		return ""
	}
	return fill(prompts.Glossary, map[string]string{"glossary": t})
}

func rulesFor(language string) string {
	return fill(prompts.Rules, map[string]string{"language": language})
}

// sectionPrompt is worker.py section_prompt; language is the language's name.
func sectionPrompt(lines []string, language string, glossary []string, part, parts int) []chatMsg {
	where := ""
	if parts > 1 {
		where = fill(prompts.SectionWhere, map[string]string{"part": strconv.Itoa(part), "parts": strconv.Itoa(parts)})
	}
	system := fill(prompts.SectionSystem, map[string]string{"schema": prompts.Schema, "rules": rulesFor(language)})
	user := fill(prompts.SectionUser, map[string]string{"where": where, "glossary": glossaryText(glossary), "transcript": strings.Join(lines, "\n")})
	return []chatMsg{{"system", system}, {"user", user}}
}

// mergePrompt is worker.py merge_prompt.
func mergePrompt(parts []minutes, language string, glossary []string) []chatMsg {
	system := fill(prompts.MergeSystem, map[string]string{"schema": prompts.Schema, "rules": rulesFor(language)})
	bodies := make([]string, len(parts))
	for i, p := range parts {
		bodies[i] = fill(prompts.MergePart, map[string]string{"n": strconv.Itoa(i + 1), "json": compactJSON(p)})
	}
	user := fill(prompts.MergeUser, map[string]string{"glossary": glossaryText(glossary), "parts": strings.Join(bodies, prompts.MergePartSeparator)})
	return []chatMsg{{"system", system}, {"user", user}}
}

// oneMessage joins the system and user messages into the single prompt of a hub provider.
func oneMessage(msgs []chatMsg) string {
	parts := make([]string, len(msgs))
	for i, m := range msgs {
		parts[i] = m.Content
	}
	return strings.Join(parts, "\n\n")
}

func normText(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }

// statedWords is worker.py words: lower case, accents removed (NFKD without combining marks), split at
// anything that is not a letter or a digit.
func statedWords(s string) []string {
	var b strings.Builder
	for _, r := range norm.NFKD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			b.WriteRune(r)
		default:
			b.WriteByte(' ')
		}
	}
	return strings.Fields(b.String())
}

func strOf(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func strsOf(v any) []string {
	out := []string{}
	l, _ := v.([]any)
	for _, x := range l {
		s := strOf(x)
		if s == "" {
			continue
		}
		dup := false
		for _, o := range out {
			dup = dup || o == s
		}
		if !dup {
			out = append(out, s)
		}
	}
	return out
}

var tsRe = regexp.MustCompile(`^(?:(\d+):)?(\d{1,2}):(\d{2})$`)
var digitsRe = regexp.MustCompile(`^\d+$`)

// parseTs is worker.py parse_ts: "mm:ss", "hh:mm:ss" (optionally in brackets) or milliseconds.
func parseTs(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		if x >= 0 {
			return int64(x), true
		}
	case string:
		t := strings.Trim(strings.TrimSpace(x), "[]()")
		if digitsRe.MatchString(t) {
			n, err := strconv.ParseInt(t, 10, 64)
			return n, err == nil
		}
		if m := tsRe.FindStringSubmatch(t); m != nil {
			h, _ := strconv.ParseInt("0"+m[1], 10, 64)
			mi, _ := strconv.ParseInt(m[2], 10, 64)
			s, _ := strconv.ParseInt(m[3], 10, 64)
			return ((h*60+mi)*60 + s) * 1000, true
		}
	}
	return 0, false
}

// tsField is x.get("ts_ms", x.get("ts")) checked against maxMs (< 0: no bound).
func tsField(x map[string]any, maxMs int64) *int64 {
	v, ok := x["ts_ms"]
	if !ok {
		v = x["ts"]
	}
	ts, ok := parseTs(v)
	if !ok || (maxMs >= 0 && ts > maxMs) {
		return nil
	}
	return &ts
}

func pointsOf(v any, maxMs int64) []minutesPoint {
	out := []minutesPoint{}
	l, _ := v.([]any)
	for _, x := range l {
		if s, ok := x.(string); ok {
			x = map[string]any{"text": s}
		}
		d, ok := x.(map[string]any)
		if !ok {
			continue
		}
		text := strOf(d["text"])
		if text == "" {
			continue
		}
		out = append(out, minutesPoint{Text: text, TsMs: tsField(d, maxMs)})
	}
	return out
}

// repairMinutes is worker.py repair_summary: missing or mistyped fields become empty, owners and due dates
// that the transcript never mentions are dropped (never invented), generic speaker labels are not
// attendees, and timestamps become ts_ms (maxMs < 0: no bound).
func repairMinutes(raw any, transcript string, maxMs int64) minutes {
	d, ok := raw.(map[string]any)
	if !ok {
		d = map[string]any{}
	}
	hay := " " + strings.Join(statedWords(transcript), " ") + " "
	stated := func(v string) bool {
		w := statedWords(v)
		return len(w) > 0 && strings.Contains(hay, " "+strings.Join(w, " ")+" ")
	}
	m := emptyMinutes()
	acts, _ := d["actions"].([]any)
	for _, a := range acts {
		if s, ok := a.(string); ok {
			a = map[string]any{"text": s}
		}
		x, ok := a.(map[string]any)
		if !ok {
			continue
		}
		text := strOf(x["text"])
		if text == "" {
			continue
		}
		owner := strOf(x["owner"])
		if prompts.unknown[normText(owner)] || !stated(owner) {
			owner = ""
		}
		due := strOf(x["due"])
		if prompts.unknown[normText(due)] || !stated(due) {
			due = ""
		}
		m.Actions = append(m.Actions, minutesAction{Text: text, Owner: owner, Due: due, TsMs: tsField(x, maxMs)})
	}
	for _, n := range strsOf(d["attendees"]) {
		if !prompts.generic.MatchString(n) && stated(n) {
			m.Attendees = append(m.Attendees, n)
		}
	}
	m.Title = trimRunes(strOf(d["title"]), prompts.TitleMax)
	m.Summary = strOf(d["summary"])
	m.Topics = strsOf(d["topics"])
	m.Decisions = pointsOf(d["decisions"], maxMs)
	m.OpenPoints = pointsOf(d["openPoints"], maxMs)
	return m
}

// naiveMerge is worker.py naive_merge: the sections concatenated when the merge answer was unusable.
func naiveMerge(parts []minutes) minutes {
	out := emptyMinutes()
	addStrs := func(dst []string, src []string) []string {
		for _, x := range src {
			dup := false
			for _, o := range dst {
				dup = dup || o == x
			}
			if !dup {
				dst = append(dst, x)
			}
		}
		return dst
	}
	addPoints := func(dst, src []minutesPoint) []minutesPoint {
		seen := map[string]bool{}
		for _, x := range dst {
			seen[normText(x.Text)] = true
		}
		for _, x := range src {
			if !seen[normText(x.Text)] {
				dst = append(dst, x)
			}
		}
		return dst
	}
	for _, p := range parts {
		if out.Title == "" {
			out.Title = p.Title
		}
		out.Summary = strings.TrimSpace(out.Summary + "\n" + p.Summary)
		out.Topics = addStrs(out.Topics, p.Topics)
		out.Attendees = addStrs(out.Attendees, p.Attendees)
		out.Decisions = addPoints(out.Decisions, p.Decisions)
		out.OpenPoints = addPoints(out.OpenPoints, p.OpenPoints)
		seen := map[string]bool{}
		for _, x := range out.Actions {
			seen[normText(x.Text)] = true
		}
		for _, x := range p.Actions {
			if !seen[normText(x.Text)] {
				out.Actions = append(out.Actions, x)
			}
		}
	}
	return out
}

// parseJSONAnswer is worker.py parse_json_answer: the answer as JSON, else its outermost {...}; ok is
// false when neither parses.
func parseJSONAnswer(text string) (v any, ok bool) {
	if json.Unmarshal([]byte(text), &v) == nil {
		return v, v != nil
	}
	i, j := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if i >= 0 && j > i && json.Unmarshal([]byte(text[i:j+1]), &v) == nil {
		return v, v != nil
	}
	return nil, false
}

var (
	errEmptyTranscript = errors.New("The transcript is empty, so there is nothing to summarise.")
	errNotJSON         = errors.New("The summary model did not return valid JSON for the summary.")
)

// chatFunc sends one prompt (system and user messages) and returns the model's answer.
type chatFunc func(ctx context.Context, msgs []chatMsg) (string, error)

// summarizeSegments is worker.py run_summarize: one prompt per 15-minute section, then a merge prompt when
// there is more than one section; every answer is repaired against the transcript. progress gets 0–100.
func summarizeSegments(ctx context.Context, chat chatFunc, segs []proto.MeetingSegment, names map[string]string, language string, glossary []string, progress func(pct int, stage string)) (minutes, error) {
	if progress == nil {
		progress = func(int, string) {}
	}
	clean := map[string]string{}
	for k, v := range names {
		if strings.TrimSpace(v) != "" {
			clean[k] = v
		}
	}
	lang := languageName(language)
	all := renderLines(segs, clean)
	if len(all) == 0 {
		return minutes{}, errEmptyTranscript
	}
	transcript := strings.Join(all, "\n")
	var maxMs int64
	for _, s := range segs {
		e := s.EndMs
		if e == 0 {
			e = s.StartMs
		}
		maxMs = max(maxMs, e)
	}
	sections := splitSections(segs, prompts.sectionMs())
	steps := len(sections)
	if len(sections) > 1 {
		steps++
	}
	parts := make([]minutes, 0, len(sections))
	for i, sec := range sections {
		progress(100*i/steps, "summarizing")
		ans, err := chat(ctx, sectionPrompt(renderLines(sec, clean), lang, glossary, i+1, len(sections)))
		if err != nil {
			return minutes{}, err
		}
		v, ok := parseJSONAnswer(ans)
		if !ok {
			return minutes{}, errNotJSON
		}
		parts = append(parts, repairMinutes(v, transcript, maxMs))
	}
	if len(parts) == 1 {
		progress(100, "summarizing")
		return parts[0], nil
	}
	progress(100*len(sections)/steps, "merging")
	ans, err := chat(ctx, mergePrompt(parts, lang, glossary))
	if err != nil {
		return minutes{}, err
	}
	var final minutes
	if v, ok := parseJSONAnswer(ans); ok {
		if _, isObj := v.(map[string]any); isObj {
			final = repairMinutes(v, transcript, maxMs)
		} else {
			final = naiveMerge(parts)
		}
	} else {
		final = naiveMerge(parts)
	}
	if final.Summary == "" && len(final.Decisions) == 0 && len(final.Actions) == 0 {
		final = naiveMerge(parts)
	}
	progress(100, "summarizing")
	return final, nil
}
