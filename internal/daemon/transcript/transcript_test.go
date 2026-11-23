package transcript

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/proto"
)

func TestParseSample(t *testing.T) {
	f, err := os.Open("testdata/sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	evs, err := Parse(f, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 3 {
		t.Fatalf("eventos = %d: %+v", len(evs), evs)
	}
	want := []proto.EventKind{proto.KindUser, proto.KindAssistant, proto.KindToolStart}
	for i, k := range want {
		if evs[i].Kind != k {
			t.Fatalf("evs[%d].Kind = %s, wanted %s", i, evs[i].Kind, k)
		}
	}
	var u map[string]string
	json.Unmarshal(evs[0].Data, &u)
	if u["text"] != "Hello, review the example file" || evs[0].TS != 1767323045678 {
		t.Fatalf("user = %v ts=%d", u, evs[0].TS)
	}
	var a map[string]string
	json.Unmarshal(evs[1].Data, &a)
	if a["text"] != "I will read it." {
		t.Fatalf("assistant = %v", a)
	}
	var ts proto.ToolStart
	json.Unmarshal(evs[2].Data, &ts)
	if ts.ID != "toolu_A1" || ts.Name != "Read" || ts.Summary != "/tmp/example.txt" {
		t.Fatalf("tool_start = %+v", ts)
	}
}

func TestParseLimitKeepsLast(t *testing.T) {
	var sb strings.Builder
	for _, w := range []string{"uno", "dos", "tres", "cuatro", "cinco"} {
		sb.WriteString(`{"type":"user","message":{"content":"` + w + "\"}}\ngarbage\n")
	}
	evs, err := Parse(strings.NewReader(sb.String()), 2)
	if err != nil || len(evs) != 2 {
		t.Fatalf("%v %v", evs, err)
	}
	var d map[string]string
	json.Unmarshal(evs[0].Data, &d)
	if d["text"] != "cuatro" {
		t.Fatalf("first = %v", d)
	}
}

func TestParseSkipsSyntheticUserText(t *testing.T) {
	in := `{"type":"user","message":{"content":"<command-name>/x</command-name>"}}
{"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}
{"type":"user","message":{"content":"real"}}
`
	evs, err := Parse(strings.NewReader(in), 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("%v %v", evs, err)
	}
}

func TestParseClipsLongText(t *testing.T) {
	long := strings.Repeat("ñ", MaxText) // 2*MaxText bytes
	evs, _ := Parse(strings.NewReader(`{"type":"assistant","message":{"content":"`+long+`"}}`), 10)
	var d map[string]string
	json.Unmarshal(evs[0].Data, &d)
	if len(d["text"]) > MaxText+len("…") || !strings.HasSuffix(d["text"], "…") || !utf8.ValidString(d["text"]) {
		t.Fatalf("len=%d", len(d["text"]))
	}
}

func TestParseToolUseCarriesInput(t *testing.T) {
	line := `{"type":"assistant","timestamp":"2026-01-02T03:04:05.678Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"/a/b.go","old_string":"foo","new_string":"bar"}}]}}`
	evs, err := Parse(strings.NewReader(line+"\n"), 500)
	if err != nil || len(evs) != 1 {
		t.Fatalf("evs=%v err=%v", evs, err)
	}
	var ts proto.ToolStart
	if err := json.Unmarshal(evs[0].Data, &ts); err != nil {
		t.Fatal(err)
	}
	var in map[string]string
	if err := json.Unmarshal(ts.Input, &in); err != nil {
		t.Fatalf("input %s: %v", ts.Input, err)
	}
	if in["file_path"] != "/a/b.go" || in["old_string"] != "foo" || in["new_string"] != "bar" {
		t.Fatalf("input = %v", in)
	}
}
