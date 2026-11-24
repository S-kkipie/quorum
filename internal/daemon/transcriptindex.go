package daemon

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// maxIndexedTranscripts bounds the session id -> transcript map (LRU by last seen).
const maxIndexedTranscripts = 5000

// indexTouchEvery: an unchanged entry seen again is only rewritten to disk this often.
const indexTouchEvery = 10 * time.Minute

// indexSaveDelay debounces writes: record only marks the index dirty, and one write happens this
// long after the first change (a variable for tests).
var indexSaveDelay = time.Second

type indexEntry struct {
	Path      string `json:"path"`
	ConfigDir string `json:"configDir"`
	Seen      int64  `json:"seen"` // Unix ms, strictly increasing within one daemon
}

// transcriptIndex remembers the transcript of every session the daemon has seen, so that the
// history of ended and renamed sessions stays reachable (transcript_page). It is persisted as
// JSON in the daemon's config dir, rewritten atomically off the Upsert path (debounced, see
// indexSaveDelay; flush writes what is pending), and never shrinks on session end; only the LRU
// bound evicts.
type transcriptIndex struct {
	mu      sync.Mutex
	file    string // "" = memory only
	max     int
	entries map[string]indexEntry
	last    int64
	pending bool       // a write is scheduled
	saveMu  sync.Mutex // serializes writes of the file
}

type indexFile struct {
	Entries map[string]indexEntry `json:"entries"`
}

// loadTranscriptIndex reads file (missing or corrupt = empty) and bounds it to max entries.
func loadTranscriptIndex(file string, max int) *transcriptIndex {
	x := &transcriptIndex{file: file, max: max, entries: map[string]indexEntry{}}
	if file == "" {
		return x
	}
	if b, err := os.ReadFile(file); err == nil {
		var f indexFile
		if err := json.Unmarshal(b, &f); err != nil {
			log.Printf("quorumd: ignoring corrupt %s: %v", file, err)
		} else {
			for id, e := range f.Entries {
				if id != "" && e.Path != "" {
					x.entries[id] = e
					if e.Seen > x.last {
						x.last = e.Seen
					}
				}
			}
		}
	}
	x.evict()
	return x
}

func (x *transcriptIndex) len() int {
	x.mu.Lock()
	defer x.mu.Unlock()
	return len(x.entries)
}

func (x *transcriptIndex) lookup(id string) (indexEntry, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	e, ok := x.entries[id]
	return e, ok
}

// record maps id to its transcript; it writes the file when the entry is new or changed (or
// was last written more than indexTouchEvery ago).
func (x *transcriptIndex) record(id, path, configDir string) {
	if x == nil || id == "" || path == "" {
		return
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	now := time.Now().UnixMilli()
	if now <= x.last {
		now = x.last + 1
	}
	old, ok := x.entries[id]
	if ok && old.Path == path && old.ConfigDir == configDir && now-old.Seen < indexTouchEvery.Milliseconds() {
		return
	}
	x.last = now
	x.entries[id] = indexEntry{Path: path, ConfigDir: configDir, Seen: now}
	x.evict()
	if x.file != "" && !x.pending {
		x.pending = true
		time.AfterFunc(indexSaveDelay, x.flush)
	}
}

// flush writes the index now if a change is pending (the debounced write, and on shutdown).
func (x *transcriptIndex) flush() {
	if x == nil || x.file == "" {
		return
	}
	x.saveMu.Lock()
	defer x.saveMu.Unlock()
	x.mu.Lock()
	if !x.pending {
		x.mu.Unlock()
		return
	}
	x.pending = false
	b, err := json.Marshal(indexFile{Entries: x.entries})
	x.mu.Unlock()
	if err == nil {
		err = x.write(b)
	}
	if err != nil {
		log.Printf("quorumd: could not save %s: %v", x.file, err)
	}
}

// evict drops the least recently seen entries over max. Under mu (or before sharing).
func (x *transcriptIndex) evict() {
	if len(x.entries) <= x.max {
		return
	}
	ids := make([]string, 0, len(x.entries))
	for id := range x.entries {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return x.entries[ids[i]].Seen < x.entries[ids[j]].Seen })
	for _, id := range ids[:len(ids)-x.max] {
		delete(x.entries, id)
	}
}

// write stores b in the file atomically (temp file synced to disk, then renamed; 0600). Under saveMu.
func (x *transcriptIndex) write(b []byte) error {
	dir := filepath.Dir(x.file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "transcripts-*.tmp") // 0600
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), x.file)
}
