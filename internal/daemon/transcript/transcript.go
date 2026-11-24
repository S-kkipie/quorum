// Package transcript rebuilds a session's history from the JSONL
// that Claude Code stores on disk. The format is internal: whatever is not understood is skipped.
package transcript

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	maxLine = 16 << 20
	// MaxText bounds the text of each event so the result fits in a WS message.
	MaxText = 16 << 10
)

type block struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

type line struct {
	Type        string `json:"type"`
	Subtype     string `json:"subtype"`
	UUID        string `json:"uuid"`
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	// IsCompactSummary marks the user row Claude Code writes right after a compact boundary: the
	// summary the model is sent in place of the earlier conversation. Nobody typed it.
	IsCompactSummary bool `json:"isCompactSummary"`
	// CompactMetadata rides on a compact boundary row (type "system", subtype "compact_boundary").
	CompactMetadata *struct {
		Trigger   string `json:"trigger"`
		PreTokens *int64 `json:"preTokens"`
	} `json:"compactMetadata"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// Parse reads r forwards and returns at most the last limit events (0 = all). r must start at
// byte 0 of the transcript: event keys use line offsets. ReadPage is the bounded way to read a file.
func Parse(r io.Reader, limit int) ([]proto.Event, error) {
	var out []proto.Event
	br := bufio.NewReaderSize(r, 64<<10)
	var off int64
	for {
		raw, n, err := readLine(br)
		start := off
		off += int64(n)
		if len(raw) > 0 {
			out = append(out, parseLine(raw, start)...)
			if limit > 0 && len(out) > 2*limit {
				out = append([]proto.Event(nil), out[len(out)-limit:]...)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

// readLine reads a whole line; discards (returns empty) those that exceed maxLine.
// n is the number of bytes consumed, newline included.
func readLine(br *bufio.Reader) (buf []byte, n int, err error) {
	tooBig := false
	for {
		chunk, err := br.ReadSlice('\n')
		n += len(chunk)
		if !tooBig {
			buf = append(buf, chunk...)
			if len(buf) > maxLine {
				tooBig = true
				buf = nil
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if tooBig {
			return nil, n, err
		}
		return buf, n, err
	}
}

// clip cuts s to MaxText bytes at a rune boundary and adds "…".
func clip(s string) string {
	if len(s) <= MaxText {
		return s
	}
	cut := MaxText
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// SkipUserText reports whether it is text Claude Code stores as "user" but a person did not write.
func SkipUserText(s string) bool {
	return strings.HasPrefix(s, "<command-") || strings.HasPrefix(s, "<local-command-") ||
		strings.HasPrefix(s, "[Request interrupted by user") || IsTaskNotification(s)
}

// parseLine maps one transcript line (that starts at byte offset of the file) to events; each
// event's Key is "<line key>/<index among the line's events>".
func parseLine(raw []byte, offset int64) []proto.Event {
	evs, uuid := mapLine(raw)
	if len(evs) > 0 {
		// the line's identity: its uuid, or "@<byte offset>" without one
		k := uuid
		if k == "" {
			k = "@" + strconv.FormatInt(offset, 10)
		}
		for i := range evs {
			evs[i].Key = k + "/" + strconv.Itoa(i)
		}
	}
	return evs
}

// mapLine returns the line's events (without keys) and its uuid.
func mapLine(raw []byte) ([]proto.Event, string) {
	var l line
	if len(raw) == 0 || json.Unmarshal(raw, &l) != nil || l.IsSidechain {
		return nil, ""
	}
	evs := mapParsed(&l)
	return evs, l.UUID
}

func mapParsed(l *line) []proto.Event {
	var ts int64
	if t, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
		ts = t.UnixMilli()
	}
	ev := func(kind proto.EventKind, v any) proto.Event {
		d, _ := json.Marshal(v)
		return proto.Event{TS: ts, Kind: kind, Data: d}
	}
	if l.Type == "system" && l.Subtype == "compact_boundary" {
		c := proto.CompactInfo{At: ts, Trigger: "auto"}
		if m := l.CompactMetadata; m != nil {
			if m.Trigger == "manual" {
				c.Trigger = "manual"
			}
			c.PreTokens = m.PreTokens
		}
		return []proto.Event{ev(proto.KindCompact, c)}
	}
	// a background task's notification: task_end cards, never a user bubble (also on a meta row)
	notice := func(s string) []proto.Event {
		var out []proto.Event
		for _, te := range TaskEnds(s) {
			out = append(out, ev(proto.KindTaskEnd, te))
		}
		return out
	}
	var text string
	isText := json.Unmarshal(l.Message.Content, &text) == nil
	if l.Type == "user" && !l.IsCompactSummary && isText && IsTaskNotification(text) {
		return notice(text)
	}
	if l.IsMeta || l.IsCompactSummary || (l.Type != "user" && l.Type != "assistant") {
		return nil
	}
	if isText {
		if text == "" || (l.Type == "user" && SkipUserText(text)) {
			return nil
		}
		if l.Type == "user" {
			return []proto.Event{ev(proto.KindUser, map[string]string{"text": clip(text)})}
		}
		return []proto.Event{ev(proto.KindAssistant, map[string]string{"text": clip(text)})}
	}
	var blocks []block
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		return nil
	}
	var out []proto.Event
	for _, b := range blocks {
		switch {
		case b.Type == "text" && b.Text != "":
			kind := proto.KindAssistant
			if l.Type == "user" {
				if IsTaskNotification(b.Text) {
					out = append(out, notice(b.Text)...)
					continue
				}
				if SkipUserText(b.Text) {
					continue
				}
				kind = proto.KindUser
			}
			out = append(out, ev(kind, map[string]string{"text": clip(b.Text)}))
		case b.Type == "tool_use" && l.Type == "assistant":
			out = append(out, ev(proto.KindToolStart, proto.ToolStart{ID: b.ID, Name: b.Name, Summary: clip(summarize(b.Name, b.Input)), Input: TrimInput(b.Name, b.Input)}))
		}
	}
	return out
}

// summarize replicates the one-line summary the mod builds.
func summarize(tool string, input json.RawMessage) string {
	var o map[string]any
	_ = json.Unmarshal(input, &o)
	key := ""
	switch tool {
	case "Bash":
		key = "command"
	case "Read", "Write", "Edit":
		key = "file_path"
	case "Grep", "Glob":
		key = "pattern"
	case "WebFetch":
		key = "url"
	}
	if key != "" {
		if v, ok := o[key].(string); ok {
			return v
		}
	}
	// json.Marshal sorts the keys: the order is stable even though it is not the mod's.
	var keys []string
	for k := range o {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for _, k := range keys {
		var v string
		if s, ok := o[k].(string); ok {
			v = s
		} else {
			b, _ := json.Marshal(o[k])
			v = string(b)
		}
		if sb.Len() > 0 {
			sb.WriteByte(' ')
		}
		fmt.Fprintf(&sb, "%s=%s", k, v)
		if sb.Len() >= 120 {
			break
		}
	}
	r := []rune(sb.String())
	if len(r) > 120 {
		r = r[:120]
	}
	return string(r)
}
