// Package transcript reconstruye el historial de una sesión desde el JSONL
// que Claude Code guarda en disco. El formato es interno: lo que no se entiende se salta.
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
	// MaxText acota el texto de cada evento para que el resultado quepa en un mensaje WS.
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

// Parse devuelve como máximo los últimos limit eventos user/assistant/tool_start.
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

// readLine lee una línea completa; descarta (devuelve vacía) las que exceden maxLine.
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

// clip corta s a MaxText bytes en frontera de runa y añade "…".
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

// SkipUserText dice si es texto que Claude Code guarda como "user" pero no escribió una persona.
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
			out = append(out, ev(proto.KindToolStart, proto.ToolStart{ID: b.ID, Name: b.Name, Summary: clip(summarize(b.Name, b.Input))}))
		}
	}
	return out
}

// summarize replica el resumen de una línea que arma el mod.
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
	// json.Marshal ordena las claves: el orden es estable aunque no el del mod.
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
