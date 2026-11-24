package transcript

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
)

// countingReaderAt records every ReadAt: the largest single read and the total bytes read.
type countingReaderAt struct {
	r       io.ReaderAt
	mu      sync.Mutex
	maxRead int
	total   int64
	reads   int
}

func (c *countingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	c.mu.Lock()
	if len(p) > c.maxRead {
		c.maxRead = len(p)
	}
	c.reads++
	c.mu.Unlock()
	n, err := c.r.ReadAt(p, off)
	c.mu.Lock()
	c.total += int64(n)
	c.mu.Unlock()
	return n, err
}

// synthTranscript writes a synthetic JSONL of n lines to a temp file and returns its path and the
// number of compact markers it holds. Lines: user text, assistant text + tool_use, tool results
// (no events), garbage, compact boundaries and their summary rows, sidechain rows.
func synthTranscript(t *testing.T, n int) (string, int) {
	t.Helper()
	var sb strings.Builder
	compacts := 0
	for i := 0; i < n; i++ {
		ts := fmt.Sprintf("2026-01-02T03:%02d:%02d.000Z", (i/60)%60, i%60)
		uuid := fmt.Sprintf("u-%06d", i)
		switch {
		case i%5000 == 4999:
			compacts++
			trig := "auto"
			if compacts%2 == 0 {
				trig = "manual"
			}
			fmt.Fprintf(&sb, `{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","isMeta":false,"timestamp":%q,"uuid":%q,"compactMetadata":{"trigger":%q,"preTokens":%d}}`+"\n", ts, uuid, trig, 150000+i)
		case i%5000 == 0 && i > 0:
			fmt.Fprintf(&sb, `{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"timestamp":%q,"uuid":%q,"message":{"role":"user","content":"This session is being continued from a previous conversation."}}`+"\n", ts, uuid)
		case i%97 == 0:
			sb.WriteString("garbage {not json\n")
		case i%41 == 0:
			fmt.Fprintf(&sb, `{"type":"assistant","isSidechain":true,"timestamp":%q,"uuid":%q,"message":{"content":"side"}}`+"\n", ts, uuid)
		case i%3 == 0:
			fmt.Fprintf(&sb, `{"type":"user","timestamp":%q,"uuid":%q,"message":{"role":"user","content":"prompt %d"}}`+"\n", ts, uuid, i)
		case i%3 == 1:
			fmt.Fprintf(&sb, `{"type":"assistant","timestamp":%q,"uuid":%q,"message":{"role":"assistant","content":[{"type":"text","text":"answer %d"},{"type":"tool_use","id":"tu%d","name":"Bash","input":{"command":"echo %d"}}]}}`+"\n", ts, uuid, i, i, i)
		default:
			fmt.Fprintf(&sb, `{"type":"user","timestamp":%q,"uuid":%q,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu%d","content":"%s"}]}}`+"\n", ts, uuid, i-1, strings.Repeat("x", 200))
		}
	}
	p := filepath.Join(t.TempDir(), "synthetic.jsonl")
	if err := os.WriteFile(p, []byte(sb.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return p, compacts
}

func openCounting(t *testing.T, p string) (*countingReaderAt, int64) {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	st, _ := f.Stat()
	return &countingReaderAt{r: f}, st.Size()
}

func TestReadPageFirstPageIsNewest(t *testing.T) {
	p, _ := synthTranscript(t, 50_000)
	all, err := forwardParse(t, p)
	if err != nil {
		t.Fatal(err)
	}
	r, size := openCounting(t, p)
	pg, err := ReadPage(r, size, size, 100, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(pg.Events) < 100 || len(pg.Events) > 101 || pg.Done || pg.Cursor <= 0 || pg.Cursor >= size {
		t.Fatalf("events=%d done=%v cursor=%d size=%d", len(pg.Events), pg.Done, pg.Cursor, size)
	}
	tail := all[len(all)-len(pg.Events):]
	for i := range tail {
		if tail[i].Key != pg.Events[i].Key || !bytes.Equal(tail[i].Data, pg.Events[i].Data) {
			t.Fatalf("event %d: %+v != %+v", i, pg.Events[i], tail[i])
		}
	}
	// memory bounded: reads are at most one block, and the first page reads only the tail
	if r.maxRead > BlockSize || BlockSize > 1<<20 {
		t.Fatalf("largest read %d (block %d)", r.maxRead, BlockSize)
	}
	if r.total > 2*int64(BlockSize) {
		t.Fatalf("first page read %d bytes of %d", r.total, size)
	}
}

// forwardParse is the forward reference: every event of the file, in order.
func forwardParse(t *testing.T, p string) ([]proto.Event, error) {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Parse(f, 0)
}

func TestReadPageWalkYieldsEveryEventOnce(t *testing.T) {
	p, compacts := synthTranscript(t, 50_000)
	all, err := forwardParse(t, p)
	if err != nil {
		t.Fatal(err)
	}
	r, size := openCounting(t, p)
	var pages [][]proto.Event
	cursor := size
	for i := 0; ; i++ {
		if i > 10_000 {
			t.Fatal("did not finish")
		}
		pg, err := ReadPage(r, size, cursor, 250, 4<<20)
		if err != nil {
			t.Fatal(err)
		}
		pages = append(pages, pg.Events)
		if pg.Done {
			if pg.Cursor != 0 {
				t.Fatalf("done with cursor %d", pg.Cursor)
			}
			break
		}
		if pg.Cursor >= cursor {
			t.Fatalf("cursor did not move back: %d -> %d", cursor, pg.Cursor)
		}
		cursor = pg.Cursor
	}
	var got []proto.Event
	for i := len(pages) - 1; i >= 0; i-- {
		got = append(got, pages[i]...)
	}
	if len(got) != len(all) {
		t.Fatalf("walked %d events, file has %d", len(got), len(all))
	}
	seen := map[string]bool{}
	nCompact := 0
	for i := range got {
		if got[i].Key == "" || seen[got[i].Key] {
			t.Fatalf("event %d key %q empty or repeated", i, got[i].Key)
		}
		seen[got[i].Key] = true
		if got[i].Key != all[i].Key || got[i].Kind != all[i].Kind || !bytes.Equal(got[i].Data, all[i].Data) {
			t.Fatalf("event %d: %+v != %+v", i, got[i], all[i])
		}
		if got[i].Kind == proto.KindCompact {
			nCompact++
		}
		if got[i].Kind == proto.KindUser && strings.Contains(string(got[i].Data), "continued from a previous") {
			t.Fatalf("compact summary row shown as a user prompt: %s", got[i].Data)
		}
	}
	if nCompact != compacts || compacts == 0 {
		t.Fatalf("compact events %d, markers %d", nCompact, compacts)
	}
	if r.maxRead > BlockSize {
		t.Fatalf("largest read %d", r.maxRead)
	}
}

func TestCompactBoundaryMapsToCompactEvent(t *testing.T) {
	in := `{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","isMeta":false,"timestamp":"2026-01-02T03:04:05.678Z","uuid":"c1","compactMetadata":{"trigger":"manual","preTokens":123456}}
{"type":"user","isCompactSummary":true,"uuid":"c2","message":{"content":"This session is being continued from a previous conversation."}}
{"type":"system","subtype":"compact_boundary","uuid":"c3"}
{"type":"system","subtype":"local_command","uuid":"c4","content":"x"}
`
	evs, err := Parse(strings.NewReader(in), 0)
	if err != nil || len(evs) != 2 {
		t.Fatalf("evs=%+v err=%v", evs, err)
	}
	var c proto.CompactInfo
	json.Unmarshal(evs[0].Data, &c)
	if evs[0].Kind != proto.KindCompact || c.Trigger != "manual" || c.PreTokens == nil || *c.PreTokens != 123456 || c.At != 1767323045678 || evs[0].TS != c.At || evs[0].Key != "c1/0" {
		t.Fatalf("compact = %+v %+v", evs[0], c)
	}
	var c2 proto.CompactInfo
	json.Unmarshal(evs[1].Data, &c2)
	if c2.Trigger != "auto" || c2.PreTokens != nil || evs[1].Key != "c3/0" || strings.Contains(string(evs[1].Data), `"at"`) {
		t.Fatalf("compact without metadata or timestamp = %s", evs[1].Data)
	}
}

func TestReadPageMalformedAndOddLines(t *testing.T) {
	big := strings.Repeat("é", 1_500_000) // a 3 MB line spans several blocks
	in := "garbage\n" +
		`{"type":"user","uuid":"a","message":{"content":"one"}}` + "\n" +
		"\n\n{broken\n" +
		`{"type":"assistant","uuid":"b","message":{"content":"` + big + `"}}` + "\n" +
		`{"type":"user","message":{"content":"no uuid"}}` + "\n" +
		`{"type":"user","uuid":"c","message":{"content":"partial` // unterminated tail
	r := &countingReaderAt{r: strings.NewReader(in)}
	size := int64(len(in))
	pg, err := ReadPage(r, size, size, 100, 4<<20)
	if err != nil || !pg.Done || pg.Cursor != 0 || len(pg.Events) != 3 {
		t.Fatalf("pg=%+v err=%v", pg, err)
	}
	if pg.Events[0].Key != "a/0" || pg.Events[1].Key != "b/0" {
		t.Fatalf("keys %q %q", pg.Events[0].Key, pg.Events[1].Key)
	}
	var d map[string]string
	json.Unmarshal(pg.Events[1].Data, &d)
	if !strings.HasPrefix(d["text"], "éé") || !strings.HasSuffix(d["text"], "…") {
		t.Fatalf("line across blocks parsed wrong: %.40q", d["text"])
	}
	want := fmt.Sprintf("@%d/0", strings.Index(in, `{"type":"user","message":{"content":"no uuid"}}`))
	if pg.Events[2].Key != want {
		t.Fatalf("offset key %q, want %q", pg.Events[2].Key, want)
	}
	if r.maxRead > BlockSize {
		t.Fatalf("largest read %d", r.maxRead)
	}
}

func TestReadPageCursorValidation(t *testing.T) {
	in := `{"type":"user","uuid":"a","message":{"content":"one"}}` + "\n" + `{"type":"user","uuid":"b","message":{"content":"two"}}` + "\n"
	r := strings.NewReader(in)
	size := int64(len(in))
	for _, c := range []int64{-1, 0, size + 1, 5} { // 5: not at a line start
		if _, err := ReadPage(r, size, c, 10, 4<<20); err != ErrCursor {
			t.Fatalf("cursor %d: err=%v", c, err)
		}
	}
	pg, err := ReadPage(r, size, size, 1, 4<<20)
	if err != nil || pg.Done || len(pg.Events) != 1 || pg.Events[0].Key != "b/0" {
		t.Fatalf("pg=%+v err=%v", pg, err)
	}
	pg, err = ReadPage(r, size, pg.Cursor, 1, 4<<20)
	if err != nil || !pg.Done || len(pg.Events) != 1 || pg.Events[0].Key != "a/0" {
		t.Fatalf("pg=%+v err=%v", pg, err)
	}
}

func TestReadPageRespectsByteBudget(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 400; i++ {
		fmt.Fprintf(&sb, `{"type":"user","uuid":"u%d","message":{"content":"%s"}}`+"\n", i, strings.Repeat("y", 10_000))
	}
	in := sb.String()
	size := int64(len(in))
	pg, err := ReadPage(strings.NewReader(in), size, size, 400, 1<<20)
	if err != nil || pg.Done {
		t.Fatalf("pg done=%v err=%v", pg.Done, err)
	}
	b, _ := json.Marshal(pg.Events)
	if len(b) > 1<<20 || len(pg.Events) == 0 {
		t.Fatalf("page %d bytes, %d events", len(b), len(pg.Events))
	}
}

func TestReadPageBoundsBytesScanned(t *testing.T) {
	// a long run of lines with no events: a page stops at MaxScan without being done
	old := MaxScan
	MaxScan = 2 << 20
	defer func() { MaxScan = old }()
	var sb strings.Builder
	sb.WriteString(`{"type":"user","uuid":"first","message":{"content":"hi"}}` + "\n")
	filler := `{"type":"user","message":{"content":[{"type":"tool_result","content":"` + strings.Repeat("z", 4000) + `"}]}}` + "\n"
	for sb.Len() < 3*MaxScan {
		sb.WriteString(filler)
	}
	in := sb.String()
	r := &countingReaderAt{r: strings.NewReader(in)}
	size := int64(len(in))
	pg, err := ReadPage(r, size, size, 10, 4<<20)
	if err != nil || pg.Done || len(pg.Events) != 0 || pg.Cursor <= 0 {
		t.Fatalf("events=%d done=%v cursor=%d err=%v", len(pg.Events), pg.Done, pg.Cursor, err)
	}
	if r.total > int64(MaxScan)+2*int64(BlockSize) {
		t.Fatalf("scanned %d bytes, max %d", r.total, MaxScan)
	}
}

func TestReadPageHugeLineOverMaxScan(t *testing.T) {
	old := MaxScan
	MaxScan = 2 << 20
	defer func() { MaxScan = old }()
	huge := `{"type":"user","uuid":"h","message":{"content":"` + strings.Repeat("q", 7<<20) + `"}}` + "\n"
	in := `{"type":"user","uuid":"a","message":{"content":"first"}}` + "\n" + huge +
		`{"type":"user","uuid":"c","message":{"content":"last"}}` + "\n"
	size := int64(len(in))
	var keys []string
	cur := Cursor{Off: size}
	pages := 0
	for {
		pages++
		if pages > 100 {
			t.Fatal("did not finish")
		}
		r := &countingReaderAt{r: strings.NewReader(in)}
		pg, err := ReadPageAt(r, size, cur, 10, 4<<20)
		if err != nil {
			t.Fatal(err)
		}
		if r.total > int64(MaxScan)+2*int64(BlockSize) {
			t.Fatalf("page %d scanned %d bytes", pages, r.total)
		}
		for i := len(pg.Events) - 1; i >= 0; i-- {
			keys = append([]string{pg.Events[i].Key}, keys...)
		}
		if pg.Done {
			break
		}
		next := Cursor{Off: pg.Cursor, Skip: pg.Skip}
		if next.Off >= cur.Off && !(next.Off == cur.Off && next.Skip && !cur.Skip) {
			t.Fatalf("no progress: %+v -> %+v", cur, next)
		}
		cur = next
		// the cursor survives its string form
		back, err := ParseCursor(cur.String())
		if err != nil || back != cur {
			t.Fatalf("cursor %+v -> %q -> %+v %v", cur, cur.String(), back, err)
		}
	}
	if strings.Join(keys, ",") != "a/0,c/0" {
		t.Fatalf("keys %v", keys)
	}
	if pages < 3 {
		t.Fatalf("pages %d: the huge line was not skipped in bounded steps", pages)
	}
}

func TestParseCursor(t *testing.T) {
	for _, bad := range []string{"", "x", "-1", "1e3", "s", "s-2", "12s"} {
		if _, err := ParseCursor(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if c, err := ParseCursor("42"); err != nil || c != (Cursor{Off: 42}) {
		t.Fatalf("%+v %v", c, err)
	}
	if c, err := ParseCursor("s42"); err != nil || c != (Cursor{Off: 42, Skip: true}) {
		t.Fatalf("%+v %v", c, err)
	}
}
