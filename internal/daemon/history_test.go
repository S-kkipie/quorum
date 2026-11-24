package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// projectsDir makes a fake Claude config dir and returns it and a project folder inside its projects/.
func projectsDir(t *testing.T) (string, string) {
	t.Helper()
	cfg := t.TempDir()
	dir := filepath.Join(cfg, "projects", "-work-demo")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	return cfg, dir
}

// writeSynthetic writes n synthetic user/assistant lines (plus one compact boundary) to a temp
// transcript and returns its path.
func writeSynthetic(t *testing.T, n int, pad int) (string, string) {
	t.Helper()
	var sb strings.Builder
	for i := 0; i < n; i++ {
		if i == n/2 {
			fmt.Fprintf(&sb, `{"type":"system","subtype":"compact_boundary","uuid":"cb","timestamp":"2026-01-02T03:04:05Z","compactMetadata":{"trigger":"auto","preTokens":170000}}`+"\n")
		}
		fmt.Fprintf(&sb, `{"type":"user","uuid":"u%d","timestamp":"2026-01-02T03:04:05Z","message":{"content":"msg %d %s"}}`+"\n", i, i, strings.Repeat("p", pad))
	}
	cfg, dir := projectsDir(t)
	p := filepath.Join(dir, "s.jsonl")
	require.NoError(t, os.WriteFile(p, []byte(sb.String()), 0o600))
	return cfg, p
}

func TestTranscriptPageRPCWalksToStart(t *testing.T) {
	cfg, tp := writeSynthetic(t, 5000, 0)
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	ctx := linkCtx(t)
	var all []proto.Event
	cursor := ""
	for i := 0; ; i++ {
		require.Less(t, i, 1000)
		raw, err := call(t, ctx, nil, reg, "transcript_page", proto.TranscriptPageParams{Session: "s1", Cursor: cursor, Limit: 300})
		require.NoError(t, err)
		var pg proto.TranscriptPage
		require.NoError(t, json.Unmarshal(raw, &pg))
		if i == 0 {
			require.Len(t, pg.Events, 300)
			require.Equal(t, "u4999/0", pg.Events[len(pg.Events)-1].Key)
		}
		all = append(pg.Events, all...)
		if pg.Done {
			require.Empty(t, pg.Cursor)
			break
		}
		require.NotEmpty(t, pg.Cursor)
		cursor = pg.Cursor
	}
	require.Len(t, all, 5001)
	require.Equal(t, "u0/0", all[0].Key)
	require.Equal(t, proto.KindCompact, all[2500].Kind)
	var c proto.CompactInfo
	require.NoError(t, json.Unmarshal(all[2500].Data, &c))
	require.Equal(t, "auto", c.Trigger)
	require.EqualValues(t, 170000, *c.PreTokens)
}

func TestTranscriptPageRPCRejects(t *testing.T) {
	cfg, tp := writeSynthetic(t, 10, 0)
	st, _ := os.Stat(tp)
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	reg.Upsert(proto.SessionInfo{ID: "rel", TranscriptPath: "rel.jsonl"})
	reg.Upsert(proto.SessionInfo{ID: "dir", TranscriptPath: filepath.Dir(tp), ConfigDir: cfg})
	outside := filepath.Join(t.TempDir(), "x.jsonl") // a real transcript, but not under projects/
	require.NoError(t, os.WriteFile(outside, []byte(`{"type":"user","message":{"content":"x"}}`+"\n"), 0o600))
	reg.Upsert(proto.SessionInfo{ID: "outside", TranscriptPath: outside, ConfigDir: cfg})
	reg.Upsert(proto.SessionInfo{ID: "outside2", TranscriptPath: outside, ConfigDir: filepath.Dir(outside)})
	ctx := linkCtx(t)
	for _, tc := range []proto.TranscriptPageParams{
		{Session: "missing"},
		{Session: ""},
		{Session: "rel"},
		{Session: "dir"},
		{Session: "outside"},
		{Session: "outside2"}, // the file sits in the config dir itself, not in its projects/
		{Session: "s1", Cursor: "abc"},
		{Session: "s1", Cursor: "-1"},
		{Session: "s1", Cursor: "0"},
		{Session: "s1", Cursor: "3"}, // not at a line start
		{Session: "s1", Cursor: fmt.Sprint(st.Size() + 1)},
		{Session: "s1", Cursor: "1e3"},
		{Session: "s1", Cursor: "+5"},
		{Session: "s1", Cursor: "s0"},
	} {
		_, err := call(t, ctx, nil, reg, "transcript_page", tc)
		require.Error(t, err, "%+v", tc)
	}
	// no registry on the call (not from a hub link): an error, not a panic
	p, _ := json.Marshal(proto.TranscriptPageParams{Session: "s1"})
	_, err := rpcTranscriptPage(context.Background(), nil, p)
	require.Error(t, err)
}

