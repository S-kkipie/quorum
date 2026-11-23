package transcript

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// TrimInput must stay in sync with trimInput in mod/src/trim.ts: same limits, same table, same
// algorithm. The shared test cases live in trim_test.go and mod/test/trim.test.ts.

const (
	strMax       = 2000 // runes
	arrMax       = 50
	totalMax     = 16 * 1024 // bytes, serialized
	fallbackKeys = 8
	keyMax       = 64 // runes, for object key names
	maxDepth     = 8
)

var internalKeys = map[string]bool{"tool": true, "tool_use_id": true, "agentId": true}

// keepKeys are the keys kept when the total goes over totalMax.
var keepKeys = map[string][]string{
	"Bash":      {"command", "description"},
	"Read":      {"file_path", "offset", "limit"},
	"Write":     {"file_path", "content"},
	"Edit":      {"file_path", "old_string", "new_string", "replace_all"},
	"MultiEdit": {"file_path", "edits"},
	"Grep":      {"pattern", "path", "glob"},
	"Glob":      {"pattern", "path"},
	"WebSearch": {"query"},
	"WebFetch":  {"url", "prompt"},
	"Skill":     {"skill", "args"},
	"Agent":     {"description", "subagent_type", "prompt"},
	"Task":      {"description", "subagent_type", "prompt"},
	"TodoWrite": {"todos"},
}

// obj is a JSON object that remembers key insertion order.
type obj struct {
	keys []string
	vals map[string]any
}

func newObj() *obj { return &obj{vals: map[string]any{}} }

// set mimics assigning a property on a JS object: a repeated key keeps its first position.
func (o *obj) set(k string, v any) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

// parseValue decodes one JSON value into string, json.Number, bool, nil, []any or *obj.
func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil // string, json.Number, bool or nil
	}
	if d == '[' {
		arr := []any{}
		for dec.More() {
			v, err := parseValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		_, err := dec.Token()
		return arr, err
	}
	o := newObj()
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		v, err := parseValue(dec)
		if err != nil {
			return nil, err
		}
		o.set(kt.(string), v)
	}
	_, err = dec.Token()
	return o, err
}

func cut(s string, max int) string {
	if len(s) <= max { // bytes >= runes, so this is safely short
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

func clipVal(v any, max, depth int) any {
	if s, ok := v.(string); ok {
		return cut(s, max)
	}
	if depth > maxDepth {
		return nil
	}
	switch x := v.(type) {
	case []any:
		if len(x) > arrMax {
			x = x[:arrMax]
		}
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = clipVal(e, max, depth+1)
		}
		return out
	case *obj:
		o := newObj()
		for _, k := range x.keys {
			o.set(cut(k, keyMax), clipVal(x.vals[k], max, depth+1))
		}
		return o
	}
	return v
}

// encode writes v as compact JSON without HTML escaping (like JS JSON.stringify).
func encode(buf *bytes.Buffer, v any) {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case string:
		encString(buf, x)
	case []any:
		buf.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			encode(buf, e)
		}
		buf.WriteByte(']')
	case *obj:
		buf.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			encString(buf, k)
			buf.WriteByte(':')
			encode(buf, x.vals[k])
		}
		buf.WriteByte('}')
	default: // json.Number, bool
		b, _ := json.Marshal(x)
		buf.Write(b)
	}
}

func encString(buf *bytes.Buffer, s string) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	out := strings.TrimSuffix(b.String(), "\n")
	buf.WriteString(out)
}

func encoded(v any) []byte {
	var buf bytes.Buffer
	encode(&buf, v)
	return buf.Bytes()
}

// TrimInput returns a trimmed copy of a tool's input for tool_start: internal keys removed,
// strings <= 2000 runes, arrays <= 50 elements, total <= 16 KiB (otherwise only the tool's main
// keys remain). Non-object input yields {}.
func TrimInput(tool string, input json.RawMessage) json.RawMessage {
	own := newObj()
	if len(input) > 0 {
		dec := json.NewDecoder(bytes.NewReader(input))
		dec.UseNumber()
		if v, err := parseValue(dec); err == nil {
			if _, err := dec.Token(); err == io.EOF {
				if src, ok := v.(*obj); ok {
					for _, k := range src.keys {
						if !internalKeys[k] {
							own.set(k, src.vals[k])
						}
					}
				}
			}
		}
	}

	out := clipVal(own, strMax, 0)
	if b := encoded(out); len(b) <= totalMax {
		return b
	}

	keys, ok := keepKeys[tool]
	if !ok {
		keys = own.keys
		if len(keys) > fallbackKeys {
			keys = keys[:fallbackKeys]
		}
	}
	kept := newObj()
	for _, k := range keys {
		if v, ok := own.vals[k]; ok {
			kept.set(k, v)
		}
	}
	// still too big: shrink the per-string limit until it fits
	for max := strMax; max >= 1; max /= 2 {
		if b := encoded(clipVal(kept, max, 0)); len(b) <= totalMax {
			return b
		}
	}
	// last resort: only scalar values of the kept keys, tightly trimmed
	scalars := newObj()
	for _, k := range kept.keys {
		switch kept.vals[k].(type) {
		case nil, string, json.Number, bool:
			scalars.set(cut(k, keyMax), clipVal(kept.vals[k], 256, 0))
		}
	}
	if b := encoded(scalars); len(b) <= totalMax {
		return b
	}
	return json.RawMessage("{}")
}
