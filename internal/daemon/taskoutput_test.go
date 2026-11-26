package daemon

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

const toSession = "11111111-2222-3333-4444-555555555555"

type toResult struct {
	Found      bool   `json:"found"`
	Size       int64  `json:"size"`
	Mtime      int64  `json:"mtime"`
	Tail       string `json:"tail"`
	ProcsKnown bool   `json:"procsKnown"`
	Procs      []struct {
		Pid   int    `json:"pid"`
		State string `json:"state"`
		CPUMs int64  `json:"cpuMs"`
	} `json:"procs"`
}

// toSetup registers a session and returns a ctx carrying the registry and the tasks dir.
func toSetup(t *testing.T) (context.Context, string) {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("CLAUDE_CODE_TMPDIR", tmp)
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: toSession})
	ctx := context.WithValue(context.Background(), rpcLinkKey{}, rpcLink{ctx: context.Background(), reg: reg})
	dir := filepath.Join(tmp, "claude-"+itoa(os.Getuid()), "-home-u-proj", toSession, "tasks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return ctx, dir
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func toCall(ctx context.Context, session, task string) (toResult, error) {
	p, _ := json.Marshal(map[string]string{"session": session, "task": task})
	res, err := rpcHandlers["task_output"](ctx, nil, p)
	if err != nil {
		return toResult{}, err
	}
	b, _ := json.Marshal(res)
	var out toResult
	err = json.Unmarshal(b, &out)
	return out, err
}

func TestTaskOutputRejectsBadIDs(t *testing.T) {
	ctx, _ := toSetup(t)
	long := strings.Repeat("a", 129)
	for _, c := range [][2]string{{"../x", "t1"}, {toSession, "../x"}, {"a/b", "t1"}, {toSession, "a/b"}, {"", "t1"}, {toSession, ""}, {long, "t1"}, {toSession, long}} {
		if _, err := toCall(ctx, c[0], c[1]); err == nil {
			t.Errorf("session %q task %q accepted", c[0], c[1])
		}
	}
}

func TestTaskOutputUnknownSession(t *testing.T) {
	ctx, _ := toSetup(t)
	if _, err := toCall(ctx, "other-session", "t1"); err == nil {
		t.Fatal("unregistered session accepted")
	}
}

func TestTaskOutputMissingFile(t *testing.T) {
	ctx, _ := toSetup(t)
	res, err := toCall(ctx, toSession, "nope")
	if err != nil || res.Found {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestTaskOutputTail(t *testing.T) {
	ctx, dir := toSetup(t)
	data := []byte(strings.Repeat("0123456789abcdef", 200*1024/16))
	data = append(data, []byte("THE END")...)
	f := filepath.Join(dir, "t1.output")
	if err := os.WriteFile(f, data, 0o644); err != nil {
		t.Fatal(err)
	}
	mt := time.Unix(1_700_000_000, 0)
	os.Chtimes(f, mt, mt)
	res, err := toCall(ctx, toSession, "t1")
	if err != nil || !res.Found {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if len(res.Tail) > 65536 || !strings.HasSuffix(res.Tail, "THE END") || len(res.Tail) < 65000 {
		t.Fatalf("tail len %d", len(res.Tail))
	}
	if res.Size != int64(len(data)) || res.Mtime != mt.UnixMilli() {
		t.Fatalf("size %d mtime %d", res.Size, res.Mtime)
	}
}

func TestTaskOutputCutsToRuneStart(t *testing.T) {
	ctx, dir := toSetup(t)
	// 3-byte runes: the 65536-byte window starts mid-rune
	data := []byte(strings.Repeat("€", 30000))
	os.WriteFile(filepath.Join(dir, "t2.output"), data, 0o644)
	res, _ := toCall(ctx, toSession, "t2")
	if strings.ContainsRune(res.Tail, '�') || len(res.Tail) > 65536 || len(res.Tail)%3 != 0 || !strings.HasPrefix(res.Tail, "€") {
		t.Fatalf("bad tail: len %d", len(res.Tail))
	}
}

func TestTaskOutputSymlink(t *testing.T) {
	ctx, dir := toSetup(t)
	real := filepath.Join(t.TempDir(), "agent.jsonl")
	os.WriteFile(real, []byte("hello"), 0o644)
	os.Symlink(real, filepath.Join(dir, "a1.output"))
	res, _ := toCall(ctx, toSession, "a1")
	if !res.Found || res.Tail != "hello" || res.Size != 5 {
		t.Fatalf("%+v", res)
	}
}

func TestTaskOutputHolders(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux only")
	}
	ctx, dir := toSetup(t)
	f := filepath.Join(dir, "t3.output")
	out, err := os.Create(f)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "30")
	cmd.Stdout = out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	out.Close()
	killed := false
	defer func() {
		if !killed {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	res, err := toCall(ctx, toSession, "t3")
	if err != nil || !res.ProcsKnown {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	found := false
	for _, p := range res.Procs {
		if p.Pid == cmd.Process.Pid && p.State != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("pid %d not in %+v", cmd.Process.Pid, res.Procs)
	}
	cmd.Process.Kill()
	cmd.Wait()
	killed = true
	res, _ = toCall(ctx, toSession, "t3")
	if !res.ProcsKnown || len(res.Procs) != 0 {
		t.Fatalf("after kill (child %d, self %d): %+v", cmd.Process.Pid, os.Getpid(), res)
	}
	p, _ := json.Marshal(map[string]string{"session": toSession, "task": "t3"})
	raw, _ := rpcHandlers["task_output"](ctx, nil, p)
	b, _ := json.Marshal(raw)
	if !strings.Contains(string(b), `"procs":[]`) {
		t.Fatalf("procs not an empty array: %s", b)
	}
}

func TestTaskOutputTailOfContinuationBytesIsBounded(t *testing.T) {
	ctx, dir := toSetup(t)
	// the cut lands on 5 continuation bytes then "a": at most UTFMax (4) are dropped, the 5th becomes U+FFFD
	data := append([]byte(strings.Repeat("x", 70000-taskTailMax)), []byte("\x80\x80\x80\x80\x80a")...)
	data = append(data, []byte(strings.Repeat("a", taskTailMax-6))...)
	if err := os.WriteFile(filepath.Join(dir, "t1.output"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := toCall(ctx, toSession, "t1")
	if err != nil || !r.Found {
		t.Fatalf("res %+v err %v", r, err)
	}
	if want := "\uFFFD" + strings.Repeat("a", taskTailMax-5); r.Tail != want {
		t.Fatalf("tail prefix %q (len %d)", r.Tail[:8], len(r.Tail))
	}
}
