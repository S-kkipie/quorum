package proto

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func TestEnvelopeRoundTrip(t *testing.T) {
	ev := Event{Seq: 1, Session: "s1", TS: 10, Kind: KindToolStart, Data: mustJSON(ToolStart{ID: "t1", Name: "Bash", Summary: "ls"})}
	env := Envelope{Type: "event", Machine: "vps1", Session: "s1", Payload: mustJSON(ev)}
	var back Envelope
	require.NoError(t, json.Unmarshal(mustJSON(env), &back))
	require.Equal(t, env, back)
	require.Contains(t, string(mustJSON(ev)), `"kind":"tool_start"`)
}
