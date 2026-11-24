package hub

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

var testCmds = []proto.SessionCommand{
	{Name: "clear", Source: "builtin", Group: "session"},
	{Name: "config", Source: "builtin", Group: "session", TerminalOnly: true},
	{Name: "after", Source: "plugin", Plugin: "better-claude", Group: "plugin"},
	{Name: "timeline", Source: "plugin", Plugin: "better-claude", Group: "plugin"},
	{Name: "review", Source: "user", Group: "skill"},
}

func (f *appFx) sendCommands(t *testing.T, session, hash string, cmds []proto.SessionCommand) {
	p, _ := json.Marshal(proto.SessionCommands{Session: session, Commands: cmds, Hash: hash})
	f.machineSend(t, proto.Envelope{Type: "session_commands", Machine: "m1", Session: session, Payload: p})
}

func (f *appFx) getCommands(t *testing.T, id string) proto.SessionCommands {
	var sc proto.SessionCommands
	f.get(t, "/api/sessions/"+id+"/commands", &sc)
	return sc
}

func TestSessionCommandsStoredAndPublishedOnlyOnChange(t *testing.T) {
	f := newAppFx(t, "s1")
	_, ch := f.live(t)
	f.sendCommands(t, "s1", "h1", testCmds)
	var got proto.SessionCommands
	waitCmdsEnv(t, ch, "session_commands", &got)
	require.Equal(t, "h1", got.Hash)
	require.Equal(t, testCmds, got.Commands)
	require.Equal(t, got, f.getCommands(t, "s1"))
	// same hash again (a re-send after a hello): stored as is, nothing published
	f.sendCommands(t, "s1", "h1", testCmds)
	f.sendCommands(t, "s1", "h2", testCmds[:1])
	waitCmdsEnv(t, ch, "session_commands", &got)
	require.Equal(t, "h2", got.Hash, "the unchanged hash must not have been published")
	require.Len(t, got.Commands, 1)
}

func waitCmdsEnv(t *testing.T, ch chan proto.Envelope, typ string, into any) {
	t.Helper()
	for {
		select {
		case e := <-ch:
			if e.Type == typ {
				require.NoError(t, json.Unmarshal(e.Payload, into))
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("no %s envelope", typ)
		}
	}
}

func TestSessionCommandsOfAnotherMachineIgnored(t *testing.T) {
	f := newAppFx(t, "s1")
	f.sendCommands(t, "unknown", "h1", testCmds) // not a known session
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "foreign", Machine: "m2", State: proto.StateIdle}))
	f.sendCommands(t, "foreign", "h1", testCmds)
	f.sendCommands(t, "s1", "ok", testCmds[:1]) // processed after the two above (same connection)
	eventually(t, func() bool { _, ok, _ := f.st.Commands("s1"); return ok })
	_, ok, _ := f.st.Commands("foreign")
	require.False(t, ok)
	_, ok, _ = f.st.Commands("unknown")
	require.False(t, ok)
}

func TestCommandRouteValidation(t *testing.T) {
	f := newAppFx(t, "s1")
	code, msg := f.postBody("/api/sessions/s1/command", `{"command":"clear","args":""}`)
	require.Equal(t, 400, code)
	require.Contains(t, msg, "not available yet") // older mod: no list
	f.sendCommands(t, "s1", "h1", testCmds)
	eventually(t, func() bool { _, ok, _ := f.st.Commands("s1"); return ok })
	for body, want := range map[string]string{
		`{"command":"nope"}`:                 "Unknown command: /nope",
		`{"command":"config"}`:               "only works in the terminal",
		`{"command":"after","args":"  "}`:    "only works in the terminal",
		`{"command":"timeline"}`:             "only works in the terminal",
		`{"command":"review","args":"a\nb"}`: "single line",
		`{"command":"timeline","args":"x"}`:  "/timeline takes",
		`nope`:                               "",
	} {
		code, msg := f.postBody("/api/sessions/s1/command", body)
		require.Equal(t, 400, code, body)
		require.Contains(t, msg, want, body)
	}
	require.Equal(t, 202, f.post("/api/sessions/s1/command", `{"command":"review","args":"the diff"}`).StatusCode)
	require.Equal(t, proto.Command{Type: "command", Command: "review", Args: "the diff"}, f.nextCmd(t))
	require.Equal(t, 202, f.post("/api/sessions/s1/command", `{"command":"after","args":"fix it"}`).StatusCode)
	require.Equal(t, "after", f.nextCmd(t).Command)
	code, _ = f.postBody("/api/sessions/nope/command", `{"command":"clear"}`)
	require.Equal(t, 404, code)
}

func TestCommandRouteClosedSessionConflict(t *testing.T) {
	f := newAppFx(t, "s1")
	f.sendCommands(t, "s1", "h1", testCmds)
	eventually(t, func() bool { _, ok, _ := f.st.Commands("s1"); return ok })
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateClosed}))
	code, _ := f.postBody("/api/sessions/s1/command", `{"command":"clear"}`)
	require.Equal(t, 409, code)
	code, _ = f.postBody("/api/sessions/s1/model", `{"value":"opus"}`)
	require.Equal(t, 409, code)
}

func TestSetModelRoute(t *testing.T) {
	f := newAppFx(t)
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle, Effort: "high",
		ModelOptions: []proto.ModelOption{{Value: "opus", Label: "Opus"}, {Value: "sonnet", Label: "Sonnet"}}, EffortOptions: []string{"low", "high"}}))
	si, err := f.st.Session("s1")
	require.NoError(t, err)
	require.Equal(t, "high", si.Effort)
	require.Len(t, si.ModelOptions, 2)
	require.Equal(t, []string{"low", "high"}, si.EffortOptions)
	code, msg := f.postBody("/api/sessions/s1/model", `{"value":"gpt"}`)
	require.Equal(t, 400, code)
	require.Contains(t, msg, "Unknown model: gpt")
	require.Equal(t, 202, f.post("/api/sessions/s1/model", `{"value":"sonnet"}`).StatusCode)
	require.Equal(t, proto.Command{Type: "set_model", Value: "sonnet"}, f.nextCmd(t))
	// a session without options (older mod) cannot switch
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "m1", State: proto.StateIdle}))
	code, _ = f.postBody("/api/sessions/s2/model", `{"value":"opus"}`)
	require.Equal(t, 400, code)
}

func TestGetCommandsWithoutReport(t *testing.T) {
	f := newAppFx(t, "s1")
	sc := f.getCommands(t, "s1")
	require.Equal(t, "", sc.Hash)
	require.NotNil(t, sc.Commands)
	require.Empty(t, sc.Commands)
	code, _ := f.do("GET", "/api/sessions/nope/commands", "")
	require.Equal(t, 404, code)
}
