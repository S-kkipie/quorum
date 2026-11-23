// Package herdr es el cliente del socket unix de herdr (JSON por líneas).
package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

const defaultTimeout = 10 * time.Second

// Client habla con herdr. Una conexión por llamada.
type Client struct{ Socket string }

// Error es un error devuelto por el servidor de herdr.
type Error struct{ Code, Message string }

func (e *Error) Error() string { return "herdr: " + e.Code + ": " + e.Message }

// IsNotFound dice si err es un error de herdr por algo que no existe: not_found
// o cualquier código <algo>_not_found (herdr 0.9.5 responde pane_not_found,
// workspace_not_found, tab_not_found...).
func IsNotFound(err error) bool {
	var he *Error
	return errors.As(err, &he) && (he.Code == "not_found" || strings.HasSuffix(he.Code, "_not_found"))
}

type Workspace struct {
	ID      string `json:"workspace_id"`
	Label   string `json:"label"`
	Focused bool   `json:"focused"`
	Number  int    `json:"number"`
}

type Pane struct {
	ID           string `json:"pane_id"`
	WorkspaceID  string `json:"workspace_id"`
	TabID        string `json:"tab_id"`
	TerminalID   string `json:"terminal_id"` // único por terminal; los ids de panel se reusan
	Cwd          string `json:"cwd"`
	Focused      bool   `json:"focused"`
	Agent        string `json:"agent"`
	AgentStatus  string `json:"agent_status"` // p. ej. idle, working, blocked
	AgentSession *struct {
		Value string `json:"value"`
	} `json:"agent_session"`
}

// SocketPath resuelve el socket: override > $HERDR_SOCKET_PATH > ~/.config/herdr/herdr.sock.
func SocketPath(override string) string {
	if override != "" {
		return override
	}
	if v := os.Getenv("HERDR_SOCKET_PATH"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "herdr", "herdr.sock")
}

var reqSeq atomic.Uint64

// Call envía una petición y deserializa `result` en out (puede ser nil).
// Plazo: el del ctx, o 10 s si no tiene.
func (c *Client) Call(ctx context.Context, method string, params, out any) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultTimeout)
		defer cancel()
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	// Si el ctx se cancela a mitad de la llamada, corta la conexión.
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	id := fmt.Sprintf("q%d", reqSeq.Add(1))
	if params == nil {
		params = map[string]any{}
	}
	line, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return err
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return err
	}
	resp, err := bufio.NewReaderSize(conn, 1<<20).ReadBytes('\n')
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	var r struct {
		Result json.RawMessage `json:"result"`
		Error  *Error          `json:"error"`
	}
	if err := json.Unmarshal(resp, &r); err != nil {
		return fmt.Errorf("herdr: respuesta inválida: %w", err)
	}
	if r.Error != nil {
		return r.Error
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(r.Result, out)
}

// Available dice si el socket existe y workspace.list responde en < 1 s.
func (c *Client) Available(ctx context.Context) bool {
	if _, err := os.Stat(c.Socket); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return c.Call(ctx, "workspace.list", nil, nil) == nil
}

func (c *Client) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	var out struct {
		Workspaces []Workspace `json:"workspaces"`
	}
	if err := c.Call(ctx, "workspace.list", nil, &out); err != nil {
		return nil, err
	}
	return out.Workspaces, nil
}

// ListPanes lista los paneles; workspaceID vacío = todos.
func (c *Client) ListPanes(ctx context.Context, workspaceID string) ([]Pane, error) {
	p := map[string]any{}
	if workspaceID != "" {
		p["workspace_id"] = workspaceID
	}
	var out struct {
		Panes []Pane `json:"panes"`
	}
	if err := c.Call(ctx, "pane.list", p, &out); err != nil {
		return nil, err
	}
	return out.Panes, nil
}

type rootPane struct {
	RootPane struct {
		ID string `json:"pane_id"`
	} `json:"root_pane"`
}

// CreateWorkspace crea un workspace sin robar el foco.
func (c *Client) CreateWorkspace(ctx context.Context, cwd, label string, env map[string]string) (wsID, root string, err error) {
	var out struct {
		rootPane
		Workspace struct {
			ID string `json:"workspace_id"`
		} `json:"workspace"`
	}
	p := map[string]any{"cwd": cwd, "label": label, "focus": false}
	if len(env) > 0 {
		p["env"] = env
	}
	if err := c.Call(ctx, "workspace.create", p, &out); err != nil {
		return "", "", err
	}
	return out.Workspace.ID, out.RootPane.ID, nil
}

// CreateTab crea una pestaña en el workspace sin robar el foco.
func (c *Client) CreateTab(ctx context.Context, wsID, cwd, label string, env map[string]string) (string, error) {
	var out rootPane
	p := map[string]any{"workspace_id": wsID, "cwd": cwd, "label": label, "focus": false}
	if len(env) > 0 {
		p["env"] = env
	}
	if err := c.Call(ctx, "tab.create", p, &out); err != nil {
		return "", err
	}
	return out.RootPane.ID, nil
}

// StartAgent arranca un agente en el panel. Plazo: timeoutMs + 5 s.
func (c *Client) StartAgent(ctx context.Context, name, kind, pane string, args []string, timeoutMs int) error {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond+5*time.Second)
	defer cancel()
	return c.Call(ctx, "agent.start", map[string]any{
		"name": name, "kind": kind, "pane_id": pane, "args": args, "timeout_ms": timeoutMs,
	}, nil)
}

// ReadPane lee la pantalla del panel, siempre con ANSI.
func (c *Client) ReadPane(ctx context.Context, pane, source string, lines int) (string, error) {
	var out struct {
		Read struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	err := c.Call(ctx, "pane.read", map[string]any{
		"pane_id": pane, "source": source, "format": "ansi", "lines": lines, "strip_ansi": false,
	}, &out)
	return out.Read.Text, err
}

// PaneSize devuelve columnas y filas del panel según pane.layout.
func (c *Client) PaneSize(ctx context.Context, pane string) (cols, rows int, err error) {
	var out struct {
		Layout struct {
			Panes []struct {
				ID   string `json:"pane_id"`
				Rect struct {
					Width  int `json:"width"`
					Height int `json:"height"`
				} `json:"rect"`
			} `json:"panes"`
		} `json:"layout"`
	}
	if err := c.Call(ctx, "pane.layout", map[string]any{"pane_id": pane}, &out); err != nil {
		return 0, 0, err
	}
	for _, p := range out.Layout.Panes {
		if p.ID == pane {
			return p.Rect.Width, p.Rect.Height, nil
		}
	}
	return 0, 0, fmt.Errorf("herdr: panel %s no está en el layout", pane)
}

func (c *Client) SendText(ctx context.Context, pane, text string) error {
	return c.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": text}, nil)
}

func (c *Client) SendKeys(ctx context.Context, pane string, keys []string) error {
	return c.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": keys}, nil)
}

func (c *Client) ClosePane(ctx context.Context, pane string) error {
	return c.Call(ctx, "pane.close", map[string]any{"pane_id": pane}, nil)
}
