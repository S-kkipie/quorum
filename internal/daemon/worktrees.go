package daemon

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	// worktreesMax caps how many worktrees a session reports.
	worktreesMax = 20
	// worktreesTTL is how long one `git worktree list` answer is reused for a folder.
	worktreesTTL = 60 * time.Second
	// worktreesTimeout bounds one `git worktree list` run.
	worktreesTimeout = 3 * time.Second
	// worktreesCacheMax bounds the cached folders (past it, the expired ones go, then all).
	worktreesCacheMax = 256
)

// gitEnv is the environment git runs with: no GIT_* variable of the daemon's (GIT_DIR,
// GIT_WORK_TREE... would point it at another repository), no optional locks, no prompts.
func gitEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "GIT_") {
			env = append(env, kv)
		}
	}
	return append(env, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
}

// gitWorktreeList runs `git -C dir worktree list --porcelain -z`. A git without -z fails, and
// then no worktrees are reported (the newline-separated form cannot be parsed safely).
func gitWorktreeList(ctx context.Context, dir string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "worktree", "list", "--porcelain", "-z")
	cmd.Env = gitEnv()
	cmd.WaitDelay = time.Second
	return cmd.Output()
}

// parseWorktrees takes the `worktree <path>` records of `git worktree list --porcelain -z`
// output (NUL-terminated fields, an empty field ends a record): absolute and cleaned paths,
// no bare or prunable entry, no duplicates, at most worktreesMax.
func parseWorktrees(out []byte) []string {
	var list []string
	path, skip := "", false
	flush := func() {
		if path != "" && !skip && filepath.IsAbs(path) {
			if p := filepath.Clean(path); !slices.Contains(list, p) && len(list) < worktreesMax {
				list = append(list, p)
			}
		}
		path, skip = "", false
	}
	for _, field := range strings.Split(string(out), "\x00") {
		switch {
		case field == "":
			flush()
		case strings.HasPrefix(field, "worktree "):
			flush()
			path = strings.TrimPrefix(field, "worktree ")
		case field == "bare", field == "prunable", strings.HasPrefix(field, "prunable "):
			skip = true
		}
	}
	flush()
	return list
}

type worktreeEntry struct {
	list []string
	at   time.Time
}

// worktreeFinder caches the git worktrees of each session folder. lookup never runs git: a
// missing or stale entry is refreshed in the background and the result handed to a callback.
type worktreeFinder struct {
	run     func(ctx context.Context, dir string) ([]byte, error)
	lstat   func(string) (os.FileInfo, error)
	resolve func(string) (string, error)
	now     func() time.Time
	ttl     time.Duration
	timeout time.Duration

	mu       sync.Mutex
	cache    map[string]worktreeEntry
	inflight map[string]bool
}

func newWorktreeFinder() *worktreeFinder {
	return &worktreeFinder{run: gitWorktreeList, lstat: os.Lstat, resolve: filepath.EvalSymlinks, now: time.Now, ttl: worktreesTTL, timeout: worktreesTimeout,
		cache: map[string]worktreeEntry{}, inflight: map[string]bool{}}
}

// lookup returns the cached worktrees of dir (nil when unknown) and whether they are fresh.
func (f *worktreeFinder) lookup(dir string) ([]string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.cache[dir]
	if !ok {
		return nil, false
	}
	return e.list, f.now().Sub(e.at) < f.ttl
}

// find runs git for dir (bounded by the timeout) and caches the answer. A git failure (no git,
// not a repository, no -z, timeout) keeps the list cached before (none the first time).
func (f *worktreeFinder) find(dir string) []string {
	var list []string
	ok := false
	if filepath.IsAbs(dir) {
		ctx, cancel := context.WithTimeout(context.Background(), f.timeout)
		out, err := f.run(ctx, dir)
		cancel()
		if err == nil {
			list, ok = f.check(dir, parseWorktrees(out)), true
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !ok {
		list = f.cache[dir].list
	}
	now := f.now()
	if len(f.cache) >= worktreesCacheMax {
		for k, e := range f.cache {
			if now.Sub(e.at) >= f.ttl {
				delete(f.cache, k)
			}
		}
		if len(f.cache) >= worktreesCacheMax {
			f.cache = map[string]worktreeEntry{}
		}
	}
	f.cache[dir] = worktreeEntry{list: list, at: now}
	return list
}

// check keeps the worktrees that still have their .git entry, and only when dir is one of them:
// `git -C` walks up to a parent repository (e.g. dotfiles in the home folder), whose worktrees
// are not this session's.
func (f *worktreeFinder) check(dir string, list []string) []string {
	self, err := f.resolve(filepath.Clean(dir))
	if err != nil {
		return nil
	}
	var out []string
	mine := false
	for _, wt := range list {
		if _, err := f.lstat(filepath.Join(wt, ".git")); err != nil {
			continue
		}
		if r, err := f.resolve(wt); err == nil && r == self {
			mine = true
		}
		out = append(out, wt)
	}
	if !mine {
		return nil
	}
	return out
}

// refresh starts one background find of dir (none if one is already running) and calls done
// with its result.
func (f *worktreeFinder) refresh(dir string, done func(dir string, list []string)) {
	f.mu.Lock()
	if f.inflight[dir] {
		f.mu.Unlock()
		return
	}
	f.inflight[dir] = true
	f.mu.Unlock()
	go func() {
		list := f.find(dir)
		f.mu.Lock()
		delete(f.inflight, dir)
		f.mu.Unlock()
		done(dir, list)
	}()
}

// worktreeDir is the folder a session's worktrees are looked up from: its root, else its cwd.
func worktreeDir(root, cwd string) string {
	if root != "" {
		return root
	}
	return cwd
}
