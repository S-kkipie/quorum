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

// agentTimeoutMs es lo que herdr espera a que Claude quede listo en agent.start.
const agentTimeoutMs = 60000

// Workspaces recuerda qué workspace de herdr usa cada carpeta raíz (root → workspaceID),
// en un JSON que se escribe de forma atómica. Path vacío: no recuerda nada.
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

// Get devuelve el workspace recordado para root, o "".
func (w *Workspaces) Get(root string) string {
	if w == nil {
		return ""
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.load()[root]
}

// Set recuerda el workspace de root.
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

// WriteAtomic escribe con un temporal en el mismo directorio y rename.
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

// ResolveWorkspace elige el workspace de herdr para root:
//
//	(a) el recordado, si sigue existiendo y aún tiene un panel cuyo cwd es root;
//	(b) si no, uno con un panel cuyo cwd es root: el enfocado o, si no hay, el de menor número;
//	(c) si no, uno nuevo con ese label y env; su panel raíz se devuelve en freshPane.
//
// freshPane solo no está vacío si se creó el workspace. El elegido queda recordado.
// Si falla antes de tocar nada en herdr (workspace.list / pane.list), el error
// envuelve ErrHerdrUnavailable; un fallo de workspace.create no.
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
		log.Printf("launch: no se pudo recordar el workspace de %s: %v", root, err)
	}
	return wsID, freshPane, nil
}

// agentName es el nombre del agente en herdr: [a-z][a-z0-9_-]{0,31}.
func agentName(reqID string) string { return "q" + strings.ToLower(suffix(reqID)) }

// RunHerdr lanza la sesión en una pestaña nueva del workspace de herdr del proyecto
// (o en el panel raíz de un workspace nuevo) y arranca Claude con agent.start.
func RunHerdr(ctx context.Context, c *herdr.Client, ws *Workspaces, req proto.LaunchRequest) proto.LaunchResult {
	res, _ := RunHerdrCause(ctx, c, ws, req)
	return res
}

// RunHerdrCause es RunHerdr y además devuelve el error que hizo fallar el lanzamiento
// (nil si fue bien o si falló la validación). Solo si errors.Is(err, ErrHerdrUnavailable)
// se puede reintentar con Run: herdr no respondió antes de crear nada. Cualquier otro
// error es definitivo (herdr pudo crear la pestaña o estar arrancando Claude; reintentar
// lanzaría dos veces); Pane va relleno si ya se conoce.
func RunHerdrCause(ctx context.Context, c *herdr.Client, ws *Workspaces, req proto.LaunchRequest) (proto.LaunchResult, error) {
	res := proto.LaunchResult{ReqID: req.ReqID}
	if msg := validate(Linux, req); msg != "" {
		res.Error = msg
		return res, nil
	}
	trust(req)
	res.Via = "herdr"
	// por JSON no hace falta sanear: va el reqId tal cual (el hub lo genera en hex).
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
		res.Error = "no se pudo abrir la pestaña en herdr: " + err.Error()
		return res, err
	}
	// herdr escribe la orden en el shell del panel y no sabemos cómo cita los args:
	// todo prompt va a un fichero y a claude solo le llega una línea fija y segura,
	// con la ruta relativa al cwd del panel (la carpeta nunca va en la línea).
	// Se escribe tras ver que herdr responde: si no, el respaldo (Run) lo escribiría
	// otra vez con el mismo nombre (O_EXCL) y fallaría.
	if req.Prompt != "" {
		if req, err = promptToFile(req, true); err != nil {
			res.Error = "no se pudo preparar el prompt: " + err.Error()
			return res, err
		}
	}
	if pane == "" {
		if pane, err = c.CreateTab(ctx, wsID, req.Dir, "claude", env); err != nil {
			res.Error = "no se pudo abrir la pestaña en herdr: " + err.Error()
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
		// agent_not_ready: Claude quedó en un diálogo de arranque; se ve en "Ver en terminal".
		if !errors.As(err, &he) || he.Code != "agent_not_ready" {
			res.Error = "no se pudo arrancar Claude en herdr: " + err.Error()
			return res, err
		}
	}
	res.OK = true
	return res, nil
}

// ErrHerdrUnavailable: herdr no respondió antes de tocar nada; se puede usar el respaldo.
var ErrHerdrUnavailable = errors.New("herdr no disponible")
