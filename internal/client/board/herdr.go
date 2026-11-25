package board

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Runner runs a command and returns its stdout; a failure's error carries stderr (see execRun).
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// Herdr jumps through the herdr CLI:
//   - Focus: `herdr agent focus <pane>`. `herdr pane focus` only moves to a neighbour; agent focus
//     takes an explicit pane id as its target, and every pane a session reports runs Claude, which
//     herdr tracks as an agent.
//   - OpenAttach: `herdr tab create --focus --label <title> [--workspace <id>]`, then
//     `herdr pane run <root pane> "<quorum> attach <id>"` (tab create takes no command).
//
// herdr 0.9.5 has its own argument parser: an option's value is the next token, taken literally
// even when it starts with "-"; it supports neither "--opt=<v>" nor "--" (both become values).
type Herdr struct {
	Bin       string // HERDR_BIN_PATH, else "herdr"
	Run       Runner
	Workspace string // HERDR_WORKSPACE_ID: the new tab goes to the caller's workspace
	Self      string // the quorum binary the new tab runs
}

// NewHerdr reads the herdr binary and workspace from the environment herdr gives its panes.
func NewHerdr() *Herdr {
	bin := os.Getenv("HERDR_BIN_PATH")
	if bin == "" {
		bin = "herdr"
	}
	self, err := os.Executable()
	if err != nil {
		self = "quorum"
	}
	return &Herdr{Bin: bin, Run: execRun, Workspace: os.Getenv("HERDR_WORKSPACE_ID"), Self: self}
}

func execRun(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, herdrError(err, stderr.Bytes())
	}
	return out, nil
}

// herdrError prefers the message of herdr's JSON error ({"error":{"message"}}) on stderr.
func herdrError(err error, stderr []byte) error {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(bytes.TrimSpace(stderr), &e) == nil && e.Error.Message != "" {
		return errors.New("herdr: " + e.Error.Message)
	}
	if s := strings.TrimSpace(string(stderr)); s != "" {
		return fmt.Errorf("herdr: %v: %s", err, cut(s, 200))
	}
	return fmt.Errorf("herdr: %v", err)
}

// Focus focuses the session's pane (its tab and workspace come with it).
func (h *Herdr) Focus(ctx context.Context, pane string) error {
	_, err := h.Run(ctx, h.Bin, "agent", "focus", pane)
	return err
}

// OpenAttach opens a focused tab that mirrors s with `quorum attach`.
func (h *Herdr) OpenAttach(ctx context.Context, s proto.SessionInfo) error {
	args := []string{"tab", "create", "--focus", "--label", cut(name(s)+" · "+s.Machine, 40)}
	if h.Workspace != "" {
		args = append(args, "--workspace", h.Workspace)
	}
	out, err := h.Run(ctx, h.Bin, args...)
	if err != nil {
		return err
	}
	var r struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if json.Unmarshal(out, &r) != nil || r.Result.RootPane.PaneID == "" {
		return errors.New("herdr: tab create returned no pane")
	}
	_, err = h.Run(ctx, h.Bin, "pane", "run", r.Result.RootPane.PaneID, shellQuote(h.Self)+" attach "+shellQuote(s.ID))
	return err
}

// shellQuote wraps s in single quotes for the tab's shell.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
