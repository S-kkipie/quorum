package launch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/proto"
)

// agentTimeoutMs is how long herdr waits for Claude to be ready in agent.start.
const agentTimeoutMs = 60000

// Workspaces remembers which herdr workspace each root folder uses (root → workspaceID),
// in a JSON file written atomically. Empty Path: remembers nothing.
type Workspaces struct {
	Path string
	mu   sync.Mutex
}

func (w *Workspaces) load() map[string]string {
	m := map[string]string{}
	if w == nil || w.Path == "" {
		return m
	}
	if b, err := os.ReadFile(w.Path); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// Get returns the remembered workspace for root, or "".
func (w *Workspaces) Get(root string) string {
	if w == nil {
		return ""
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.load()[root]
}

// Set remembers root's workspace.
func (w *Workspaces) Set(root, id string) error {
	if w == nil || w.Path == "" {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	m := w.load()
	if m[root] == id {
		return nil
	}
	m[root] = id
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return WriteAtomic(w.Path, b, 0o600)
}

// WriteAtomic writes with a temp file in the same directory and rename.
func WriteAtomic(path string, b []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(b)
	if err == nil {
		err = f.Chmod(mode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// ResolveWorkspace picks the herdr workspace for root:
//
//	(a) the remembered one, if it still exists and still has a pane whose cwd is root;
//	(b) otherwise, one with a pane whose cwd is root: the focused one or, if none, the lowest-numbered;
//	(c) otherwise, a new one with that label and env; its root pane is returned in freshPane.
//
// freshPane is non-empty only if the workspace was created. The chosen one is remembered.
// If it fails before touching anything in herdr (workspace.list / pane.list), the error
// wraps ErrHerdrUnavailable; a workspace.create failure does not.
func ResolveWorkspace(ctx context.Context, c *herdr.Client, ws *Workspaces, root, label string, env map[string]string) (wsID, freshPane string, err error) {
	list, err := c.ListWorkspaces(ctx)
	if err != nil {
		return "", "", fmt.Errorf("%w: %w", ErrHerdrUnavailable, err)
	}
	byID := map[string]herdr.Workspace{}
	for _, w := range list {
		byID[w.ID] = w
	}
	panes, err := c.ListPanes(ctx, "")
	if err != nil {
		return "", "", fmt.Errorf("%w: %w", ErrHerdrUnavailable, err)
	}
	clean := filepath.Clean(root)
	inRoot := func(p herdr.Pane) bool { return p.Cwd != "" && filepath.Clean(p.Cwd) == clean }
	if id := ws.Get(root); id != "" {
		if _, ok := byID[id]; ok {
			for _, p := range panes {
				if p.WorkspaceID == id && inRoot(p) {
					return id, "", nil
				}
			}
		}
	}
	var best *herdr.Workspace
	for _, p := range panes {
		if !inRoot(p) {
			continue
		}
		w, ok := byID[p.WorkspaceID]
		if !ok {
			continue
		}
		if best == nil || (w.Focused && !best.Focused) || (w.Focused == best.Focused && w.Number < best.Number) {
			best = &w
		}
	}
	if best != nil {
		wsID = best.ID
	} else {
		wsID, freshPane, err = c.CreateWorkspace(ctx, root, label, env)
		if err != nil {
			return "", "", err
		}
	}
	if err := ws.Set(root, wsID); err != nil {
		log.Printf("launch: could not remember the workspace of %s: %v", root, err)
	}
	return wsID, freshPane, nil
}

// agentName is the agent's name in herdr: [a-z][a-z0-9_-]{0,31}.
func agentName(reqID string) string { return "q" + strings.ToLower(suffix(reqID)) }

// RunHerdr launches the session in a new tab of the project's herdr workspace
// (or in the root pane of a new workspace) and starts Claude with agent.start.
func RunHerdr(ctx context.Context, c *herdr.Client, ws *Workspaces, req proto.LaunchRequest) proto.LaunchResult {
	res, _ := RunHerdrCause(ctx, c, ws, req)
	return res
}

// RunHerdrCause is RunHerdr and also returns the error that made the launch fail
// (nil if it went well or validation failed). Only if errors.Is(err, ErrHerdrUnavailable)
// can Run be retried: herdr did not answer before anything was created. Any other
// error is final (herdr may have created the tab or be starting Claude; retrying
// would launch twice); Pane is filled in if already known.
func RunHerdrCause(ctx context.Context, c *herdr.Client, ws *Workspaces, req proto.LaunchRequest) (proto.LaunchResult, error) {
	res := proto.LaunchResult{ReqID: req.ReqID}
	if msg := validate(Linux, req); msg != "" {
		res.Error = msg
		return res, nil
	}
	trust(req)
	res.Via = "herdr"
	// for JSON no sanitizing is needed: the reqId goes as is (the hub generates it in hex).
	env := map[string]string{}
	if req.ReqID != "" {
		env[LaunchReqEnv] = req.ReqID
	}
	label := req.Label
	if label == "" {
		label = filepath.Base(filepath.Clean(req.Dir))
	}
	wsID, pane, err := ResolveWorkspace(ctx, c, ws, req.Dir, label, env)
	if err != nil {
		res.Error = "could not open the tab in herdr: " + err.Error()
		return res, err
	}
	// herdr types the command into the pane's shell and we don't know how it quotes args:
	// every prompt goes to a file and claude only receives a fixed, safe line,
	// with the path relative to the pane's cwd (the folder never goes in the line).
	// It is written after seeing that herdr answers: otherwise the fallback (Run) would write it
	// again under the same name (O_EXCL) and fail.
	if req.Prompt != "" {
		if req, err = promptToFile(req, true); err != nil {
			res.Error = "could not prepare the prompt: " + err.Error()
			return res, err
		}
	}
	if pane == "" {
		if pane, err = c.CreateTab(ctx, wsID, req.Dir, "claude", env); err != nil {
			res.Error = "could not open the tab in herdr: " + err.Error()
			return res, err
		}
	}
	res.Pane = pane
	args, _ := claudeArgs(req)
	if args == nil {
		args = []string{}
	}
	if err := c.StartAgent(ctx, agentName(req.ReqID), "claude", pane, args, agentTimeoutMs); err != nil {
		var he *herdr.Error
		// agent_not_ready: Claude is stuck in a startup dialog; visible in "View in terminal".
		if !errors.As(err, &he) || he.Code != "agent_not_ready" {
			res.Error = "could not start Claude in herdr: " + err.Error()
			return res, err
		}
	}
	res.OK = true
	return res, nil
}

// ErrHerdrUnavailable: herdr did not answer before touching anything; the fallback can be used.
var ErrHerdrUnavailable = errors.New("herdr unavailable")
