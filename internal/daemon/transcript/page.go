package transcript

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

// BlockSize is the size of each read ReadPage makes. Memory per page: one block, plus, for a
// line that spans blocks, its copied parts and their join (peak about 2x maxLine), plus the events.
const BlockSize = 1 << 20

// MaxScan bounds the bytes one page scans: a long run of lines without events (tool results)
// ends the page early, possibly empty and not done. A single line longer than that (it is over
// maxLine, so it would be skipped anyway) is crossed in bounded steps with skip cursors: if a
// page meets it after other lines, the page ends at that line's end; if the page starts with it,
// the page is empty, not done, and its cursor is a skip cursor at the point the scan stopped, so
// the next page discards the rest of that line before reading on. A variable for tests.
var MaxScan = 32 << 20

// ErrCursor is returned for a cursor outside (0, size] or not at the start of a line.
var ErrCursor = errors.New("invalid cursor")

// Page is a run of events, oldest first, that ends where the previous page (or the file) began.
// Cursor is the byte offset of its first line: the "before" of the next (older) page. Skip marks a
// cursor in the middle of an over-long line (see MaxScan). Done means the page reached the start
// of the file (Cursor is then 0).
type Page struct {
	Events []proto.Event
	Cursor int64
	Skip   bool
	Done   bool
}

// Cursor is where a page ends (exclusive). Off is a line start, or, with Skip, a point inside an
// over-long line whose remaining (older) bytes the page discards first.
type Cursor struct {
	Off  int64
	Skip bool
}

// String is the opaque form callers carry: "<offset>", or "s<offset>" for a skip cursor.
func (c Cursor) String() string {
	s := strconv.FormatInt(c.Off, 10)
	if c.Skip {
		return "s" + s
	}
	return s
}

// ParseCursor parses Cursor.String (decimal digits only); ranges are checked by ReadPageAt.
func ParseCursor(s string) (Cursor, error) {
	var c Cursor
	if strings.HasPrefix(s, "s") {
		c.Skip, s = true, s[1:]
	}
	if s == "" || len(s) > 19 {
		return Cursor{}, ErrCursor
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return Cursor{}, ErrCursor
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return Cursor{}, ErrCursor
	}
	c.Off = n
	return c, nil
}

// ReadPage reads the transcript backwards from before (a byte offset at a line start, or size)
// and returns the newest whole lines before it that yield at least limit events, or as many as
// fit in budget serialized bytes (the newest first), or as many as MaxScan bytes allow. Lines
// are never split across pages, so walking cursors to Done yields every event exactly once.
// Malformed lines and lines over maxLine are skipped.
func ReadPage(r io.ReaderAt, size, before int64, limit, budget int) (Page, error) {
	return ReadPageAt(r, size, Cursor{Off: before}, limit, budget)
}

// ReadPageAt is ReadPage from a cursor that may be a skip cursor.
func ReadPageAt(r io.ReaderAt, size int64, cur Cursor, limit, budget int) (Page, error) {
	return ReadPageBefore(r, size, cur, limit, budget, 0)
}

// ReadPageBefore is ReadPageAt that drops events with ts >= beforeTS (when beforeTS > 0) without
// counting them toward limit or budget; the scan stays bounded by MaxScan.
func ReadPageBefore(r io.ReaderAt, size int64, cur Cursor, limit, budget int, beforeTS int64) (Page, error) {
	before := cur.Off
	if before <= 0 || before > size {
		return Page{}, ErrCursor
	}
	rr := &revReader{r: r}
	end := before
	if cur.Skip {
		// discard what is left of the over-long line, unless the cursor is right after a newline
		if b, err := rr.byteAt(before - 1); err != nil {
			return Page{}, err
		} else if b != '\n' {
			start, _, capped, err := rr.prevLine(before, true)
			if err != nil {
				return Page{}, err
			}
			if capped {
				return Page{Events: []proto.Event{}, Cursor: start, Skip: true}, nil
			}
			end = start
		}
	} else if before < size {
		var b [1]byte
		if _, err := r.ReadAt(b[:], before-1); err != nil {
			return Page{}, err
		}
		if b[0] != '\n' {
			return Page{}, ErrCursor
		}
	}
	var groups [][]proto.Event // newest first
	n, used := 0, 0
	for end > 0 {
		start, raw, capped, err := rr.prevLine(end, false)
		if err != nil {
			return Page{}, err
		}
		if capped {
			if len(groups) > 0 {
				break // the page ends at this line's end; the next page starts with it
			}
			return Page{Events: []proto.Event{}, Cursor: start, Skip: true}, nil
		}
		evs := parseLine(raw, start)
		if beforeTS > 0 {
			kept := evs[:0]
			for _, e := range evs {
				if e.TS < beforeTS {
					kept = append(kept, e)
				}
			}
			evs = kept
		}
		cost := 0
		for i := range evs {
			b, _ := json.Marshal(evs[i])
			cost += len(b) + 1
		}
		if used+cost > budget {
			if used > 0 {
				break // this line opens the next page
			}
			// a single line over budget: keep its newest events that fit
			evs, cost = fitNewest(evs, budget)
		}
		groups = append(groups, evs)
		n += len(evs)
		used += cost
		end = start
		if (limit > 0 && n >= limit) || rr.scanned >= int64(MaxScan) {
			break
		}
	}
	out := make([]proto.Event, 0, n)
	for i := len(groups) - 1; i >= 0; i-- {
		out = append(out, groups[i]...)
	}
	return Page{Events: out, Cursor: end, Done: end == 0}, nil
}

