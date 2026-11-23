package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// fastTerm acorta los intervalos del vigilante.
func fastTerm(t *testing.T, lease time.Duration) {
	oP, oS, oL := termPoll, termSize, termLease
	termPoll, termSize, termLease = 5*time.Millisecond, 20*time.Millisecond, lease
	t.Cleanup(func() { termPoll, termSize, termLease = oP, oS, oL })
}

// termFake es un herdr falso con un workspace w1 y un panel w1:p1 en /proj;
// tab.create agrega paneles nuevos a pane.list.
type termFake struct {
	*herdrtest.Fake
	mu    sync.Mutex
	panes []map[string]any
	n     int
}

func newTermFake(t *testing.T) *termFake {
	f := &termFake{Fake: herdrtest.New(t)}
	f.panes = []map[string]any{{"pane_id": "w1:p1", "workspace_id": "w1", "terminal_id": "term_p1", "cwd": "/proj"}}
	f.Handle("workspace.list", func(json.RawMessage) (any, string) {
		return map[string]any{"workspaces": []any{map[string]any{"workspace_id": "w1", "number": 1}}}, ""
	})
	f.Handle("pane.list", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return map[string]any{"panes": append([]map[string]any(nil), f.panes...)}, ""
	})
	f.Handle("tab.create", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.n++
		id := "w1:t" + string(rune('0'+f.n))
		f.panes = append(f.panes, map[string]any{"pane_id": id, "workspace_id": "w1", "terminal_id": "term_" + id, "cwd": "/proj"})
		return map[string]any{"root_pane": map[string]any{"pane_id": id}}, ""
	})
	f.Handle("pane.layout", func(p json.RawMessage) (any, string) {
		var in struct {
			Pane string `json:"pane_id"`
		}
		json.Unmarshal(p, &in)
		return map[string]any{"layout": map[string]any{"panes": []any{
			map[string]any{"pane_id": in.Pane, "rect": map[string]any{"width": 80, "height": 24}},
		}}}, ""
	})
	ok := func(json.RawMessage) (any, string) { return map[string]any{}, "" }
	f.Handle("pane.send_text", ok)
	f.Handle("pane.send_keys", ok)
	f.Handle("pane.close", ok)
	return f
}

func (f *termFake) removePane(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, p := range f.panes {
		if p["pane_id"] == id {
			f.panes = append(f.panes[:i], f.panes[i+1:]...)
			return
		}
	}
}

// recycle simula que herdr reinició y reusó el id del panel para otra terminal.
func (f *termFake) recycle(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.panes {
		if p["pane_id"] == id {
			p["terminal_id"] = "term_otra"
		}
	}
}

func (f *termFake) count(method string) int {
	n := 0
	for _, c := range f.Calls() {
		if c.Method == method {
			n++
		}
	}
	return n
}

func termHost(t *testing.T, sock string) *Host {
	dir := t.TempDir()
	return &Host{
		Herdr:      &herdr.Client{Socket: sock},
		WS:         &launch.Workspaces{Path: filepath.Join(dir, "ws.json")},
		Terms:      &Terminals{Path: filepath.Join(dir, "herdr-terminals.json")},
		TerminalOn: true,
	}
}

func linkCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

func call(t *testing.T, ctx context.Context, h *Host, reg *Registry, method string, params any) (json.RawMessage, error) {
	t.Helper()
	p, _ := json.Marshal(params)
	res, err := invokeRPC(ctx, h, reg, proto.RPC{Method: method, Params: p})
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(res)
	return b, nil
}