func TestTranscriptPageRPCFitsMessageBudget(t *testing.T) {
	cfg, tp := writeSynthetic(t, 2000, 15_000) // ~30 MB, 15 KB per event
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	raw, err := call(t, linkCtx(t), nil, reg, "transcript_page", proto.TranscriptPageParams{Session: "s1", Limit: 100_000})
	require.NoError(t, err)
	require.LessOrEqual(t, len(raw), historyBudget+1024)
	var pg proto.TranscriptPage
	require.NoError(t, json.Unmarshal(raw, &pg))
	require.NotEmpty(t, pg.Events)
	require.LessOrEqual(t, len(pg.Events), maxHistoryLimit)
	require.False(t, pg.Done)
}

// countingAt counts the bytes read through it.
type countingAt struct {
	r io.ReaderAt
	n *atomic.Int64
}

func (c countingAt) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.r.ReadAt(p, off)
	c.n.Add(int64(n))
	return n, err
}

func TestBackfillReadsOnlyTheTail(t *testing.T) {
	cfg, tp := writeSynthetic(t, 60_000, 300) // ~20 MB
	st, _ := os.Stat(tp)
	var read atomic.Int64
	old := wrapTranscript
	wrapTranscript = func(r io.ReaderAt) io.ReaderAt { return countingAt{r, &read} }
	t.Cleanup(func() { wrapTranscript = old })
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	for len(reg.Out()) > 0 {
		<-reg.Out()
	}
	go backfill(reg, "s1")
	select {
	case env := <-reg.Out():
		var evs []proto.Event
		require.NoError(t, json.Unmarshal(env.Payload, &evs))
		require.Len(t, evs, backfillLimit)
		require.Equal(t, "u59999/0", evs[len(evs)-1].Key)
	case <-time.After(5 * time.Second):
		t.Fatal("no backfill")
	}
	require.Less(t, read.Load(), int64(2<<20), "read %d of %d bytes", read.Load(), st.Size())
}

func TestTranscriptPageSkipsWhatTheHubHolds(t *testing.T) {
	// 2,100 events one second apart; the hub holds the newest 2,000 (ts >= beforeTs).
	base := time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC)
	var sb strings.Builder
	for i := 0; i < 2100; i++ {
		fmt.Fprintf(&sb, `{"type":"user","uuid":"u%d","timestamp":"%s","message":{"content":"msg %d"}}`+"\n", i, base.Add(time.Duration(i)*time.Second).Format(time.RFC3339), i)
	}
	cfg, dir := projectsDir(t)
	tp := filepath.Join(dir, "s.jsonl")
	require.NoError(t, os.WriteFile(tp, []byte(sb.String()), 0o600))
	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", TranscriptPath: tp, ConfigDir: cfg})
	before := base.Add(100 * time.Second).UnixMilli()
	raw, err := call(t, linkCtx(t), nil, reg, "transcript_page", proto.TranscriptPageParams{Session: "s1", Limit: 50, BeforeTS: before})
	require.NoError(t, err)
	var pg proto.TranscriptPage
	require.NoError(t, json.Unmarshal(raw, &pg))
	require.Len(t, pg.Events, 50)
	require.Equal(t, "u99/0", pg.Events[49].Key)
	require.Equal(t, "u50/0", pg.Events[0].Key)
	for _, e := range pg.Events {
		require.Less(t, e.TS, before)
	}
	require.False(t, pg.Done)
}
