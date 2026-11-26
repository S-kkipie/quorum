package hub

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

const taskOutJSON = `{"found":true,"size":12,"mtime":1700000000,"tail":"hello\nworld","procsKnown":true,"procs":[{"pid":42,"state":"S","cpuMs":150}]}`

type taskFx struct {
	*appFx
	mu    sync.Mutex
	calls []map[string]string
	fail  string
}

func newTaskFx(t *testing.T) *taskFx {
	t.Helper()
	tf := &taskFx{appFx: newAppFx(t)}
	fakeMachine(t, tf.appFx, tf.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		if r.Method != "task_output" {
			return okResult(map[string]string{})
		}
		var p map[string]string
		_ = json.Unmarshal(r.Params, &p)
		tf.mu.Lock()
		defer tf.mu.Unlock()
		tf.calls = append(tf.calls, p)
		if tf.fail != "" {
			return &proto.RPCResult{Error: tf.fail}
		}
		return &proto.RPCResult{Result: json.RawMessage(taskOutJSON)}
	})
	eventually(t, func() bool { return tf.srv.hub.Connected("m1") })
	require.NoError(t, tf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: "/w", Cwd: "/w", State: proto.StateIdle}))
	require.NoError(t, tf.st.UpsertSession(proto.SessionInfo{ID: "off1", Machine: "m9", Root: "/w", Cwd: "/w", State: proto.StateIdle}))
	return tf
}

func (tf *taskFx) callCount() int {
	tf.mu.Lock()
	defer tf.mu.Unlock()
	return len(tf.calls)
}

func TestTaskOutputPassesThrough(t *testing.T) {
	tf := newTaskFx(t)
	code, body := tf.req(t, "GET", "/api/sessions/s1/tasks/bg_1-x/output", "")
	require.Equal(t, 200, code, body)
	require.JSONEq(t, taskOutJSON, body)
	require.Equal(t, []map[string]string{{"session": "s1", "task": "bg_1-x"}}, tf.calls)
}

func TestTaskOutputBadIDs(t *testing.T) {
	tf := newTaskFx(t)
	for _, p := range []string{"/api/sessions/s1/tasks/a.b/output", "/api/sessions/s1/tasks/a%20b/output",
		"/api/sessions/s%2e1/tasks/t1/output", "/api/sessions/s1/tasks/%2e%2e/output",
		"/api/sessions/s1/tasks/" + "x%00/output",
		"/api/sessions/s1/tasks/" + repeatA(129) + "/output"} {
		code, body := tf.req(t, "GET", p, "")
		require.Equal(t, 400, code, p+" "+body)
	}
	require.Equal(t, 0, tf.callCount())
}

func repeatA(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}

func TestTaskOutputUnknownSession(t *testing.T) {
	tf := newTaskFx(t)
	code, body := tf.req(t, "GET", "/api/sessions/nope/tasks/t1/output", "")
	require.Equal(t, 404, code, body)
	require.Equal(t, 0, tf.callCount())
}

func TestTaskOutputOfflineMachine(t *testing.T) {
	tf := newTaskFx(t)
	code, body := tf.req(t, "GET", "/api/sessions/off1/tasks/t1/output", "")
	require.Equal(t, 502, code, body)
	require.Contains(t, body, "offline")
}

func TestTaskOutputRPCError(t *testing.T) {
	tf := newTaskFx(t)
	tf.mu.Lock()
	tf.fail = "task store broke"
	tf.mu.Unlock()
	code, body := tf.req(t, "GET", "/api/sessions/s1/tasks/t1/output", "")
	require.Equal(t, 502, code, body)
	require.Contains(t, body, "task store broke")
}

func TestTaskOutputRequiresDevice(t *testing.T) {
	tf := newTaskFx(t)
	resp, err := http.Get(tf.ts.URL + "/api/sessions/s1/tasks/t1/output")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 401, resp.StatusCode)
	require.Equal(t, 0, tf.callCount())
}
