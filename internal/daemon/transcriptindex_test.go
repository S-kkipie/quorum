package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func pageOf(t *testing.T, reg *Registry, session string) (proto.TranscriptPage, error) {
	t.Helper()
	raw, err := call(t, linkCtx(t), nil, reg, "transcript_page", proto.TranscriptPageParams{Session: session})
	if err != nil {
		return proto.TranscriptPage{}, err
	}
	var pg proto.TranscriptPage
	require.NoError(t, json.Unmarshal(raw, &pg))
	return pg, nil
}

func indexedRegistry(t *testing.T, file string) *Registry {
	t.Helper()
	reg := NewRegistry("m1")
	reg.SetTranscriptIndex(loadTranscriptIndex(file, 5000))
	return reg
}

func TestGoneSessionStaysPageable(t *testing.T) {
	cfg, tp := writeSynthetic(t, 20, 0)
	reg := indexedRegistry(t, filepath.Join(t.TempDir(), "transcripts.json"))
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	reg.Gone("s1")
	pg, err := pageOf(t, reg, "s1")
	require.NoError(t, err)
	require.Len(t, pg.Events, 21)
}

func TestRenameKeepsBothIDs(t *testing.T) {
	cfg, tpOld := writeSynthetic(t, 5, 0)
	tpNew := filepath.Join(filepath.Dir(tpOld), "new.jsonl")
	require.NoError(t, os.WriteFile(tpNew, []byte(`{"type":"user","uuid":"n","message":{"content":"after clear"}}`+"\n"), 0o600))
	reg := indexedRegistry(t, filepath.Join(t.TempDir(), "transcripts.json"))
	reg.Upsert(proto.SessionInfo{ID: "old", TranscriptPath: tpOld, ConfigDir: cfg})
	reg.Upsert(proto.SessionInfo{ID: "new", PreviousID: "old", TranscriptPath: tpNew, ConfigDir: cfg})
	pg, err := pageOf(t, reg, "old")
	require.NoError(t, err)
	require.Len(t, pg.Events, 6)
	pg, err = pageOf(t, reg, "new")
	require.NoError(t, err)
	require.Len(t, pg.Events, 1)
	require.Equal(t, "n/0", pg.Events[0].Key)
}

func TestTranscriptIndexSurvivesRestart(t *testing.T) {
	cfg, tp := writeSynthetic(t, 3, 0)
	file := filepath.Join(t.TempDir(), "transcripts.json")
	reg := indexedRegistry(t, file)
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	reg.FlushTranscriptIndex()
	st, err := os.Stat(file)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), st.Mode().Perm())
	reg2 := indexedRegistry(t, file) // a new daemon: nothing live
	pg, err := pageOf(t, reg2, "s1")
	require.NoError(t, err)
	require.Len(t, pg.Events, 4)
	// no temp files left behind
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(file), "*.tmp"))
	require.Empty(t, left)
}

func TestTranscriptIndexIsBounded(t *testing.T) {
	file := filepath.Join(t.TempDir(), "transcripts.json")
	idx := loadTranscriptIndex(file, 50)
	for i := 0; i < 200; i++ {
		idx.record(fmt.Sprintf("s%d", i), fmt.Sprintf("/c/projects/p/s%d.jsonl", i), "/c")
	}
	idx.record("s0", "/c/projects/p/s0.jsonl", "/c") // touched again: newest
	require.LessOrEqual(t, idx.len(), 50)
	_, ok := idx.lookup("s0")
	require.True(t, ok, "recently seen entry evicted")
	_, ok = idx.lookup("s1")
	require.False(t, ok, "oldest entry kept")
	_, ok = idx.lookup("s199")
	require.True(t, ok)
	idx.flush()
	again := loadTranscriptIndex(file, 50)
	require.LessOrEqual(t, again.len(), 50)
	_, ok = again.lookup("s199")
	require.True(t, ok)
}

func TestPlantedIndexEntryOutsideProjectsIsRefused(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "notes.jsonl")
	require.NoError(t, os.WriteFile(secret, []byte(`{"type":"user","message":{"content":"secret"}}`+"\n"), 0o600))
	file := filepath.Join(t.TempDir(), "transcripts.json")
	b, _ := json.Marshal(map[string]any{"entries": map[string]any{
		"planted":  map[string]any{"path": secret, "configDir": filepath.Dir(secret), "seen": 1},
		"planted2": map[string]any{"path": secret, "configDir": "", "seen": 1},
	}})
	require.NoError(t, os.WriteFile(file, b, 0o600))
	reg := indexedRegistry(t, file)
	for _, id := range []string{"planted", "planted2"} {
		_, err := pageOf(t, reg, id)
		require.Error(t, err, id)
	}
}

