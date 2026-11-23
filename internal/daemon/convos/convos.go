// Package convos lists the previous Claude Code conversations of a
// project folder, reading the JSONL files in ~/.claude/projects.
package convos

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/S-kkipie/quorum/internal/daemon/transcript"
	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	maxFile      = 200 << 20 // larger files are ignored
	maxLine      = 1 << 20   // longer lines are skipped
	maxTitle     = 80        // runes of the title taken from the first prompt
	maxPrompt    = 500       // runes of FirstPrompt (bounds the response size)
	maxCacheSize = 4096
)

// Dir is the folder where Claude Code stores the conversations of root:
// ~/.claude/projects/<root with every non-[A-Za-z0-9] character replaced by '-'>.
// Like Claude Code, it replaces characters (not bytes): "é" yields a single '-'.
func Dir(home, root string) string {
	var sb strings.Builder
	for _, r := range root {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			sb.WriteRune(r)
		} else {
			sb.WriteByte('-')
		}
	}
	return filepath.Join(home, ".claude", "projects", sb.String())
}

type cacheKey struct {
	path  string
	size  int64
	mtime int64
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cached{} // by path
)

type cached struct {
	key cacheKey
	c   proto.Conversation
}

// List returns at most max conversations from dir, most recent first
// (by mtime). Those with no messages are omitted. live marks the ones
// currently open. If dir does not exist it returns an empty list without error.
func List(dir string, live map[string]bool, max int) ([]proto.Conversation, error) {
	out := []proto.Conversation{}
	ents, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	type file struct {
		path string
		info fs.FileInfo
	}
	var files []file
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".jsonl") || !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() > maxFile {
			continue
		}
		files = append(files, file{filepath.Join(dir, e.Name()), info})
	}
	sort.Slice(files, func(i, j int) bool {
		a, b := files[i].info.ModTime(), files[j].info.ModTime()
		if !a.Equal(b) {
			return a.After(b)
		}
		return files[i].path < files[j].path
	})
	for _, f := range files {
		if max > 0 && len(out) >= max {
			break
		}
		c, ok := load(f.path, f.info)
		if !ok || c.Messages == 0 {
			continue
		}
		c.Open = live[c.ID]
		out = append(out, c)
	}
	return out, nil
}

// load reads (or takes from the cache) the conversation at path.
func load(path string, info fs.FileInfo) (proto.Conversation, bool) {
	key := cacheKey{path, info.Size(), info.ModTime().UnixNano()}
	cacheMu.Lock()
	if e, ok := cache[path]; ok && e.key == key {
		cacheMu.Unlock()
		return e.c, true
	}
	cacheMu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		return proto.Conversation{}, false
	}
	defer f.Close()
	c, err := parse(f)
	if err != nil {
		return proto.Conversation{}, false
	}
	c.ID = strings.TrimSuffix(filepath.Base(path), ".jsonl")
	c.UpdatedAt = info.ModTime().UnixMilli()

	cacheMu.Lock()
	if len(cache) >= maxCacheSize {
		cache = map[string]cached{} // simple cap: empty it and refill
	}
	cache[path] = cached{key, c}
	cacheMu.Unlock()
	return c, true
}

type block struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type line struct {
	Type        string `json:"type"`
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	AITitle     string `json:"aiTitle"`
	CustomTitle string `json:"customTitle"`
	Summary     string `json:"summary"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// parse builds the conversation (without ID or dates) from the JSONL.
func parse(r io.Reader) (proto.Conversation, error) {
	var c proto.Conversation
	var custom, ai, summary string
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		raw, err := readLine(br)
		if len(raw) > 0 {
			var l line
			if json.Unmarshal(raw, &l) == nil {
				switch l.Type {
				case "custom-title":
					custom = pick(custom, l.CustomTitle)
				case "ai-title":
					ai = pick(ai, l.AITitle)
				case "summary":
					summary = pick(summary, l.Summary)
				case "user", "assistant":
					if l.IsMeta || l.IsSidechain {
						break
					}
					if hasText(l.Type, l.Message.Content) {
						c.Messages++
					}
					if l.Type == "user" && c.FirstPrompt == "" {
						var s string
						if json.Unmarshal(l.Message.Content, &s) == nil && strings.TrimSpace(s) != "" && !transcript.SkipUserText(s) {
							c.FirstPrompt = clipRunes(strings.TrimSpace(s), maxPrompt)
						}
					}
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return c, err
		}
	}
	switch {
	case custom != "":
		c.Title = custom
	case ai != "":
		c.Title = ai
	case summary != "":
		c.Title = summary
	default:
		c.Title = clipRunes(strings.Join(strings.Fields(c.FirstPrompt), " "), maxTitle)
	}
	return c, nil
}

// pick keeps the last non-empty value (a new title replaces the previous one).
func pick(cur, v string) string {
	if v = strings.TrimSpace(v); v != "" {
		return v
	}
	return cur
}

// hasText reports whether the content of a user/assistant line carries real text.
func hasText(typ string, content json.RawMessage) bool {
	ok := func(s string) bool {
		return strings.TrimSpace(s) != "" && (typ != "user" || !transcript.SkipUserText(s))
	}
	var s string
	if json.Unmarshal(content, &s) == nil {
		return ok(s)
	}
	var blocks []block
	if json.Unmarshal(content, &blocks) != nil {
		return false
	}
	for _, b := range blocks {
		if b.Type == "text" && ok(b.Text) {
			return true
		}
	}
	return false
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n]))
}

// readLine reads a whole line; returns empty for lines that exceed maxLine.
func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	tooBig := false
	for {
		chunk, err := br.ReadSlice('\n')
		if !tooBig {
			buf = append(buf, chunk...)
			if len(buf) > maxLine {
				tooBig, buf = true, nil
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if tooBig {
			return nil, err
		}
		return buf, err
	}
}
