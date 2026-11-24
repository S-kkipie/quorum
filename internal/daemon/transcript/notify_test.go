package transcript

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Fixture texts copied from mod/test/notifications.test.ts (the live parser's tests).
var (
	bashDone = strings.Join([]string{
		"<task-notification>",
		"<task-id>bq7x2k9</task-id>",
		"<tool-use-id>toolu_01AbC</tool-use-id>",
		"<output-file>/tmp/claude-1000/-home-u-app/S1/tasks/bq7x2k9.output</output-file>",
		"<status>completed</status>",
		`<summary>Background command "npm test" completed (exit code 0)</summary>`,
		"</task-notification>",
		"Read the output file to retrieve the result: /tmp/claude-1000/-home-u-app/S1/tasks/bq7x2k9.output",
	}, "\n")
	bashFailed = strings.Join([]string{
		"<task-notification>",
		"<task-id>bf1</task-id>",
		"<status>failed</status>",
		"<exit-code>2</exit-code>",
		`<summary>Background command "make lint" failed with exit code 2</summary>`,
		"</task-notification>",
	}, "\n")
	monitorEvent = "<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor \"dev server log\" event</summary>\n<event>GET /health 200</event>\n</task-notification>"
)

func agentDone(result string) string {
	return strings.Join([]string{
		"<task-notification>",
		"<task-id>a5d9e1</task-id>",
		"<tool-use-id>toolu_02</tool-use-id>",
		"<output-file>/tmp/claude-1000/x/tasks/a5d9e1.output</output-file>",
		"<status>completed</status>",
		`<summary>Agent "Explore the repo" completed</summary>`,
		"<result>" + result + "</result>",
		"<usage><total_tokens>1200</total_tokens><tool_uses>4</tool_uses><duration_ms>5000</duration_ms></usage>",
		"</task-notification>",
	}, "\n")
}

func TestTaskEndsShapes(t *testing.T) {
	got := TaskEnds(bashDone + "\n" + bashFailed + "\n" + monitorEvent)
	if len(got) != 2 {
		t.Fatalf("task ends = %+v", got)
	}
	if g := got[0]; g.TaskID != "bq7x2k9" || g.Kind != "command" || g.Status != "completed" || g.ExitCode == nil || *g.ExitCode != 0 ||
		g.Summary != `Background command "npm test" completed (exit code 0)` || g.OutputTail != "" {
		t.Fatalf("bash = %+v", g)
	}
	if g := got[1]; g.TaskID != "bf1" || g.Status != "failed" || g.ExitCode == nil || *g.ExitCode != 2 {
		t.Fatalf("failed = %+v", g)
	}
	long := strings.Repeat("x", 3000) + "<b>markup</b> THE END"
	a := TaskEnds(agentDone(long))
	if len(a) != 1 || a[0].Kind != "subagent" || len(a[0].OutputTail) != outputTailMax || !strings.HasSuffix(a[0].OutputTail, "THE END") || a[0].ExitCode != nil {
		t.Fatalf("agent = %+v", a)
	}
	for _, s := range []string{
		"<task-notification><task-id>z</task-id></task-notification>",
		"<task-notification><status>completed</status></task-notification>",
		"<task-notification><task-id>q",
		"plain",
	} {
		if g := TaskEnds(s); len(g) != 0 {
			t.Fatalf("%q -> %+v", s, g)
		}
	}
	quoted := "<task-notification><task-id>a2</task-id><status>completed</status><result><task-id>evil</task-id></result></task-notification>"
	if g := TaskEnds(quoted); len(g) != 1 || g[0].TaskID != "a2" {
		t.Fatalf("quoted = %+v", g)
	}
}

func TestTaskEndsAdversarialFast(t *testing.T) {
	mb := 1 << 20
	inputs := []string{
		strings.Repeat("<task-notification>", mb/19),
		"<task-notification><task-id>x</task-id>" + strings.Repeat("<summary>", mb/9) + "</task-notification>",
		"<task-notification>" + strings.Repeat("<task-id>", mb/9),
	}
	for _, in := range inputs {
		t0 := time.Now()
		TaskEnds(in)
		if d := time.Since(t0); d > 250*time.Millisecond {
			t.Fatalf("took %v", d)
		}
	}
	big := `<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "x" completed</summary><result>` +
		strings.Repeat("y", mb) + "THE REAL END</result></task-notification>"
	g := TaskEnds(big)
	if len(g) != 1 || !strings.HasSuffix(g[0].OutputTail, "THE REAL END") || len(g[0].OutputTail) != outputTailMax {
		t.Fatalf("big = %d %+v", len(g), len(g[0].OutputTail))
	}
}

func TestNotificationRowsMapToTaskEnd(t *testing.T) {
	str, _ := json.Marshal(bashDone)
	blocks, _ := json.Marshal([]map[string]string{{"type": "text", "text": agentDone("Found 3 entry points.")}})
	mon, _ := json.Marshal(monitorEvent)
	rows := []string{
		`{"type":"user","uuid":"u1","timestamp":"2026-11-24T10:00:00Z","message":{"content":` + string(str) + `}}`,
		`{"type":"user","uuid":"u2","isMeta":true,"timestamp":"2026-11-24T10:01:00Z","message":{"content":` + string(blocks) + `}}`,
		`{"type":"user","uuid":"u3","timestamp":"2026-11-24T10:02:00Z","message":{"content":` + string(blocks) + `}}`,
		`{"type":"user","uuid":"u4","timestamp":"2026-11-24T10:03:00Z","message":{"content":` + string(mon) + `}}`,
	}
	evs, err := Parse(strings.NewReader(strings.Join(rows, "\n")+"\n"), 0)
	if err != nil {
		t.Fatal(err)
	}
	// u2 is a meta row with blocks: skipped as before; u4 is a monitor event: nothing
	if len(evs) != 2 || evs[0].Kind != proto.KindTaskEnd || evs[1].Kind != proto.KindTaskEnd || evs[0].Key != "u1/0" || evs[1].Key != "u3/0" {
		t.Fatalf("evs = %+v", evs)
	}
	var te proto.TaskEnd
	json.Unmarshal(evs[1].Data, &te)
	if te.TaskID != "a5d9e1" || te.Kind != "subagent" || te.OutputTail != "Found 3 entry points." {
		t.Fatalf("te = %+v", te)
	}
	for _, e := range evs {
		if e.Kind == proto.KindUser {
			t.Fatalf("user bubble from a notification: %+v", e)
		}
	}
	if !SkipUserText(bashDone) {
		t.Fatal("a notification is not user text")
	}
}
