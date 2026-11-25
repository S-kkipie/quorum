// Package launch opens new Claude Code sessions in a terminal on the machine.
//
// Claude is always resolved through the PATH of a login shell (bash -lc / -lic),
// never by absolute path, to respect whoas shims. Exception: on native
// Windows `wt.exe -d <dir> claude` is used, with the Windows session's PATH.
package launch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

type Env string

const (
	Linux   Env = "linux"
	WSL     Env = "wsl"
	Windows Env = "windows"
	Darwin  Env = "darwin"
)

var (
	now        = time.Now
	modeRe     = regexp.MustCompile(`^[A-Za-z]+$`)
	runTimeout = 15 * time.Second
	// execFn runs the launcher and waits for it to finish; injected in tests.
	execFn = runDetached
	// geteuid is injected in tests (Skip permissions is not allowed as root).
	geteuid  = os.Geteuid
	resumeRe = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)
	hexRe    = regexp.MustCompile(`[0-9a-fA-F]`)
	notAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)
)

// LaunchReqEnv is the environment variable that ties the launched session to its reqId.
const LaunchReqEnv = "QUORUM_LAUNCH_REQ"

// validResume: a conversation id of 8 to 64 hex characters or '-', with at least one hex digit
// (so it is never something like "--------", which claude would read as an option).
func validResume(id string) bool { return resumeRe.MatchString(id) && hexRe.MatchString(id) }

// launchReqValue is the reqId sanitized for the environment ([A-Za-z0-9]); empty if nothing is left.
func launchReqValue(reqID string) string { return notAlnum.ReplaceAllString(reqID, "") }

// graceWait is how long a graphical launcher (wt.exe, osascript) is awaited before
// considering it launched: they may stay alive holding inherited handles. A variable for tests.
var graceWait = 3 * time.Second

// runDetached starts bin with its output going to a temp file (no copy goroutines
// that would block Wait). tmux -d returns instantly and is awaited fully; the
// others are awaited graceWait and, if still alive, are considered launched.
func runDetached(ctx context.Context, bin string, args ...string) ([]byte, error) {
	f, err := os.CreateTemp("", "quorum-launch-*")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = f, f
	err = cmd.Start()
	f.Close() // the child has its own handle; ours must not hold the file
	if err != nil {
		os.Remove(name)
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	// If we return before the child finishes, the temp file is deleted when it ends
	// (on Windows it cannot be deleted while the child has it open). Best effort.
	removeLater := func() { go func() { <-done; os.Remove(name) }() }
	var grace <-chan time.Time
	if bin != "tmux" {
		t := time.NewTimer(graceWait)
		defer t.Stop()
		grace = t.C
	}
	select {
	case err := <-done:
		out, _ := os.ReadFile(name)
		os.Remove(name)
		return out, err
	case <-grace:
		removeLater()
		return nil, nil // still alive: considered launched
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		removeLater()
		return nil, ctx.Err()
	}
}

// DetectEnv infers the current execution environment.
func DetectEnv() Env {
	if runtime.GOOS == "linux" {
		if os.Getenv("WSL_DISTRO_NAME") != "" {
			return WSL
		}
		if b, err := os.ReadFile("/proc/version"); err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft") {
			return WSL
		}
		return Linux
	}
	return Env(runtime.GOOS)
}

// shellQuote wraps s in single quotes for a POSIX shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// modeFlags translates the permission mode; ok=false if it is not valid.
func modeFlags(m string) (flags []string, ok bool) {
	switch m {
	case "":
		return nil, true
	case "default":
		// explicit: otherwise claude uses the user's or account's defaultMode (e.g. auto)
		// and a "Normal (asks for permissions)" session would not ask for permissions.
		return []string{"--permission-mode", "default"}, true
	case "bypass":
		return []string{"--dangerously-skip-permissions"}, true
	}
	if !modeRe.MatchString(m) {
		return nil, false
	}
	return []string{"--permission-mode", m}, true
}

// claudeArgs are claude's arguments (without the binary) and the prompt's index
// (-1 if none). The prompt goes as a positional argument after "--", so it is never
// mistaken for an option.
func claudeArgs(req proto.LaunchRequest) (parts []string, promptIdx int) {
	promptIdx = -1
	if req.Continue {
		parts = append(parts, "--continue")
	}
	if f, ok := modeFlags(req.PermissionMode); ok { // Run already rejected the invalid ones
		parts = append(parts, f...)
	}
	if req.Resume != "" && validResume(req.Resume) { // validate already rejected the invalid ones
		parts = append(parts, "--resume", req.Resume)
	}
	if req.Prompt != "" {
		parts = append(parts, "--", req.Prompt)
		promptIdx = len(parts) - 1
	}
	return parts, promptIdx
}

