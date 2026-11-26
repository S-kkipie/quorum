package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// taskTailMax is the most bytes of a task's output task_output returns (the end of the file).
const taskTailMax = 65536

var taskIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// procInfo is a process that holds a task's output file open.
type procInfo struct {
	Pid   int    `json:"pid"`
	State string `json:"state"`
	CPUMs int64  `json:"cpuMs"`
}

type taskOutputResult struct {
	Found      bool       `json:"found"`
	Size       int64      `json:"size"`
	Mtime      int64      `json:"mtime"`
	Tail       string     `json:"tail"`
	ProcsKnown bool       `json:"procsKnown"`
	Procs      []procInfo `json:"procs"`
}

func init() {
	rpcHandlers["task_output"] = rpcTaskOutput
}

// taskTmpRoot is where Claude Code keeps its per-user temp folders.
func taskTmpRoot() string {
	if d := os.Getenv("CLAUDE_CODE_TMPDIR"); d != "" {
		return d
	}
	return os.TempDir()
}

// taskOutputPath finds <tmpRoot>/claude-<uid>/<project>/<session>/tasks/<task>.output (first match).
// Both ids must already be validated.
func taskOutputPath(tmpRoot, uid, session, task string) (string, bool) {
	pat := filepath.Join(tmpRoot, "claude-"+uid, "*", session, "tasks", task+".output")
	matches, err := filepath.Glob(pat)
	if err != nil || len(matches) == 0 {
		return "", false
	}
	return matches[0], true
}

// rpcTaskOutput returns the tail of a background task's output file and the processes holding it open.
func rpcTaskOutput(ctx context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		Session string `json:"session"`
		Task    string `json:"task"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if !taskIDRe.MatchString(p.Session) || !taskIDRe.MatchString(p.Task) {
		return nil, errors.New("invalid session or task id")
	}
	reg := linkOf(ctx).reg
	if reg == nil {
		return nil, errors.New("unknown session")
	}
	known := false
	for _, s := range reg.Snapshot() {
		if s.ID == p.Session {
			known = true
			break
		}
	}
	if !known {
		return nil, errors.New("unknown session")
	}
	res := taskOutputResult{Procs: []procInfo{}}
	path, ok := taskOutputPath(taskTmpRoot(), strconv.Itoa(os.Getuid()), p.Session, p.Task)
	if !ok {
		return res, nil
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return res, nil
	}
	if pre, err := os.Stat(resolved); err != nil || !pre.Mode().IsRegular() {
		return res, nil // a FIFO or device must never block the handler
	}
	f, err := os.Open(resolved)
	if err != nil {
		return res, nil
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		f.Close()
		return res, nil
	}
	size := st.Size()
	off := int64(0)
	if size > taskTailMax {
		off = size - taskTailMax
	}
	buf := make([]byte, size-off)
	n, err := f.ReadAt(buf, off)
	f.Close() // before the scan: our own fd must not count as a holder
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, errCouldNotRead
	}
	buf = buf[:n]
	if off > 0 {
		// the cut may fall inside a rune: drop its continuation bytes
		n := 0
		for n < len(buf) && n < utf8.UTFMax && !utf8.RuneStart(buf[n]) {
			n++
		}
		buf = buf[n:]
	}
	res.Found = true
	res.Size = size
	res.Mtime = st.ModTime().UnixMilli()
	res.Tail = strings.ToValidUTF8(string(buf), "�")
	if procs, ok := fileHolders(resolved); ok {
		res.ProcsKnown = true
		if procs != nil {
			res.Procs = procs
		}
	}
	return res, nil
}
