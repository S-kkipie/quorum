package daemon

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
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/daemon/convos"
	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Intervalos del vigilante de terminal; variables para tests.
var (
	termPoll  = 125 * time.Millisecond // pane.read: como mucho 8 frames por segundo
	termSize  = 2 * time.Second        // pane.layout
	termLease = 15 * time.Second       // la app lo renueva cada 5 s mientras mira
)

const (
	termFrameMax  = 256 << 10 // bytes de ANSI por term_frame
	termReadMax   = 1 << 20   // bytes de ANSI de term_read (historial)
	termReadLines = 2000
	termCallWait  = 3 * time.Second // plazo de cada llamada a herdr del vigilante
	maxConvos     = 60
)

// userHome se sustituye en los tests (nunca se toca el ~/.claude real).
var userHome = os.UserHomeDir

var (
	errTermOff    = errors.New("la terminal está desactivada en esta máquina")
	errHerdrDown  = errors.New("herdr no responde en esta máquina")
	errNotOwnTerm = errors.New("Quorum solo cierra terminales que abrió")
)

// allowedKeys son las únicas teclas (nombres de herdr) que se mandan a un panel.
var allowedKeys = map[string]bool{
	"esc": true, "tab": true, "enter": true, "ctrl+c": true, "ctrl+d": true, "ctrl+l": true,
	"up": true, "down": true, "left": true, "right": true,
}

func init() {
	rpcHandlers["conversations"] = rpcConversations
	rpcHandlers["term_open"] = termOnly(rpcTermOpen)
	rpcHandlers["term_watch"] = termOnly(rpcTermWatch)
	rpcHandlers["term_input"] = termOnly(rpcTermInput)
	rpcHandlers["term_read"] = termOnly(rpcTermRead)
	rpcHandlers["term_close"] = termOnly(rpcTermClose)
}

type rpcFunc = func(ctx context.Context, h *Host, params json.RawMessage) (any, error)

// termOnly corta con errTermOff si la terminal está apagada y con errHerdrDown si
// herdr no responde.
func termOnly(fn rpcFunc) rpcFunc {
	return func(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
		if h == nil || !h.TerminalOn {
			return nil, errTermOff
		}
		if !h.herdrUp(ctx) {
			return nil, errHerdrDown
		}
		return fn(ctx, h, params)
	}
}

func decodeParams(params json.RawMessage, v any) error {
	if len(params) == 0 {
		params = []byte("{}")
	}
	if err := json.Unmarshal(params, v); err != nil {
		return fmt.Errorf("parámetros inválidos: %w", err)
	}
	return nil
}

// --- conversaciones ---

