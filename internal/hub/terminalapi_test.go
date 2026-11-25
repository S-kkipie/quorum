package hub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

// fakeMachine connects a fake machine (replaces m1's connection) that answers each rpc with h.
// If h returns nil it does not answer. Each received rpc is recorded in got.
func fakeMachine(t *testing.T, f *appFx, tok, name string, h func(proto.RPC) *proto.RPCResult) (*websocket.Conn, chan proto.RPC) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The hub attaches the new connection asynchronously after hello and closes the
	// previous one: wait until the swap happened so no rpc reaches the old connection.
	f.srv.hub.mu.Lock()
	prev := f.srv.hub.conns[name]
	f.srv.hub.mu.Unlock()
	c, _, err := websocket.Dial(ctx, f.wsURL("/api/machine/ws"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok}}})
	require.NoError(t, err)
	t.Cleanup(func() { c.CloseNow() })
	c.SetReadLimit(8 << 20) // like the daemon: an upload chunk is ~1.4 MB
	sendHello(t, c, name)
	eventually(t, func() bool {
		f.srv.hub.mu.Lock()
		defer f.srv.hub.mu.Unlock()
		cur := f.srv.hub.conns[name]
		return cur != nil && cur != prev
	})
	got := make(chan proto.RPC, 16)
	go func() {
		for {
			var env proto.Envelope
			if wsjson.Read(context.Background(), c, &env) != nil {
				return
			}
			var r proto.RPC
			if env.Type != "rpc" || json.Unmarshal(env.Payload, &r) != nil {
				continue
			}
			got <- r
			if h == nil {
				continue
			}
			if res := h(r); res != nil {
				res.ReqID = r.ReqID
				_ = wsjson.Write(context.Background(), c, proto.Envelope{Type: "rpc_result", Payload: mustJSON(res)})
			}
		}
	}()
	return c, got
}

func (f *appFx) do(method, path, body string) (int, string) {
	req, _ := http.NewRequest(method, f.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func okResult(v any) *proto.RPCResult { return &proto.RPCResult{Result: mustJSON(v)} }

func TestConversationsProxied(t *testing.T) {
	f := newAppFx(t)
	_, got := fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult([]proto.Conversation{{ID: "c1", Title: "hola"}})
	})
	code, body := f.do("GET", "/api/machines/m1/conversations?root=/work/x", "")
	require.Equal(t, 200, code, body)
	var cs []proto.Conversation
	require.NoError(t, json.Unmarshal([]byte(body), &cs))
	require.Equal(t, "c1", cs[0].ID)
	r := <-got
	require.Equal(t, "conversations", r.Method)
	require.JSONEq(t, `{"root":"/work/x"}`, string(r.Params))
}

func TestRPCTimeout504(t *testing.T) {
	old := rpcTimeout
	rpcTimeout = 100 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = old })
	f := newAppFx(t)
	fakeMachine(t, f, f.machTok, "m1", nil)
	code, body := f.do("POST", "/api/machines/m1/terminals/p:1/watch", "")
	require.Equal(t, 504, code)
	require.Contains(t, body, "machine did not respond")
	f.srv.hub.rpcMu.Lock()
	require.Empty(t, f.srv.hub.waiters) // no leaks
	f.srv.hub.rpcMu.Unlock()
}

func TestTerminalOpenAudited(t *testing.T) {
	f := newAppFx(t)
	_, got := fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult(map[string]any{"pane": "w:1", "cols": 80, "rows": 24})
	})
	code, body := f.do("POST", "/api/machines/m1/terminals", `{"root":"/r","label":"x","new":true}`)
	require.Equal(t, 200, code, body)
	require.JSONEq(t, `{"pane":"w:1","cols":80,"rows":24}`, body)
	r := <-got
	require.Equal(t, "term_open", r.Method)
	require.JSONEq(t, `{"root":"/r","label":"x","new":true}`, string(r.Params))
	code, _ = f.do("DELETE", "/api/machines/m1/terminals/w:1", "")
	require.Equal(t, 204, code)
	rows, err := f.st.ListTerminalAudit()
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, [4]string{"tel", "m1", "w:1", "open"}, [4]string{rows[0].Device, rows[0].Machine, rows[0].Pane, rows[0].Action})
	require.Equal(t, "close", rows[1].Action)
}

