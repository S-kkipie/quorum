package hub

import (
	"bytes"
	"encoding/json"
	"github.com/S-kkipie/quorum/internal/proto"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The same table is read by the mod's validatePluginCommand (mod/test/plugincmd.test.ts).
func TestValidatePluginCommandSharedCases(t *testing.T) {
	raw, err := os.ReadFile("../../mod/test/plugin-command-cases.ts")
	require.NoError(t, err)
	raw = bytes.TrimSpace(bytes.TrimPrefix(raw[bytes.Index(raw, []byte("export default")):], []byte("export default")))
	var cases []struct {
		Command, Args, Note string
		OK                  bool `json:"ok"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)
	for _, c := range cases {
		got := validatePluginCommand(c.Command, c.Args) == ""
		require.Equal(t, c.OK, got, "%s: %q %.20q", c.Note, c.Command, c.Args)
	}
}

func TestPluginCommandRoute(t *testing.T) {
	f := newAppFx(t, "s1")
	for _, body := range []string{`{"command":"rm","args":""}`, `{"command":"after","args":"a\nb"}`, `{"command":"timeline","args":"x"}`, `nope`} {
		code, _ := f.postBody("/api/sessions/s1/plugin", body)
		require.Equal(t, 400, code, body)
	}
	code, msg := f.postBody("/api/sessions/s1/plugin", `{"command":"rm"}`)
	require.Equal(t, 400, code)
	require.Contains(t, msg, "Unsupported plugin command: rm")
	require.Equal(t, 204, f.post("/api/sessions/s1/plugin", `{"command":"after","args":"fix it"}`).StatusCode)
	c := f.nextCmd(t)
	require.Equal(t, "plugin", c.Type)
	require.Equal(t, "after", c.Command)
	require.Equal(t, "fix it", c.Args)
	code, _ = f.postBody("/api/sessions/nope/plugin", `{"command":"after","args":"x"}`)
	require.Equal(t, 404, code)
}

func TestPluginStateRoute(t *testing.T) {
	f := newAppFx(t, "s1")
	_, got := fakeMachine(t, f, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		return okResult([]map[string]string{{"text": "a"}})
	})
	require.NoError(t, f.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", State: proto.StateIdle, ConfigDir: "/home/u/.claude"}))
	code, body := f.do("GET", "/api/sessions/s1/plugins/after", "")
	require.Equal(t, 200, code, body)
	require.JSONEq(t, `[{"text":"a"}]`, body)
	r := <-got
	require.Equal(t, "plugin_state", r.Method)
	require.JSONEq(t, `{"configDir":"/home/u/.claude","plugin":"after","session":"s1"}`, string(r.Params))
	code, _ = f.do("GET", "/api/sessions/s1/plugins/evil", "")
	require.Equal(t, 400, code)
	code, _ = f.do("GET", "/api/sessions/nope/plugins/after", "")
	require.Equal(t, 404, code)
}