func fitNewest(evs []proto.Event, budget int) ([]proto.Event, int) {
	used := 0
	i := len(evs)
	for i > 0 {
		b, _ := json.Marshal(evs[i-1])
		if used+len(b)+1 > budget {
			break
		}
		used += len(b) + 1
		i--
	}
	return evs[i:], used
}

// revReader serves lines backwards from one cached block of at most BlockSize bytes.
type revReader struct {
	r       io.ReaderAt
	blk     []byte
	blkOff  int64 // blk covers [blkOff, blkOff+len(blk))
	buf     []byte
	scanned int64
}

// load reads the block that ends at p (exclusive).
func (rr *revReader) load(p int64) error {
	off := p - BlockSize
	if off < 0 {
		off = 0
	}
	if cap(rr.buf) < BlockSize {
		rr.buf = make([]byte, BlockSize)
	}
	b := rr.buf[:p-off]
	got, err := rr.r.ReadAt(b, off)
	if got < len(b) {
		if err == nil || errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return err
	}
	rr.blk, rr.blkOff = b, off
	rr.scanned += int64(len(b))
	return nil
}

// prevLine returns the line that ends at end (exclusive; a trailing '\n' is dropped) and its
// start offset. The slice is valid until the next call; nil when the line is over maxLine or
// discard is set. When MaxScan is reached before the line's start, capped is true and the
// offset is where the scan stopped.
func (rr *revReader) prevLine(end int64, discard bool) (int64, []byte, bool, error) {
	p := end
	if b, err := rr.byteAt(p - 1); err != nil {
		return 0, nil, false, err
	} else if b == '\n' && !discard {
		p--
	}
	var parts [][]byte // copies, newest first, when the line spans blocks
	total := 0
	tooBig := discard
	for p > 0 {
		if p <= rr.blkOff || p > rr.blkOff+int64(len(rr.blk)) {
			if rr.scanned >= int64(MaxScan) {
				return p, nil, true, nil
			}
			if err := rr.load(p); err != nil {
				return 0, nil, false, err
			}
		}
		seg := rr.blk[:p-rr.blkOff]
		if i := bytes.LastIndexByte(seg, '\n'); i >= 0 {
			start := rr.blkOff + int64(i) + 1
			seg = seg[i+1:]
			if tooBig || total+len(seg) > maxLine {
				return start, nil, false, nil
			}
			if parts == nil {
				return start, seg, false, nil
			}
			return start, join(seg, parts), false, nil
		}
		if !tooBig {
			total += len(seg)
			if total > maxLine {
				tooBig, parts = true, nil
			} else {
				parts = append(parts, append([]byte(nil), seg...))
			}
		}
		p = rr.blkOff
	}
	if tooBig || len(parts) == 0 {
		return 0, nil, false, nil
	}
	return 0, join(nil, parts), false, nil
}

func (rr *revReader) byteAt(p int64) (byte, error) {
	if p < rr.blkOff || p >= rr.blkOff+int64(len(rr.blk)) {
		if err := rr.load(p + 1); err != nil {
			return 0, err
		}
	}
	return rr.blk[p-rr.blkOff], nil
}

// join builds head + parts (newest first) in file order.
func join(head []byte, parts [][]byte) []byte {
	n := len(head)
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	out = append(out, head...)
	for i := len(parts) - 1; i >= 0; i-- {
		out = append(out, parts[i]...)
	}
	return out
}