type openRes struct {
	Pane string `json:"pane"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func termOpen(t *testing.T, h *Host, root string, isNew bool) openRes {
	t.Helper()
	b, err := call(t, context.Background(), h, NewRegistry("m1"), "term_open", map[string]any{"root": root, "label": "proj", "new": isNew})
	require.NoError(t, err)
	var r openRes
	require.NoError(t, json.Unmarshal(b, &r))
	return r
}

// frames saca de la cola los term_frame que haya ahora mismo.
func frames(reg *Registry) []proto.TermFrame {
	var out []proto.TermFrame
	for {
		select {
		case e := <-reg.Out():
			if e.Type == "term_frame" {
				var f proto.TermFrame
				json.Unmarshal(e.Payload, &f)
				out = append(out, f)
			}
		default:
			return out
		}
	}
}

func TestTermOpenReuses(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	a := termOpen(t, h, "/proj", false)
	require.Equal(t, openRes{Pane: "w1:t1", Cols: 80, Rows: 24}, a)
	b := termOpen(t, h, "/proj", false)
	require.Equal(t, a, b)
	require.Equal(t, 1, f.count("tab.create"))

	// queda recordado en disco: otro Host con el mismo fichero lo reusa
	h2 := termHost(t, f.Socket)
	h2.Terms.Path = h.Terms.Path
	require.Equal(t, "w1:t1", termOpen(t, h2, "/proj", false).Pane)
	require.Equal(t, 1, f.count("tab.create"))

	// el tab.create va sin robar el foco, en /proj y con label "terminal"
	for _, c := range f.Calls() {
		if c.Method == "tab.create" {
			require.JSONEq(t, `{"workspace_id":"w1","cwd":"/proj","label":"terminal","focus":false}`, string(c.Params))
		}
	}

	// si el panel recordado ya no existe, abre otro
	f.removePane("w1:t1")
	require.Equal(t, "w1:t2", termOpen(t, h, "/proj", false).Pane)
}

func TestTermOpenNewCreatesTab(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	a := termOpen(t, h, "/proj", false)
	b := termOpen(t, h, "/proj", true)
	require.NotEqual(t, a.Pane, b.Pane)
	require.Equal(t, 2, f.count("tab.create"))
	// la siguiente sin new reusa la última
	require.Equal(t, b.Pane, termOpen(t, h, "/proj", false).Pane)
	// ambas son de Quorum: se pueden cerrar
	ctx := context.Background()
	_, err := call(t, ctx, h, NewRegistry("m1"), "term_close", map[string]any{"pane": a.Pane})
	require.NoError(t, err)
	_, err = call(t, ctx, h, NewRegistry("m1"), "term_close", map[string]any{"pane": b.Pane})
	require.NoError(t, err)
}

func TestTermOpenFreshWorkspace(t *testing.T) {
	f := newTermFake(t)
	f.Handle("workspace.list", func(json.RawMessage) (any, string) { return map[string]any{"workspaces": []any{}}, "" })
	f.Handle("workspace.create", func(json.RawMessage) (any, string) {
		f.mu.Lock()
		f.panes = append(f.panes, map[string]any{"pane_id": "w9:p1", "workspace_id": "w9", "terminal_id": "term_w9", "cwd": "/otro"})
		f.mu.Unlock()
		return map[string]any{"workspace": map[string]any{"workspace_id": "w9"}, "root_pane": map[string]any{"pane_id": "w9:p1"}}, ""
	})
	h := termHost(t, f.Socket)
	require.Equal(t, "w9:p1", termOpen(t, h, "/otro", false).Pane)
	require.Equal(t, 0, f.count("tab.create"))
	_, err := call(t, context.Background(), h, NewRegistry("m1"), "term_close", map[string]any{"pane": "w9:p1"})
	require.NoError(t, err)
}

// readSeq hace que pane.read devuelva los textos en orden y luego repita el último.
func readSeq(f *termFake, texts ...string) *atomic.Int32 {
	var n atomic.Int32
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		i := int(n.Add(1)) - 1
		if i >= len(texts) {
			i = len(texts) - 1
		}
		return map[string]any{"read": map[string]any{"text": texts[i]}}, ""
	})
	return &n
}

func watch(t *testing.T, ctx context.Context, h *Host, reg *Registry, pane string) {
	t.Helper()
	_, err := call(t, ctx, h, reg, "term_watch", map[string]any{"pane": pane})
	require.NoError(t, err)
}

func TestTermWatchEmitsOnlyOnChange(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	reads := readSeq(f, "uno", "uno", "uno", "dos")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx := linkCtx(t)
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool { return reads.Load() >= 10 }, 3*time.Second, 5*time.Millisecond)
	got := frames(reg)
	require.Len(t, got, 2)
	require.Equal(t, proto.TermFrame{Pane: "w1:p1", Cols: 80, Rows: 24, ANSI: "uno"}, got[0])
	require.Equal(t, "dos", got[1].ANSI)

	// renovar el lease no arranca un segundo vigilante ni repite frames
	watch(t, ctx, h, reg, "w1:p1")
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, frames(reg))
	require.Less(t, reads.Load()-n, int32(20)) // ~10 lecturas en 50 ms con un solo vigilante
}

func TestTermWatchEnvelope(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	readSeq(f, "x")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	watch(t, linkCtx(t), h, reg, "w1:p1")
	select {
	case e := <-reg.Out():
		require.Equal(t, "term_frame", e.Type)
		require.Equal(t, "m1", e.Machine)
	case <-time.After(2 * time.Second):
		t.Fatal("sin frame")
	}
}

func TestTermWatchClosed(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	var reads atomic.Int32
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		if reads.Add(1) > 2 {
			return nil, "not_found"
		}
		return map[string]any{"read": map[string]any{"text": "hola"}}, ""
	})
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	watch(t, linkCtx(t), h, reg, "w1:p1")
	var got []proto.TermFrame
	require.Eventually(t, func() bool {
		got = append(got, frames(reg)...)
		return len(got) == 2
	}, 3*time.Second, 5*time.Millisecond)
	require.Equal(t, proto.TermFrame{Pane: "w1:p1", Closed: true}, got[1])
	// el vigilante terminó: no lee más
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, n, reads.Load())
	require.Equal(t, 0, h.watching())
}

func TestTermWatchLeaseExpires(t *testing.T) {
	fastTerm(t, 80*time.Millisecond)
	f := newTermFake(t)
	reads := readSeq(f, "x")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx := linkCtx(t)
	watch(t, ctx, h, reg, "w1:p1")
	// renovar antes de que venza lo extiende
	time.Sleep(50 * time.Millisecond)
	watch(t, ctx, h, reg, "w1:p1")
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, 1, h.watching())
	require.Eventually(t, func() bool { return h.watching() == 0 }, 2*time.Second, 5*time.Millisecond)
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, n, reads.Load())

	// tras vencer, otro term_watch arranca un vigilante nuevo y manda la pantalla otra vez
	frames(reg)
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool { return len(frames(reg)) == 1 }, 2*time.Second, 5*time.Millisecond)
}

func TestTermWatchStopsWithLink(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	reads := readSeq(f, "x")
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	ctx, cancel := context.WithCancel(context.Background())
	watch(t, ctx, h, reg, "w1:p1")
	require.Eventually(t, func() bool { return reads.Load() > 2 }, 2*time.Second, 5*time.Millisecond)
	cancel()
	require.Eventually(t, func() bool { return h.watching() == 0 }, 2*time.Second, 5*time.Millisecond)
	n := reads.Load()
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, n, reads.Load())

	// un enlace nuevo vuelve a vigilar el mismo panel
	frames(reg)
	watch(t, linkCtx(t), h, reg, "w1:p1")
	require.Eventually(t, func() bool { return len(frames(reg)) == 1 }, 2*time.Second, 5*time.Millisecond)
}

func TestTermFrameTruncated(t *testing.T) {
	var sb strings.Builder
	for i := 0; sb.Len() < 300<<10; i++ {
		sb.WriteString(strings.Repeat("a", 99) + "\n")
	}
	sb.WriteString("FINAL")
	s := sb.String()
	got := trimFront(s, termFrameMax)
	require.LessOrEqual(t, len(got), termFrameMax)
	require.True(t, strings.HasSuffix(got, "FINAL"))
	require.True(t, strings.HasSuffix(s, got))
	require.Equal(t, byte('\n'), s[len(s)-len(got)-1]) // corta en un límite de línea
	require.Equal(t, "corto", trimFront("corto", termFrameMax))

	// también en el vigilante
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	readSeq(f, s)
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	watch(t, linkCtx(t), h, reg, "w1:p1")
	var fr []proto.TermFrame
	require.Eventually(t, func() bool { fr = append(fr, frames(reg)...); return len(fr) > 0 }, 2*time.Second, 5*time.Millisecond)
	require.Equal(t, got, fr[0].ANSI)
}

func TestTermInputRejectsUnknownKey(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	ctx, reg := context.Background(), NewRegistry("m1")
	_, err := call(t, ctx, h, reg, "term_input", map[string]any{"pane": "w1:p1", "text": "ls", "keys": []string{"enter", "f1"}})
	require.EqualError(t, err, `tecla no permitida: "f1"`)
	require.Equal(t, 0, f.count("pane.send_text"))
	require.Equal(t, 0, f.count("pane.send_keys"))

	_, err = call(t, ctx, h, reg, "term_input", map[string]any{"pane": "w1:p1", "text": "ls", "keys": []string{"enter", "ctrl+c"}})
	require.NoError(t, err)
	var order []string
	for _, c := range f.Calls() {
		switch c.Method {
		case "pane.send_text":
			order = append(order, c.Method)
			require.JSONEq(t, `{"pane_id":"w1:p1","text":"ls"}`, string(c.Params))
		case "pane.send_keys":
			order = append(order, c.Method)
			require.JSONEq(t, `{"pane_id":"w1:p1","keys":["enter","ctrl+c"]}`, string(c.Params))
		}
	}
	require.Equal(t, []string{"pane.send_text", "pane.send_keys"}, order)
}

func TestTermRead(t *testing.T) {
	f := newTermFake(t)
	f.Handle("pane.read", func(json.RawMessage) (any, string) {
		return map[string]any{"read": map[string]any{"text": "historial"}}, ""
	})
	h := termHost(t, f.Socket)
	b, err := call(t, context.Background(), h, NewRegistry("m1"), "term_read", map[string]any{"pane": "w1:p1", "lines": 99999})
	require.NoError(t, err)
	require.JSONEq(t, `{"ansi":"historial"}`, string(b))
	var p struct {
		Source string `json:"source"`
		Lines  int    `json:"lines"`
	}
	for _, c := range f.Calls() {
		if c.Method == "pane.read" {
			json.Unmarshal(c.Params, &p)
		}
	}
	require.Equal(t, "recent", p.Source)
	require.Equal(t, 2000, p.Lines)
}

func TestTermCloseOnlyOwn(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	ctx, reg := context.Background(), NewRegistry("m1")
	_, err := call(t, ctx, h, reg, "term_close", map[string]any{"pane": "w1:p1"})
	require.EqualError(t, err, "Quorum solo cierra terminales que abrió")
	require.Equal(t, 0, f.count("pane.close"))

	own := termOpen(t, h, "/proj", false).Pane
	_, err = call(t, ctx, h, reg, "term_close", map[string]any{"pane": own})
	require.NoError(t, err)
	require.Equal(t, 1, f.count("pane.close"))
	// ya cerrado: deja de ser suyo
	_, err = call(t, ctx, h, reg, "term_close", map[string]any{"pane": own})
	require.EqualError(t, err, "Quorum solo cierra terminales que abrió")
	require.Equal(t, 1, f.count("pane.close"))
}

func TestTermDisabled(t *testing.T) {
	f := newTermFake(t)
	off := termHost(t, f.Socket)
	off.TerminalOn = false
	none := termHost(t, filepath.Join(t.TempDir(), "none.sock"))
	for h, want := range map[*Host]string{off: "la terminal está desactivada en esta máquina", none: "herdr no responde en esta máquina"} {
		for _, m := range []string{"term_open", "term_watch", "term_input", "term_read", "term_close"} {
			_, err := call(t, context.Background(), h, NewRegistry("m1"), m, map[string]any{"pane": "w1:p1", "root": "/proj"})
			require.EqualError(t, err, want, m)
		}
	}
	for _, c := range f.Calls() {
		require.Equal(t, "workspace.list", c.Method) // solo se comprobó si herdr responde
	}
}

func TestConversationsRPC(t *testing.T) {
	home := t.TempDir()
	old := userHome
	userHome = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHome = old })
	dir := filepath.Join(home, ".claude", "projects", "-proj-x")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	line := `{"type":"user","message":{"role":"user","content":"hola"}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(line), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "s2.jsonl"), []byte(line), 0o600))

	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s2"})
	b, err := call(t, context.Background(), noHerdrHost(t), reg, "conversations", map[string]any{"root": "/proj/x"})
	require.NoError(t, err)
	var got []proto.Conversation
	require.NoError(t, json.Unmarshal(b, &got))
	require.Len(t, got, 2)
	open := map[string]bool{}
	for _, c := range got {
		open[c.ID] = c.Open
	}
	require.Equal(t, map[string]bool{"s1": false, "s2": true}, open)

	_, err = call(t, context.Background(), noHerdrHost(t), reg, "conversations", map[string]any{"root": "relativa"})
	require.Error(t, err)
}

