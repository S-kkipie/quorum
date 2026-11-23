package transcript

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

// These cases mirror mod/test/trim.test.ts. The Go and TS implementations must stay in sync:
// when you change one, change the other and both test files.

func trim(t *testing.T, tool string, in any) (json.RawMessage, map[string]any) {
	t.Helper()
	var raw json.RawMessage
	if s, ok := in.(string); ok && strings.HasPrefix(s, "RAW:") {
		raw = json.RawMessage(s[4:])
	} else {
		b, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		raw = b
	}
	out := TrimInput(tool, raw)
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output %s is not a JSON object: %v", out, err)
	}
	return out, m
}

func orderedKeys(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.Token()
	var keys []string
	for dec.More() {
		k, _ := dec.Token()
		keys = append(keys, k.(string))
		var skip json.RawMessage
		dec.Decode(&skip)
	}
	return keys
}

type M = map[string]any

func TestTrimInputMatchesModRules(t *testing.T) {
	t.Run("strings truncated to 2000 runes", func(t *testing.T) {
		_, m := trim(t, "Bash", M{"command": strings.Repeat("x", 5000)})
		if n := utf8.RuneCountInString(m["command"].(string)); n != 2000 {
			t.Fatalf("runes = %d", n)
		}
		_, m = trim(t, "Bash", M{"command": strings.Repeat("😀", 3000)})
		if m["command"] != strings.Repeat("😀", 2000) {
			t.Fatalf("emoji cut wrong")
		}
	})

	t.Run("arrays keep 50 elements", func(t *testing.T) {
		todos := make([]any, 80)
		for i := range todos {
			todos[i] = M{"content": fmt.Sprintf("t%d", i)}
		}
		_, m := trim(t, "TodoWrite", M{"todos": todos})
		if n := len(m["todos"].([]any)); n != 50 {
			t.Fatalf("len = %d", n)
		}
	})

	t.Run("2 MB Write stays within 16384 bytes and keeps file_path", func(t *testing.T) {
		out, m := trim(t, "Write", M{"file_path": "/a/b.txt", "content": strings.Repeat("y", 2_000_000), "extra": "z"})
		if len(out) > 16384 || m["file_path"] != "/a/b.txt" {
			t.Fatalf("len=%d m=%v", len(out), m["file_path"])
		}
	})

	t.Run("over 16 KiB keeps only the table keys of the tool", func(t *testing.T) {
		// raw JSON so the key order is explicit
		var sb strings.Builder
		sb.WriteString("RAW:{")
		var first8 []string
		for i := 0; i < 50; i++ {
			fmt.Fprintf(&sb, `"k%d":"%s",`, i, strings.Repeat("v", 1000))
			if i < 8 {
				first8 = append(first8, fmt.Sprintf("k%d", i))
			}
		}
		sb.WriteString(`"query":"q"}`)
		out, _ := trim(t, "WebSearch", sb.String())
		if k := orderedKeys(t, out); strings.Join(k, ",") != "query" {
			t.Fatalf("keys = %v", k)
		}
		out, _ = trim(t, "Mystery", sb.String())
		if k := orderedKeys(t, out); strings.Join(k, ",") != strings.Join(first8, ",") {
			t.Fatalf("keys = %v", k)
		}
	})

	t.Run("removes tool, tool_use_id and agentId", func(t *testing.T) {
		out, _ := trim(t, "Bash", M{"tool": "Bash", "tool_use_id": "t1", "agentId": "a", "command": "ls"})
		if string(out) != `{"command":"ls"}` {
			t.Fatalf("out = %s", out)
		}
	})

	t.Run("non-object input gives {}", func(t *testing.T) {
		for _, in := range []json.RawMessage{nil, json.RawMessage(`"x"`), json.RawMessage(`[1]`), json.RawMessage(`null`), json.RawMessage(`{bad`)} {
			if out := TrimInput("Bash", in); string(out) != "{}" {
				t.Fatalf("%s -> %s", in, out)
			}
		}
	})

	t.Run("nested strings are trimmed", func(t *testing.T) {
		_, m := trim(t, "MultiEdit", M{
			"file_path": "/f",
			"edits":     []any{M{"old_string": strings.Repeat("a", 3000), "new_string": "b"}},
			"nested":    M{"deep": strings.Repeat("c", 3000)},
		})
		e := m["edits"].([]any)[0].(M)
		if utf8.RuneCountInString(e["old_string"].(string)) != 2000 ||
			utf8.RuneCountInString(m["nested"].(M)["deep"].(string)) != 2000 {
			t.Fatal("nested not trimmed")
		}
	})

	t.Run("halving fallback shrinks strings to fit", func(t *testing.T) {
		todos := make([]any, 50)
		for i := range todos {
			todos[i] = M{"content": strings.Repeat("x", 2000), "id": i}
		}
		out, m := trim(t, "TodoWrite", M{"todos": todos, "noise": "n"})
		if k := orderedKeys(t, out); strings.Join(k, ",") != "todos" {
			t.Fatalf("keys = %v", k)
		}
		ts := m["todos"].([]any)
		if len(ts) != 50 || len(out) > 16384 || utf8.RuneCountInString(ts[0].(M)["content"].(string)) >= 2000 {
			t.Fatalf("len=%d n=%d", len(out), len(ts))
		}
	})

	t.Run("pathological input stays within 16384 bytes", func(t *testing.T) {
		o := M{}
		for i := 0; i < 200; i++ {
			o[strings.Repeat("k", 500)+fmt.Sprint(i)] = strings.Repeat("v", 500)
		}
		edits := make([]any, 50)
		for i := range edits {
			edits[i] = o
		}
		for _, tool := range []string{"MultiEdit", "TodoWrite", "Mystery"} {
			out, _ := trim(t, tool, M{"file_path": "/f", "edits": edits, "todos": edits, "other": edits})
			if len(out) > 16384 {
				t.Fatalf("%s: %d bytes", tool, len(out))
			}
		}
		out, _ := trim(t, "Write", M{"file_path": "/f", "content": "z"})
		if string(out) != `{"content":"z","file_path":"/f"}` && string(out) != `{"file_path":"/f","content":"z"}` {
			t.Fatalf("out = %s", out)
		}
	})

	t.Run("no HTML escaping and original key order", func(t *testing.T) {
		out := TrimInput("Bash", json.RawMessage(`{"z":"<a&b>","a":1}`))
		if string(out) != `{"z":"<a&b>","a":1}` {
			t.Fatalf("out = %s", out)
		}
	})

	t.Run("size is measured as UTF-8 bytes", func(t *testing.T) {
		// 5 fields of 2000 two-byte runes: 20000 bytes > 16384 but only 10000 runes
		in := M{"command": strings.Repeat("é", 2000), "description": strings.Repeat("é", 2000), "x": strings.Repeat("é", 2000), "y": strings.Repeat("é", 2000), "w": strings.Repeat("é", 2000)}
		out, _ := trim(t, "Bash", in)
		if len(out) > 16384 {
			t.Fatalf("%d bytes", len(out))
		}
		if k := orderedKeys(t, out); strings.Join(k, ",") != "command,description" {
			t.Fatalf("keys = %v", k)
		}
	})
}
