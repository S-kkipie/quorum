package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func callPluginState(t *testing.T, configDir, plugin, session string) (json.RawMessage, error) {
	t.Helper()
	p, _ := json.Marshal(map[string]string{"configDir": configDir, "plugin": plugin, "session": session})
	res, err := rpcHandlers["plugin_state"](context.Background(), nil, p)
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(res)
	return b, nil
}

func writeStore(t *testing.T, dir, name, content string) {
	t.Helper()
	d := filepath.Join(dir, "plugins", "store")
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestPluginStateReadsOnlyTheSessionKey(t *testing.T) {
	dir := t.TempDir()
	writeStore(t, dir, "after_better-claude-abc123.json", `{"queue:s1":[{"text":"a"}],"queue:s2":[{"text":"b"}]}`)
	writeStore(t, dir, "time-machine_better-claude-ff00.json", `{"session:s1":{"states":[1,2]},"queue:s1":"no"}`)
	got, err := callPluginState(t, dir, "after", "s1")
	if err != nil || string(got) != `[{"text":"a"}]` {
		t.Fatalf("after: %s %v", got, err)
	}
	got, err = callPluginState(t, dir, "time-machine", "s1")
	if err != nil || string(got) != `{"states":[1,2]}` {
		t.Fatalf("time-machine: %s %v", got, err)
	}
	got, _ = callPluginState(t, dir, "after", "other")
	if string(got) != "null" {
		t.Fatalf("missing key = %s", got)
	}
}

func TestPluginStateMissingAndMalformed(t *testing.T) {
	dir := t.TempDir()
	if got, err := callPluginState(t, dir, "after", "s1"); err != nil || string(got) != "null" {
		t.Fatalf("missing file: %s %v", got, err)
	}
	writeStore(t, dir, "after_better-claude-abc.json", `{not json`)
	var logs strings.Builder
	oldLog := pluginStateWarn
	pluginStateWarn = func(msg string) { logs.WriteString(msg + "\n") }
	t.Cleanup(func() { pluginStateWarn = oldLog })
	pluginStateWarned.Range(func(k, _ any) bool { pluginStateWarned.Delete(k); return true })
	for i := 0; i < 3; i++ {
		if got, err := callPluginState(t, dir, "after", "s1"); err != nil || string(got) != "null" {
			t.Fatalf("malformed: %s %v", got, err)
		}
	}
	if n := strings.Count(logs.String(), "\n"); n != 1 {
		t.Fatalf("expected one log line, got %d: %q", n, logs.String())
	}
}

func TestPluginStateTooLarge(t *testing.T) {
	dir := t.TempDir()
	writeStore(t, dir, "after_better-claude-abc.json", `{"queue:s1":"`+strings.Repeat("x", pluginStateMax)+`"}`)
	if _, err := callPluginState(t, dir, "after", "s1"); err == nil || err.Error() != "state too large" {
		t.Fatalf("err = %v", err)
	}
}

func TestPluginStateValidation(t *testing.T) {
	dir := t.TempDir()
	if _, err := callPluginState(t, dir, "rm", "s1"); err == nil || err.Error() != "unknown plugin" {
		t.Fatalf("plugin err = %v", err)
	}
	if _, err := callPluginState(t, "relative/dir", "after", "s1"); err == nil {
		t.Fatal("relative configDir accepted")
	}
	// ".." is cleaned lexically, so the store is read from the cleaned dir
	writeStore(t, dir, "after_better-claude-abc.json", `{"queue:s1":1}`)
	sub := filepath.Join(dir, "x", "..")
	if got, err := callPluginState(t, sub, "after", "s1"); err != nil || string(got) != "1" {
		t.Fatalf("cleaned dir: %s %v", got, err)
	}
	// a store file name that merely contains the prefix elsewhere is not matched
	other := t.TempDir()
	writeStore(t, other, "xafter_better-claude-abc.json", `{"queue:s1":1}`)
	if got, _ := callPluginState(t, other, "after", "s1"); string(got) != "null" {
		t.Fatalf("prefix leak: %s", got)
	}
}

// The config dir is a path, never a pattern: glob metacharacters in it must not break the match.
func TestPluginStateConfigDirWithGlobCharacters(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cfg[1]*?")
	writeStore(t, dir, "after_better-claude-abc.json", `{"queue:s1":7}`)
	if got, err := callPluginState(t, dir, "after", "s1"); err != nil || string(got) != "7" {
		t.Fatalf("glob chars in configDir: %s %v", got, err)
	}
}

// An open error other than not-exist (here: no permission) is logged once per file.
func TestPluginStateOpenErrorLoggedOnce(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX permissions and a non-root user")
	}
	dir := t.TempDir()
	writeStore(t, dir, "after_better-claude-abc.json", `{"queue:s1":1}`)
	p := filepath.Join(dir, "plugins", "store", "after_better-claude-abc.json")
	if err := os.Chmod(p, 0); err != nil {
		t.Fatal(err)
	}
	var logs strings.Builder
	oldLog := pluginStateWarn
	pluginStateWarn = func(msg string) { logs.WriteString(msg + "\n") }
	t.Cleanup(func() { pluginStateWarn = oldLog })
	pluginStateWarned.Range(func(k, _ any) bool { pluginStateWarned.Delete(k); return true })
	for i := 0; i < 3; i++ {
		if got, err := callPluginState(t, dir, "after", "s1"); err != nil || string(got) != "null" {
			t.Fatalf("unreadable: %s %v", got, err)
		}
	}
	if n := strings.Count(logs.String(), "\n"); n != 1 || !strings.Contains(logs.String(), "after_better-claude-abc.json") {
		t.Fatalf("expected one log line naming the file, got %q", logs.String())
	}
}
