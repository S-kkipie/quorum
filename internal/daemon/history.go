package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/S-kkipie/quorum/internal/daemon/transcript"
	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	defaultHistoryLimit = 200
	maxHistoryLimit     = 500
	// historyBudget bounds the serialized events of one page; the hub reads up to 8 MiB per message.
	historyBudget = 4 << 20
)

var (
	errNoSession    = errors.New("unknown session")
	errNoTranscript = errors.New("the session has no readable transcript")
	errBadCursor    = errors.New("invalid cursor")
)

// wrapTranscript wraps every transcript reader (tests count the bytes read through it).
var wrapTranscript = func(r io.ReaderAt) io.ReaderAt { return r }

func init() {
	rpcHandlers["transcript_page"] = rpcTranscriptPage
}

// projectRoots are the folders a transcript may live in: projects/ of the session's Claude
// config dir and of ~/.claude.
func projectRoots(configDir string) []string {
	var roots []string
	if filepath.IsAbs(configDir) {
		roots = append(roots, filepath.Join(configDir, "projects"))
	}
	if h, err := userHome(); err == nil && filepath.IsAbs(h) {
		roots = append(roots, filepath.Join(h, ".claude", "projects"))
	}
	return roots
}

// sessionIDRe is what a session id must look like to be searched for on disk (a UUID-like token).
var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// findTranscript looks for <configDir>/projects/*/<id>.jsonl (one directory level only) under the
// given config dirs and ~/.claude, for a session the daemon never indexed. The hit must resolve
// (symlinks followed) to a regular .jsonl file under a projects/ root.
func findTranscript(id string, configDirs []string) (path, configDir string, ok bool) {
	if !sessionIDRe.MatchString(id) {
		return "", "", false
	}
	var cands []string
	for _, d := range configDirs {
		if filepath.IsAbs(d) {
			cands = append(cands, d)
		}
	}
	if h, err := userHome(); err == nil && filepath.IsAbs(h) {
		cands = append(cands, filepath.Join(h, ".claude"))
	}
	for _, cd := range cands {
		matches, err := filepath.Glob(filepath.Join(cd, "projects", "*", id+".jsonl"))
		if err != nil {
			continue
		}
		for _, m := range matches {
			real, err := filepath.EvalSymlinks(m)
			if err != nil || !strings.HasSuffix(real, ".jsonl") || !underProjects(real, projectRoots(cd)) {
				continue
			}
			if st, err := os.Stat(real); err != nil || !st.Mode().IsRegular() {
				continue
			}
			return m, cd, true
		}
	}
	return "", "", false
}

// underProjects reports whether the resolved path lives below one of the (resolved) roots.
func underProjects(real string, roots []string) bool {
	for _, root := range roots {
		r, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if real != r && inside(r, real) {
			return true
		}
	}
	return false
}

// openTranscript opens the transcript the daemon knows for session (the live registry first,
// then the index of ended/renamed sessions; never a path from the caller). The path must be
// absolute, end in .jsonl, be a regular file and live under a Claude config dir's projects/.
func openTranscript(reg *Registry, session string) (*os.File, int64, error) {
	if reg == nil || session == "" {
		return nil, 0, errNoSession
	}
	path, configDir, found := reg.transcriptOf(session)
	if !found {
		return nil, 0, errNoSession
	}
	if path == "" || !filepath.IsAbs(path) || !strings.HasSuffix(path, ".jsonl") {
		return nil, 0, errNoTranscript
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || !strings.HasSuffix(real, ".jsonl") || !underProjects(real, projectRoots(configDir)) {
		return nil, 0, errNoTranscript
	}
	f, err := openNoFollow(real)
	if err != nil {
		return nil, 0, errNoTranscript
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, 0, errNoTranscript
	}
	return f, st.Size(), nil
}

// readPage reads one page of the session's transcript; cursor "" is the newest end.
func readPage(reg *Registry, session, cursor string, limit, budget int, beforeTS int64) (proto.TranscriptPage, error) {
	f, size, err := openTranscript(reg, session)
	if err != nil {
		return proto.TranscriptPage{}, err
	}
	defer f.Close()
	cur := transcript.Cursor{Off: size}
	if cursor != "" {
		c, err := transcript.ParseCursor(cursor)
		if err != nil {
			return proto.TranscriptPage{}, errBadCursor
		}
		cur = c
	}
	if size == 0 && cursor == "" {
		return proto.TranscriptPage{Events: []proto.Event{}, Done: true}, nil
	}
	pg, err := transcript.ReadPageBefore(wrapTranscript(f), size, cur, limit, budget, beforeTS)
	if errors.Is(err, transcript.ErrCursor) {
		return proto.TranscriptPage{}, errBadCursor
	}
	if err != nil {
		return proto.TranscriptPage{}, errCouldNotRead
	}
	out := proto.TranscriptPage{Events: pg.Events, Done: pg.Done}
	if out.Events == nil {
		out.Events = []proto.Event{}
	}
	if !pg.Done {
		out.Cursor = transcript.Cursor{Off: pg.Cursor, Skip: pg.Skip}.String()
	}
	return out, nil
}

// rpcTranscriptPage serves a page of a session's history, read backwards from its transcript.
// The cursor is opaque to callers: the byte offset where the previous page began ("s<offset>"
// inside an over-long line, see transcript.MaxScan).
func rpcTranscriptPage(ctx context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p proto.TranscriptPageParams
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	limit := p.Limit
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	if limit > maxHistoryLimit {
		limit = maxHistoryLimit
	}
	return readPage(linkOf(ctx).reg, p.Session, p.Cursor, limit, historyBudget, p.BeforeTS)
}
