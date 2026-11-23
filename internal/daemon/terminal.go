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

// Intervals of the terminal watcher; variables for tests.
var (
	termPoll  = 125 * time.Millisecond // pane.read: at most 8 frames per second
	termSize  = 2 * time.Second        // pane.layout
	termLease = 15 * time.Second       // the app renews it every 5 s while it is watching
)

const (
	termFrameMax  = 256 << 10 // bytes of ANSI per term_frame
	termReadMax   = 1 << 20   // bytes of ANSI for term_read (history)
	termReadLines = 2000
	termCallWait  = 3 * time.Second // deadline of each of the watcher's calls to herdr
	maxConvos     = 60
)

// userHome is replaced in tests (the real ~/.claude is never touched).
var userHome = os.UserHomeDir

var (
	errTermOff    = errors.New("terminal is disabled on this machine")
	errHerdrDown  = errors.New("herdr is not responding on this machine")
	errNotOwnTerm = errors.New("Quorum only closes terminals it opened")
)

// allowedKeys are the only keys (herdr names) that are sent to a pane.
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

// termOnly cuts off with errTermOff if the terminal is off and with errHerdrDown if
// herdr does not respond.
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
		return fmt.Errorf("invalid parameters: %w", err)
	}
	return nil
}

// --- conversations ---

func rpcConversations(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
	var p struct {
		Root string `json:"root"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if p.Root == "" || !filepath.IsAbs(p.Root) {
		return nil, errors.New("root must be an absolute path")
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

// --- own terminals (herdr-terminals.json) ---

// Terminals remembers the terminal panes Quorum opened, each with the
// terminal_id herdr gave it (pane ids are reused, e.g. after restarting
// herdr; the terminal_id is not). It keeps the last one of each root (to reuse it) and all
// the own ones (the only ones that can be closed). Empty Path: remembers nothing.
type Terminals struct {
	Path string
	mu   sync.Mutex
}

type ownedTerm struct {
	Pane       string `json:"pane"`
	TerminalID string `json:"terminalId"`
}

// termFile: the old format ("owned": bare ids, no terminal_id) is ignored on
// purpose: those entries cannot be verified and are never closed.
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

// update applies fn under the lock and saves if it returned true.
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

// get returns the remembered pane for root ("" if none).
func (t *Terminals) get(root string) string {
	if t == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.load().ByRoot[root]
}

// recorded returns the terminal_id with which Quorum opened pane ("" if it is not its own).
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

// sync forgets the own terminals that are no longer alive with the same
// terminal_id (live: pane → terminal_id according to pane.list).
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

// livePanes returns pane → terminal_id for the panes that exist in herdr.
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

// --- term_* methods ---

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
		return nil, errors.New("root must be an absolute path")
	}
	if p.Label == "" {
		p.Label = filepath.Base(filepath.Clean(p.Root))
	}
	pane := ""
	if live, err := livePanes(ctx, h.Herdr); err == nil {
		if err := h.Terms.sync(live); err != nil {
			log.Printf("terminal: could not update herdr-terminals.json: %v", err)
		}
		if !p.New {
			pane = h.Terms.get(p.Root) // after sync, only if still alive and the same terminal
		}
	}
	if pane == "" {
		wsID, fresh, err := launch.ResolveWorkspace(ctx, h.Herdr, h.WS, p.Root, p.Label, nil)
		if err != nil {
			return nil, fmt.Errorf("could not open the terminal in herdr: %w", err)
		}
		pane = fresh
		if pane == "" {
			if pane, err = h.Herdr.CreateTab(ctx, wsID, p.Root, "terminal", nil); err != nil {
				return nil, fmt.Errorf("could not open the terminal in herdr: %w", err)
			}
		}
		// the terminal_id identifies the pane even if herdr later reuses its id;
		// without it, Quorum does not remember it and will not be able to close it.
		live, err := livePanes(ctx, h.Herdr)
		if tid := live[pane]; err == nil && tid != "" {
			if err := h.Terms.add(p.Root, pane, tid); err != nil {
				log.Printf("terminal: could not remember %s: %v", pane, err)
			}
		} else {
			log.Printf("terminal: no terminal_id for %s (%v); not remembered", pane, err)
		}
	}
	cols, rows, err := h.Herdr.PaneSize(ctx, pane)
	if err != nil {
		log.Printf("terminal: size of %s: %v", pane, err)
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
		return "", errors.New("missing pane")
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
		return nil, errors.New("no link to the hub")
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
		return nil, errors.New("missing pane")
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
		return nil, errors.New("missing pane")
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
		log.Printf("terminal: could not update herdr-terminals.json: %v", err)
	}
	switch got, ok := live[pane]; {
	case !ok:
		return struct{}{}, nil // it was already closed; sync forgot it
	case got != tid:
		return nil, errNotOwnTerm // id reused: that pane is no longer the one Quorum opened
	}
	if err := h.Herdr.ClosePane(ctx, pane); err != nil && !herdr.IsNotFound(err) {
		return nil, err
	}
	if err := h.Terms.forget(pane); err != nil {
		log.Printf("terminal: could not forget %s: %v", pane, err)
	}
	return struct{}{}, nil
}

// trimFront leaves s at max bytes at most by removing lines from the start.
func trimFront(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := len(s) - max
	if i := strings.IndexByte(s[cut-1:], '\n'); i >= 0 {
		return s[cut+i:]
	}
	// a single huge line: cut at a rune boundary
	for cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut++
	}
	return s[cut:]
}

// --- watcher ---

// termWatch is a pane's watcher: it lives while the lease is valid and
// the link to the hub stays open.
type termWatch struct {
	ctx    context.Context
	cancel context.CancelFunc
	until  time.Time // under Host.wmu
	resend bool      // under Host.wmu: sends the current frame even if it has not changed
}

// watch starts or renews pane's watcher. link is the ctx of the link to the hub.
func (h *Host) watch(link context.Context, reg *Registry, pane string) {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	if h.watches == nil {
		h.watches = map[string]*termWatch{}
	}
	until := time.Now().Add(termLease)
	if w := h.watches[pane]; w != nil && w.ctx.Err() == nil {
		w.until = until
		// the app ignores frames earlier than its mount: each term_watch (on opening
		// the view and every 5 s) receives the current frame even if it has not changed.
		w.resend = true
		return
	}
	ctx, cancel := context.WithCancel(link)
	w := &termWatch{ctx: ctx, cancel: cancel, until: until}
	h.watches[pane] = w
	go h.runWatch(w, reg, pane)
}

// alive reports whether w should continue; if not, it removes it from the map (if it is still its own).
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

// takeResend reports whether the current frame must be resent and clears the flag.
func (h *Host) takeResend(w *termWatch) bool {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	r := w.resend
	w.resend = false
	return r
}

// watching counts the active watchers (for tests).
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
			reg.EmitEnvelope(env) // the close cannot be lost: the app would stop waiting
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
			w.resend = true // could not read: let the next poll retry
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