func rpcConversations(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	var p struct {
		Root string `json:"root"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if p.Root == "" || !filepath.IsAbs(p.Root) {
		return nil, errors.New("root debe ser una ruta absoluta")
	}
	home, err := userHome()
	if err != nil {
		return nil, err
	}
	live := map[string]bool{}
	if reg := linkOf(ctx).reg; reg != nil {
		for _, s := range reg.Snapshot() {
			live[s.ID] = true
		}
	}
	return convos.List(convos.Dir(home, p.Root), live, maxConvos)
}

// --- terminales propias (herdr-terminals.json) ---

// Terminals recuerda los paneles de terminal que abrió Quorum, cada uno con el
// terminal_id que herdr le dio (los ids de panel se reusan, p. ej. tras reiniciar
// herdr; el terminal_id no). Guarda el último de cada root (para reusarlo) y todos
// los propios (los únicos que se pueden cerrar). Path vacío: no recuerda nada.
type Terminals struct {
	Path string
	mu   sync.Mutex
}

type ownedTerm struct {
	Pane       string `json:"pane"`
	TerminalID string `json:"terminalId"`
}

// termFile: el formato viejo ("owned": ids sueltos, sin terminal_id) se ignora a
// propósito: esas entradas no se pueden verificar y no se cierran nunca.
type termFile struct {
	ByRoot    map[string]string `json:"byRoot"`
	Terminals []ownedTerm       `json:"terminals"`
}

func (t *Terminals) load() termFile {
	f := termFile{ByRoot: map[string]string{}}
	if t == nil || t.Path == "" {
		return f
	}
	if b, err := os.ReadFile(t.Path); err == nil {
		_ = json.Unmarshal(b, &f)
	}
	if f.ByRoot == nil {
		f.ByRoot = map[string]string{}
	}
	return f
}

func (t *Terminals) save(f termFile) error {
	if t == nil || t.Path == "" {
		return nil
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return launch.WriteAtomic(t.Path, b, 0o600)
}

// update aplica fn bajo el lock y guarda si devolvió true.
func (t *Terminals) update(fn func(*termFile) bool) error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	f := t.load()
	if !fn(&f) {
		return nil
	}
	return t.save(f)
}

// get devuelve el panel recordado para root ("" si no hay).
func (t *Terminals) get(root string) string {
	if t == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.load().ByRoot[root]
}

// recorded devuelve el terminal_id con que Quorum abrió pane ("" si no es suyo).
func (t *Terminals) recorded(pane string) string {
	if t == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, o := range t.load().Terminals {
		if o.Pane == pane {
			return o.TerminalID
		}
	}
	return ""
}

func (t *Terminals) add(root, pane, terminalID string) error {
	return t.update(func(f *termFile) bool {
		f.ByRoot[root] = pane
		for i, o := range f.Terminals {
			if o.Pane == pane {
				f.Terminals[i].TerminalID = terminalID
				return true
			}
		}
		f.Terminals = append(f.Terminals, ownedTerm{pane, terminalID})
		return true
	})
}

// sync olvida las terminales propias que ya no están vivas con su mismo
// terminal_id (live: pane → terminal_id según pane.list).
func (t *Terminals) sync(live map[string]string) error {
	return t.update(func(f *termFile) bool {
		changed := false
		kept := f.Terminals[:0]
		ok := map[string]bool{}
		for _, o := range f.Terminals {
			if o.TerminalID != "" && live[o.Pane] == o.TerminalID {
				kept = append(kept, o)
				ok[o.Pane] = true
			} else {
				changed = true
			}
		}
		f.Terminals = kept
		for r, p := range f.ByRoot {
			if !ok[p] {
				delete(f.ByRoot, r)
				changed = true
			}
		}
		return changed
	})
}

func (t *Terminals) forget(pane string) error {
	return t.update(func(f *termFile) bool {
		kept := f.Terminals[:0]
		for _, o := range f.Terminals {
			if o.Pane != pane {
				kept = append(kept, o)
			}
		}
		f.Terminals = kept
		for r, p := range f.ByRoot {
			if p == pane {
				delete(f.ByRoot, r)
			}
		}
		return true
	})
}

// livePanes devuelve pane → terminal_id de los paneles que existen en herdr.
func livePanes(ctx context.Context, c *herdr.Client) (map[string]string, error) {
	panes, err := c.ListPanes(ctx, "")
	if err != nil {
		return nil, err
	}
	live := make(map[string]string, len(panes))
	for _, x := range panes {
		live[x.ID] = x.TerminalID
	}
	return live, nil
}

// --- métodos term_* ---

type termOpenRes struct {
	Pane string `json:"pane"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func rpcTermOpen(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	var p struct {
		Root  string `json:"root"`
		Label string `json:"label"`
		New   bool   `json:"new"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if p.Root == "" || !filepath.IsAbs(p.Root) {
		return nil, errors.New("root debe ser una ruta absoluta")
	}
	if p.Label == "" {
		p.Label = filepath.Base(filepath.Clean(p.Root))
	}
	pane := ""
	if live, err := livePanes(ctx, h.Herdr); err == nil {
		if err := h.Terms.sync(live); err != nil {
			log.Printf("terminal: no se pudo actualizar herdr-terminals.json: %v", err)
		}
		if !p.New {
			pane = h.Terms.get(p.Root) // tras sync, solo si sigue vivo y es la misma terminal
		}
	}
	if pane == "" {
		wsID, fresh, err := launch.ResolveWorkspace(ctx, h.Herdr, h.WS, p.Root, p.Label, nil)
		if err != nil {
			return nil, fmt.Errorf("no se pudo abrir la terminal en herdr: %w", err)
		}
		pane = fresh
		if pane == "" {
			if pane, err = h.Herdr.CreateTab(ctx, wsID, p.Root, "terminal", nil); err != nil {
				return nil, fmt.Errorf("no se pudo abrir la terminal en herdr: %w", err)
			}
		}
		// el terminal_id identifica el panel aunque herdr reuse su id más adelante;
		// sin él, Quorum no lo recuerda y no lo podrá cerrar.
		live, err := livePanes(ctx, h.Herdr)
		if tid := live[pane]; err == nil && tid != "" {
			if err := h.Terms.add(p.Root, pane, tid); err != nil {
				log.Printf("terminal: no se pudo recordar %s: %v", pane, err)
			}
		} else {
			log.Printf("terminal: sin terminal_id para %s (%v); no se recuerda", pane, err)
		}
	}
	cols, rows, err := h.Herdr.PaneSize(ctx, pane)
	if err != nil {
		log.Printf("terminal: tamaño de %s: %v", pane, err)
	}
	return termOpenRes{Pane: pane, Cols: cols, Rows: rows}, nil
}

type paneParam struct {
	Pane string `json:"pane"`
}

func paneOf(params json.RawMessage) (string, error) {
	var p paneParam
	if err := decodeParams(params, &p); err != nil {
		return "", err
	}
	if p.Pane == "" {
		return "", errors.New("falta el panel")
	}
	return p.Pane, nil
}

func rpcTermWatch(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	pane, err := paneOf(params)
	if err != nil {
		return nil, err
	}
	l := linkOf(ctx)
	if l.reg == nil {
		return nil, errors.New("sin enlace con el hub")
	}
	h.watch(l.ctx, l.reg, pane)
	return struct{}{}, nil
}

func rpcTermInput(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	var p struct {
		Pane string   `json:"pane"`
		Text string   `json:"text"`
		Keys []string `json:"keys"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if p.Pane == "" {
		return nil, errors.New("falta el panel")
	}
	for _, k := range p.Keys {
		if !allowedKeys[k] {
			return nil, fmt.Errorf("tecla no permitida: %q", k)
		}
	}
	if p.Text != "" {
		if err := h.Herdr.SendText(ctx, p.Pane, p.Text); err != nil {
			return nil, err
		}
	}
	if len(p.Keys) > 0 {
		if err := h.Herdr.SendKeys(ctx, p.Pane, p.Keys); err != nil {
			return nil, err
		}
	}
	return struct{}{}, nil
}

func rpcTermRead(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	var p struct {
		Pane  string `json:"pane"`
		Lines int    `json:"lines"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if p.Pane == "" {
		return nil, errors.New("falta el panel")
	}
	if p.Lines <= 0 || p.Lines > termReadLines {
		p.Lines = termReadLines
	}
	text, err := h.Herdr.ReadPane(ctx, p.Pane, "recent", p.Lines)
	if err != nil {
		return nil, err
	}
	return map[string]string{"ansi": trimFront(text, termReadMax)}, nil
}

func rpcTermClose(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	pane, err := paneOf(params)
	if err != nil {
		return nil, err
	}
	tid := h.Terms.recorded(pane)
	if tid == "" {
		return nil, errNotOwnTerm
	}
	live, err := livePanes(ctx, h.Herdr)
	if err != nil {
		return nil, err
	}
	if err := h.Terms.sync(live); err != nil {
		log.Printf("terminal: no se pudo actualizar herdr-terminals.json: %v", err)
	}
	switch got, ok := live[pane]; {
	case !ok:
		return struct{}{}, nil // ya estaba cerrado; sync lo olvidó
	case got != tid:
		return nil, errNotOwnTerm // id reusado: ese panel ya no es el que abrió Quorum
	}
	if err := h.Herdr.ClosePane(ctx, pane); err != nil && !herdr.IsNotFound(err) {
		return nil, err
	}
	if err := h.Terms.forget(pane); err != nil {
		log.Printf("terminal: no se pudo olvidar %s: %v", pane, err)
	}
	return struct{}{}, nil
}

// trimFront deja s en max bytes como mucho quitando líneas del principio.
func trimFront(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := len(s) - max
	if i := strings.IndexByte(s[cut-1:], '\n'); i >= 0 {
		return s[cut+i:]
	}
	// una sola línea enorme: corta en un límite de runa
	for cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut++
	}
	return s[cut:]
}

// --- vigilante ---

// termWatch es el vigilante de un panel: vive mientras el lease esté vigente y
// el enlace con el hub siga abierto.
type termWatch struct {
	ctx    context.Context
	cancel context.CancelFunc
	until  time.Time // bajo Host.wmu
	resend bool      // bajo Host.wmu: manda el frame actual aunque no haya cambiado
}

// watch arranca o renueva el vigilante de pane. link es el ctx del enlace con el hub.
func (h *Host) watch(link context.Context, reg *Registry, pane string) {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	if h.watches == nil {
		h.watches = map[string]*termWatch{}
	}
	until := time.Now().Add(termLease)
	if w := h.watches[pane]; w != nil && w.ctx.Err() == nil {
		w.until = until
		// la app ignora frames anteriores a su montaje: cada term_watch (al abrir
		// la vista y cada 5 s) recibe el frame actual aunque no haya cambiado.
		w.resend = true
		return
	}
	ctx, cancel := context.WithCancel(link)
	w := &termWatch{ctx: ctx, cancel: cancel, until: until}
	h.watches[pane] = w
	go h.runWatch(w, reg, pane)
}

// alive dice si w debe seguir; si no, lo saca del mapa (si sigue siendo el suyo).
func (h *Host) alive(w *termWatch, pane string, closed bool) bool {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	if !closed && w.ctx.Err() == nil && time.Now().Before(w.until) {
		return true
	}
	if h.watches[pane] == w {
		delete(h.watches, pane)
	}
	w.cancel()
	return false
}

// takeResend dice si hay que reenviar el frame actual y baja la marca.
func (h *Host) takeResend(w *termWatch) bool {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	r := w.resend
	w.resend = false
	return r
}

// watching cuenta los vigilantes activos (para tests).
func (h *Host) watching() int {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	return len(h.watches)
}

func (h *Host) runWatch(w *termWatch, reg *Registry, pane string) {
	defer w.cancel()
	call := func(fn func(ctx context.Context) error) error {
		ctx, cancel := context.WithTimeout(w.ctx, termCallWait)
		defer cancel()
		return fn(ctx)
	}
	emit := func(f proto.TermFrame) {
		p, _ := json.Marshal(f)
		env := proto.Envelope{Type: "term_frame", Machine: reg.machine, Payload: p}
		if f.Closed {
			reg.EmitEnvelope(env) // el cierre no se puede perder: la app dejaría de esperar
			return
		}
		reg.EmitDroppable(env)
	}
	var (
		last             string
		cols, rows       int
		sentCols, sentRs int
		sent             bool
		sizeAt           time.Time
	)
	tick := time.NewTicker(termPoll)
	defer tick.Stop()
	for h.alive(w, pane, false) {
		if time.Since(sizeAt) >= termSize {
			sizeAt = time.Now()
			_ = call(func(ctx context.Context) error {
				c, r, err := h.Herdr.PaneSize(ctx, pane)
				if err == nil {
					cols, rows = c, r
				}
				return err
			})
		}
		var text string
		lines := rows
		if lines <= 0 {
			lines = 200
		}
		resend := h.takeResend(w)
		err := call(func(ctx context.Context) (err error) {
			text, err = h.Herdr.ReadPane(ctx, pane, "visible", lines)
			return err
		})
		if err != nil && resend {
			h.wmu.Lock()
			w.resend = true // no se pudo leer: que lo intente el próximo poll
			h.wmu.Unlock()
		}
		switch {
		case herdr.IsNotFound(err):
			emit(proto.TermFrame{Pane: pane, Closed: true})
			h.alive(w, pane, true)
			return
		case err == nil && (!sent || resend || text != last || cols != sentCols || rows != sentRs):
			emit(proto.TermFrame{Pane: pane, Cols: cols, Rows: rows, ANSI: trimFront(text, termFrameMax)})
			last, sentCols, sentRs, sent = text, cols, rows, true
		}
		select {
		case <-tick.C:
		case <-w.ctx.Done():
		}
	}
}