func TestTranscriptIndexCorruptFileStartsEmpty(t *testing.T) {
	file := filepath.Join(t.TempDir(), "transcripts.json")
	require.NoError(t, os.WriteFile(file, []byte("{not json"), 0o600))
	idx := loadTranscriptIndex(file, 10)
	require.Equal(t, 0, idx.len())
}

func TestTranscriptIndexWritesOffTheUpsertPath(t *testing.T) {
	old := indexSaveDelay
	indexSaveDelay = 50 * time.Millisecond
	t.Cleanup(func() { indexSaveDelay = old })
	file := filepath.Join(t.TempDir(), "transcripts.json")
	idx := loadTranscriptIndex(file, 50)
	for i := 0; i < 20; i++ {
		idx.record(fmt.Sprintf("s%d", i), fmt.Sprintf("/c/projects/p/s%d.jsonl", i), "/c")
	}
	_, err := os.Stat(file)
	require.True(t, os.IsNotExist(err), "record wrote the file synchronously")
	require.Eventually(t, func() bool { return loadTranscriptIndex(file, 50).len() == 20 }, 2*time.Second, 10*time.Millisecond)
	// one more change is written by flush at once (shutdown)
	idx.record("late", "/c/projects/p/late.jsonl", "/c")
	idx.flush()
	_, ok := loadTranscriptIndex(file, 50).lookup("late")
	require.True(t, ok)
}

// fakeHome points userHome at a temp dir with a ~/.claude/projects/<project>/ folder.
func fakeHome(t *testing.T) (string, string) {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-work-old")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	old := userHome
	userHome = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHome = old })
	return home, dir
}

func TestUnindexedEndedSessionIsFoundUnderProjects(t *testing.T) {
	_, dir := fakeHome(t)
	id := "0b5f3c2e-1111-4222-8333-444455556666"
	line := `{"type":"user","uuid":"u1","message":{"content":"before the upgrade"}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(line), 0o600))
	reg := indexedRegistry(t, filepath.Join(t.TempDir(), "transcripts.json"))
	pg, err := pageOf(t, reg, id)
	require.NoError(t, err)
	require.Len(t, pg.Events, 1)
	e, ok := reg.index.lookup(id) // the hit is remembered
	require.True(t, ok)
	require.Equal(t, filepath.Join(dir, id+".jsonl"), e.Path)

	// under the config dir of a live session too
	cfg, cdir := projectsDir(t)
	reg.Upsert(proto.SessionInfo{ID: "live", TranscriptPath: filepath.Join(cdir, "live.jsonl"), ConfigDir: cfg})
	id2 := "a1b2c3d4e5f6"
	require.NoError(t, os.WriteFile(filepath.Join(cdir, id2+".jsonl"), []byte(line), 0o600))
	_, err = pageOf(t, reg, id2)
	require.NoError(t, err)
}

func TestUnindexedLookupRefusesBadIDsAndEscapes(t *testing.T) {
	home, dir := fakeHome(t)
	reg := indexedRegistry(t, filepath.Join(t.TempDir(), "transcripts.json"))
	line := []byte(`{"type":"user","message":{"content":"secret"}}` + "\n")
	// a symlink in projects/ that points outside
	secret := filepath.Join(t.TempDir(), "secret.jsonl")
	require.NoError(t, os.WriteFile(secret, line, 0o600))
	require.NoError(t, os.Symlink(secret, filepath.Join(dir, "deadbeef-link.jsonl")))
	// two levels down is not looked at
	deep := filepath.Join(dir, "sub")
	require.NoError(t, os.MkdirAll(deep, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(deep, "deadbeef-deep.jsonl"), line, 0o600))
	// right in ~/.claude (not under projects/)
	require.NoError(t, os.WriteFile(filepath.Join(home, ".claude", "deadbeef-top.jsonl"), line, 0o600))
	for _, id := range []string{"deadbeef-link", "deadbeef-deep", "deadbeef-top", "short", "*", "../x/deadbeef", "dead*beef0", "deadbeef_x", ""} {
		_, err := pageOf(t, reg, id)
		require.Error(t, err, id)
		_, ok := reg.index.lookup(id)
		require.False(t, ok, id)
	}
}

func TestUnindexedMissIsRememberedForTenMinutes(t *testing.T) {
	_, dir := fakeHome(t)
	now := time.Now()
	oldNow := missNow
	missNow = func() time.Time { return now }
	t.Cleanup(func() { missNow = oldNow })
	reg := indexedRegistry(t, filepath.Join(t.TempDir(), "transcripts.json"))
	id := "0b5f3c2e-2222-4222-8333-444455556666"
	_, err := pageOf(t, reg, id)
	require.Error(t, err)
	line := `{"type":"user","uuid":"u1","message":{"content":"x"}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(line), 0o600))
	_, err = pageOf(t, reg, id) // still the remembered miss: no new search
	require.Error(t, err)
	now = now.Add(10*time.Minute + time.Second)
	_, err = pageOf(t, reg, id)
	require.NoError(t, err)
}