func TestRPCPerCallTimeout(t *testing.T) {
	old := rpcTimeout
	rpcTimeout = 30 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = old })
	rpcHandlers["lento"] = func(ctx context.Context, _ *Host, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	t.Cleanup(func() { delete(rpcHandlers, "lento") })
	done := make(chan error, 1)
	go func() {
		_, err := invokeRPC(context.Background(), noHerdrHost(t), NewRegistry("m1"), proto.RPC{Method: "lento"})
		done <- err
	}()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.DeadlineExceeded)
	case <-time.After(2 * time.Second):
		t.Fatal("el handler no se cortó")
	}
}

func TestTermCloseRefusesReusedPaneID(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	ctx, reg := context.Background(), NewRegistry("m1")
	own := termOpen(t, h, "/proj", false).Pane
	f.recycle(own) // mismo id, otra terminal (p. ej. herdr reinició)
	_, err := call(t, ctx, h, reg, "term_close", map[string]any{"pane": own})
	require.EqualError(t, err, "Quorum solo cierra terminales que abrió")
	require.Equal(t, 0, f.count("pane.close"))
	// y quedó olvidado: tampoco se reusa al abrir
	require.NotEqual(t, own, termOpen(t, h, "/proj", false).Pane)
}

func TestTermOpenDoesNotReuseRecycledID(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	own := termOpen(t, h, "/proj", false).Pane
	f.recycle(own)
	require.NotEqual(t, own, termOpen(t, h, "/proj", false).Pane)
	require.Equal(t, 2, f.count("tab.create"))
}