func TestTerminalInputReadWatch(t *testing.T) {
	f := newAppFx(t)
	_, got := fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		if r.Method == "term_read" {
			return okResult(map[string]string{"ansi": "hola"})
		}
		return okResult(map[string]string{})
	})
	code, _ := f.do("POST", "/api/machines/m1/terminals/w%3A1/watch", "")
	require.Equal(t, 204, code)
	code, _ = f.do("POST", "/api/machines/m1/terminals/w:1/input", `{"text":"ls","keys":["enter"]}`)
	require.Equal(t, 204, code)
	code, body := f.do("GET", "/api/machines/m1/terminals/w:1/read?lines=50", "")
	require.Equal(t, 200, code)
	require.JSONEq(t, `{"ansi":"hola"}`, body)
	require.Equal(t, "term_watch", (<-got).Method)
	in := <-got
	require.Equal(t, "term_input", in.Method)
	require.JSONEq(t, `{"pane":"w:1","text":"ls","keys":["enter"]}`, string(in.Params))
	rd := <-got
	require.JSONEq(t, `{"pane":"w:1","lines":50}`, string(rd.Params))
}

func TestDaemonErrorIs409(t *testing.T) {
	f := newAppFx(t)
	fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult { return &proto.RPCResult{Error: "pane not found"} })
	code, body := f.do("POST", "/api/machines/m1/terminals/w:1/watch", "")
	require.Equal(t, 409, code)
	require.Contains(t, body, "pane not found")
}

func TestTermFrameRelayedNotStored(t *testing.T) {
	f := newAppFx(t, "s1")
	_, ch := f.live(t)
	f.machineSend(t, proto.Envelope{Type: "term_frame", Machine: "another", Payload: mustJSON(proto.TermFrame{Pane: "w:1", ANSI: "x"})})
	e := waitEnv(t, ch, func(e proto.Envelope) bool { return e.Type == "term_frame" })
	require.Equal(t, "m1", e.Machine)
	var tf proto.TermFrame
	require.NoError(t, json.Unmarshal(e.Payload, &tf))
	require.Equal(t, "w:1", tf.Pane)
	evs, err := f.st.Events("s1", 1<<40, 50)
	require.NoError(t, err)
	require.Empty(t, evs)
}

func TestTerminalOffline409(t *testing.T) {
	f := newAppFx(t)
	code, body := f.do("POST", "/api/machines/nobody/terminals/w:1/watch", "")
	require.Equal(t, 409, code)
	require.Contains(t, body, "machine is offline")
	code, _ = f.do("POST", "/api/machines/m1/terminals/w:1/input", `{"keys":["f13"]}`)
	require.Equal(t, 400, code)
}

func TestRPCFailsFastOnDisconnect(t *testing.T) {
	f := newAppFx(t)
	c, got := fakeMachine(t, f, f.machTok, "m1", nil)
	go func() { <-got; c.CloseNow() }()
	start := time.Now()
	code, body := f.do("POST", "/api/machines/m1/terminals/w:1/watch", "")
	require.Equal(t, 409, code)
	require.Contains(t, body, "offline")
	require.Less(t, time.Since(start), 5*time.Second)
}

func TestRPCResultFromOtherMachineIgnored(t *testing.T) {
	old := rpcTimeout
	rpcTimeout = 400 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = old })
	f := newAppFx(t)
	tok2, _ := NewToken()
	require.NoError(t, f.st.AddToken("machine", "m2", tok2))
	m2, _ := fakeMachine(t, f, tok2, "m2", nil)
	_, got := fakeMachine(t, f, f.machTok, "m1", nil)
	go func() {
		r := <-got
		_ = wsjson.Write(context.Background(), m2, proto.Envelope{Type: "rpc_result", Payload: mustJSON(proto.RPCResult{ReqID: r.ReqID, Result: mustJSON(map[string]string{})})})
	}()
	code, _ := f.do("POST", "/api/machines/m1/terminals/w:1/watch", "")
	require.Equal(t, 504, code)
}