// claudeLine is the POSIX shell line; only the prompt needs quoting (the flags and
// the --resume id are safe). It is prefixed with QUORUM_LAUNCH_REQ=<sanitized reqId>.
func claudeLine(req proto.LaunchRequest) string {
	args, pi := claudeArgs(req)
	var parts []string
	if v := launchReqValue(req.ReqID); v != "" {
		parts = append(parts, LaunchReqEnv+"="+v)
	}
	parts = append(parts, "claude")
	for i, a := range args {
		if i == pi {
			a = shellQuote(a)
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

// wtEscape escapes ';' (Windows Terminal's command separator).
func wtEscape(s string) string { return strings.ReplaceAll(s, ";", `\;`) }

func appleScriptEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}

// suffix gives a short suffix suitable for a tmux session name (no '.' or ':').
func suffix(reqID string) string {
	var b strings.Builder
	for _, r := range reqID {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
		if b.Len() == 6 {
			break
		}
	}
	if b.Len() == 0 {
		var r [3]byte
		_, _ = rand.Read(r[:])
		return hex.EncodeToString(r[:])
	}
	return b.String()
}

func isAbs(env Env, dir string) bool {
	if env == Windows {
		return filepath.IsAbs(dir)
	}
	return strings.HasPrefix(dir, "/")
}

// Argv builds the command that opens the terminal. hasDisplay is reserved
// for choosing a graphical emulator on Linux with a display; for now Linux always uses tmux.
func Argv(env Env, req proto.LaunchRequest, hasDisplay bool) (bin string, args []string) {
	line := claudeLine(req)
	switch env {
	case WSL:
		return "wt.exe", []string{"wsl.exe", "-d", os.Getenv("WSL_DISTRO_NAME"), "--cd", wtEscape(req.Dir), "--", "bash", "-lic", line}
	case Windows:
		a := []string{"-d", wtEscape(req.Dir), "claude"}
		cargs, _ := claudeArgs(req)
		return "wt.exe", append(a, cargs...)
	case Darwin:
		script := fmt.Sprintf(`tell app "Terminal" to do script "%s"`,
			appleScriptEscape("cd "+shellQuote(req.Dir)+" && "+line))
		return "osascript", []string{"-e", script}
	default:
		name := "quorum-" + strconv.FormatInt(now().Unix(), 36) + "-" + suffix(req.ReqID)
		return "tmux", []string{"new-session", "-d", "-s", name, "-c", req.Dir, "bash -lc " + shellQuote(line)}
	}
}

// rootBypassMsg is why "Skip permissions" is not offered as root.
const rootBypassMsg = "Skip permissions does not work as root"

// validate checks the request; returns the error message or "".
func validate(env Env, req proto.LaunchRequest) string {
	if _, ok := modeFlags(req.PermissionMode); !ok {
		return "invalid permission mode"
	}
	if req.PermissionMode == "bypass" && geteuid() == 0 {
		return rootBypassMsg
	}
	if req.Resume != "" && !validResume(req.Resume) {
		return "invalid conversation id"
	}
	if !isAbs(env, req.Dir) {
		return "the folder must be an absolute path"
	}
	if st, err := os.Stat(req.Dir); err != nil || !st.IsDir() {
		return "the folder does not exist: " + req.Dir
	}
	return ""
}

// trust marks the folder as trusted if requested; a failure is only logged.
func trust(req proto.LaunchRequest) {
	if !req.Trust {
		return
	}
	home, err := os.UserHomeDir()
	if err == nil {
		err = TrustDir(home, req.Dir)
	}
	if err != nil {
		log.Printf("launch: could not trust %s: %v", req.Dir, err)
	}
}

// via is the launcher's name for LaunchResult.Via.
func via(bin string) string {
	if bin == "wt.exe" {
		return "wt"
	}
	return bin
}

// Run validates the request and launches the terminal. It does not wait for Claude to finish.
func Run(ctx context.Context, req proto.LaunchRequest) proto.LaunchResult {
	res := proto.LaunchResult{ReqID: req.ReqID}
	env := DetectEnv()
	if msg := validate(env, req); msg != "" {
		res.Error = msg
		return res
	}
	trust(req)
	req, err := collapsePrompt(env, req)
	if err != nil {
		res.Error = "could not prepare the prompt: " + err.Error()
		return res
	}
	bin, args := Argv(env, req, os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "")
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	if out, err := execFn(ctx, bin, args...); err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		res.Error = "could not open the terminal: " + msg
		return res
	}
	res.OK, res.Via = true, via(bin)
	return res
}

const (
	promptMaxInline = 1000
	promptFileTTL   = 24 * time.Hour
	promptFilePre   = "ticket-"
	legacyPromptPre = "quorum-ticket-" // earlier versions left it in the temp dir
)

var unsafeID = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// PromptDir is where long prompts are left, inside the session's folder:
// this way claude reads it without asking permission to leave its cwd. Worth gitignoring.
func PromptDir(dir string) string { return filepath.Join(dir, ".claude", "quorum") }

// collapsePrompt avoids passing a long prompt or one with newlines through the command line
// (wt.exe, osascript, tmux): it writes it to <dir>/.claude/quorum/ticket-<reqId>.md
// (folders 0700, file 0600, O_EXCL) and leaves a short prompt pointing at the file.
// Files older than 24 h are deleted on the next launch (best effort).
//
// On WSL and Windows (wt.exe) the file is also used if the prompt contains ';', which
// wt.exe takes as a command separator: this way no ';' of the prompt reaches its command
// line (the `\;` escape cannot be guaranteed to reach claude cleanly).
func collapsePrompt(env Env, req proto.LaunchRequest) (proto.LaunchRequest, error) {
	wt := (env == WSL || env == Windows) && strings.Contains(req.Prompt, ";")
	if req.Prompt == "" || (!wt && !strings.ContainsAny(req.Prompt, "\r\n") && len(req.Prompt) <= promptMaxInline) {
		return req, nil
	}
	return promptToFile(req, false)
}

// promptToFile writes the prompt to <dir>/.claude/quorum/ticket-<reqId>.md and replaces it
// with a short one pointing at the file. With rel, the prompt's path is relative
// to <dir> (the session's cwd): this way the project folder, which may contain
// quotes, ';' or '$(', never reaches the line written into a shell.
func promptToFile(req proto.LaunchRequest, rel bool) (proto.LaunchRequest, error) {
	cleanPromptFiles(os.TempDir(), legacyPromptPre)
	dir := PromptDir(req.Dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return req, err
	}
	cleanPromptFiles(dir, promptFilePre)
	excludePromptDir(req.Dir)
	id := unsafeID.ReplaceAllString(req.ReqID, "")
	if id == "" {
		id = suffix("")
	}
	path := filepath.Join(dir, promptFilePre+id+".md")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return req, err
	}
	_, err = f.WriteString(req.Prompt)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return req, err
	}
	shown := path
	if rel {
		shown = ".claude/quorum/" + promptFilePre + id + ".md"
	}
	if req.TicketID != "" {
		req.Prompt = "Read the file " + shown + " and work on that ticket."
	} else {
		req.Prompt = "Read the file " + shown + " and follow it."
	}
	return req, nil
}