func TestTermCloseIgnoresLegacyEntries(t *testing.T) {
	f := newTermFake(t)
	h := termHost(t, f.Socket)
	// formato viejo: ids sin terminal_id → no son cerrables
	require.NoError(t, os.WriteFile(h.Terms.Path, []byte(`{"byRoot":{"/proj":"w1:p1"},"owned":["w1:p1"]}`), 0o600))
	_, err := call(t, context.Background(), h, NewRegistry("m1"), "term_close", map[string]any{"pane": "w1:p1"})
	require.EqualError(t, err, "Quorum solo cierra terminales que abrió")
	require.Equal(t, 0, f.count("pane.close"))
	require.NotEqual(t, "w1:p1", termOpen(t, h, "/proj", false).Pane)
}

func TestRPCTimeoutMessage(t *testing.T) {
	old := rpcTimeout
	rpcTimeout = 30 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = old })
	rpcHandlers["lento"] = func(ctx context.Context, _ *Host, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	t.Cleanup(func() { delete(rpcHandlers, "lento") })
	reg := NewRegistry("m1")
	handleRPC(context.Background(), noHerdrHost(t), reg, proto.RPC{ReqID: "q9", Method: "lento"})
	e := <-reg.Out()
	var res proto.RPCResult
	require.NoError(t, json.Unmarshal(e.Payload, &res))
	require.Equal(t, "q9", res.ReqID)
	require.Equal(t, "la operación tardó demasiado en la máquina", res.Error)
	require.Equal(t, 9*time.Second, old)
}

// Revisión final: el frame de cierre no es descartable; con la cola llena espera
// a que haya sitio en vez de perderse.
func TestTermWatchClosedNotDroppable(t *testing.T) {
	fastTerm(t, time.Minute)
	f := newTermFake(t)
	f.Handle("pane.read", func(json.RawMessage) (any, string) { return nil, "not_found" })
	h := termHost(t, f.Socket)
	reg := NewRegistry("m1")
	for len(reg.out) < cap(reg.out) {
		reg.out <- proto.Envelope{Type: "x"}
	}
	watch(t, linkCtx(t), h, reg, "w1:p1")
	time.Sleep(100 * time.Millisecond) // el vigilante ya está esperando sitio
	var got []proto.TermFrame
	require.Eventually(t, func() bool {
		got = append(got, frames(reg)...)
		return len(got) == 1
	}, 3*time.Second, 5*time.Millisecond)
	require.Equal(t, proto.TermFrame{Pane: "w1:p1", Closed: true}, got[0])
}
