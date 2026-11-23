// Package transcript rebuilds a session's history from the JSONL
// that Claude Code stores on disk. The format is internal: whatever is not understood is skipped.
package transcript

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sort"
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
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	Timestamp   string `json:"timestamp"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// Parse returns at most the last limit user/assistant/tool_start events.
func Parse(r io.Reader, limit int) ([]proto.Event, error) {
	var out []proto.Event
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		raw, err := readLine(br)
		if len(raw) > 0 {
			out = append(out, parseLine(raw)...)
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
func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	tooBig := false
	for {
		chunk, err := br.ReadSlice('\n')
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
			return nil, err
		}
		return buf, err
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
		strings.HasPrefix(s, "[Request interrupted by user")
}

func parseLine(raw []byte) []proto.Event {
	var l line
	if json.Unmarshal(raw, &l) != nil || l.IsMeta || l.IsSidechain {
		return nil
	}
	if l.Type != "user" && l.Type != "assistant" {
		return nil
	}
	var ts int64
	if t, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
		ts = t.UnixMilli()
	}
	ev := func(kind proto.EventKind, v any) proto.Event {
		d, _ := json.Marshal(v)
		return proto.Event{TS: ts, Kind: kind, Data: d}
	}
	var text string
	if json.Unmarshal(l.Message.Content, &text) == nil {
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