// excludePromptDir keeps the prompt files out of git: it appends the prompt folder to the repository's
// info/exclude once (never .gitignore). For a .git directory that is <repo>/.git/info/exclude; for a .git
// file ("gitdir: <path>", a worktree or submodule) it is the common git dir's (the gitdir's commondir, or the
// gitdir itself), which every worktree of the repository reads. Best effort.
func excludePromptDir(dir string) {
	if dir == "" {
		return
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return
	}
	for root := abs; ; {
		gd := filepath.Join(root, ".git")
		st, err := os.Lstat(gd)
		if err == nil {
			rel, err := filepath.Rel(root, abs)
			if err != nil {
				return
			}
			line := ".claude/quorum/"
			if rel != "." {
				line = "/" + filepath.ToSlash(rel) + "/" + line
			}
			common := gd
			if !st.IsDir() {
				if common = commonGitDir(root, gd); common == "" {
					return
				}
			}
			appendExclude(filepath.Join(common, "info", "exclude"), line)
			return
		}
		parent := filepath.Dir(root)
		if parent == root {
			return
		}
		root = parent
	}
}

// commonGitDir resolves a .git file ("gitdir: <path>") to the repository's common git dir: the gitdir's
// commondir when it has one (a worktree), else the gitdir itself (a submodule). "" when it cannot.
func commonGitDir(root, gitFile string) string {
	data, err := os.ReadFile(gitFile)
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
	if !strings.HasPrefix(line, "gitdir:") {
		return ""
	}
	gd := strings.TrimSpace(strings.TrimPrefix(line, "gitdir:"))
	if gd == "" {
		return ""
	}
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(root, gd)
	}
	if st, err := os.Stat(gd); err != nil || !st.IsDir() {
		return ""
	}
	if c, err := os.ReadFile(filepath.Join(gd, "commondir")); err == nil {
		cd := strings.TrimSpace(string(c))
		if cd != "" {
			if !filepath.IsAbs(cd) {
				cd = filepath.Join(gd, cd)
			}
			if st, err := os.Stat(cd); err == nil && st.IsDir() {
				return filepath.Clean(cd)
			}
			return ""
		}
	}
	return filepath.Clean(gd)
}

func appendExclude(path, line string) {
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return
	}
	for _, l := range strings.Split(string(data), "\n") {
		if t := strings.TrimSpace(l); t == line || (line == ".claude/quorum/" && (t == "/.claude/quorum/" || t == ".claude/quorum")) {
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		line = "\n" + line
	}
	_, _ = f.WriteString(line + "\n")
}

func cleanPromptFiles(dir, prefix string) {
	ents, _ := filepath.Glob(filepath.Join(dir, prefix+"*.md"))
	for _, p := range ents {
		if st, err := os.Stat(p); err == nil && now().Sub(st.ModTime()) > promptFileTTL {
			os.Remove(p)
		}
	}
}
