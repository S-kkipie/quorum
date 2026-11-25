package board

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

type call struct {
	name string
	args []string
}

type fakeHerdr struct {
	calls []call
	out   map[string]string // first arg pair ("tab create") -> stdout
	err   error
}

func (f *fakeHerdr) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, call{name, args})
	if f.err != nil {
		return nil, f.err
	}
	return []byte(f.out[strings.Join(args[:2], " ")]), nil
}

func TestHerdrFocusUsesAgentFocus(t *testing.T) {
	f := &fakeHerdr{}
	h := &Herdr{Bin: "/opt/herdr", Run: f.run}
	require.NoError(t, h.Focus(context.Background(), "w1:p2"))
	require.Equal(t, []call{{"/opt/herdr", []string{"agent", "focus", "w1:p2"}}}, f.calls)
}

func TestHerdrOpenAttachCreatesTabAndRuns(t *testing.T) {
	f := &fakeHerdr{out: map[string]string{
		"tab create": `{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"w2:t4"},"root_pane":{"pane_id":"w2:p9"}}}`,
	}}
	h := &Herdr{Bin: "herdr", Run: f.run, Workspace: "w2", Self: "/usr/local/bin/quorum"}
	err := h.OpenAttach(context.Background(), proto.SessionInfo{ID: "abc-123", Machine: "vps-1", Name: "api"})
	require.NoError(t, err)
	require.Equal(t, []call{
		{"herdr", []string{"tab", "create", "--focus", "--label", "api · vps-1", "--workspace", "w2"}},
		{"herdr", []string{"pane", "run", "w2:p9", "'/usr/local/bin/quorum' attach 'abc-123'"}},
	}, f.calls)
}

func TestHerdrOpenAttachWithoutWorkspaceOrName(t *testing.T) {
	f := &fakeHerdr{out: map[string]string{
		"tab create": `{"result":{"root_pane":{"pane_id":"w1:p3"}}}`,
	}}
	h := &Herdr{Bin: "herdr", Run: f.run, Self: "/home/u/it's/quorum"}
	require.NoError(t, h.OpenAttach(context.Background(), proto.SessionInfo{ID: "s1", Machine: "vps-1"}))
	require.Equal(t, []string{"tab", "create", "--focus", "--label", "Session · vps-1"}, f.calls[0].args)
	require.Equal(t, `'/home/u/it'\''s/quorum' attach 's1'`, f.calls[1].args[3])
}

func TestHerdrOpenAttachBadOutput(t *testing.T) {
	f := &fakeHerdr{out: map[string]string{"tab create": `{"result":{}}`}}
	h := &Herdr{Bin: "herdr", Run: f.run, Self: "quorum"}
	require.ErrorContains(t, h.OpenAttach(context.Background(), proto.SessionInfo{ID: "s1"}), "no pane")
	require.Len(t, f.calls, 1)
}

func TestHerdrErrorMessage(t *testing.T) {
	require.Equal(t, "herdr: agent target w1:p2 not found",
		herdrError(errors.New("exit status 1"), []byte(`{"error":{"code":"agent_not_found","message":"agent target w1:p2 not found"},"id":"cli:agent:focus"}`)).Error())
	require.Equal(t, "herdr: exit status 1: boom", herdrError(errors.New("exit status 1"), []byte("boom\n")).Error())
	require.Equal(t, "herdr: exit status 1", herdrError(errors.New("exit status 1"), nil).Error())
}

// herdr 0.9.5 reads the token after --label literally (even "-x") and rejects "--label=<v>".
func TestHerdrOpenAttachDashLabelStaysLiteral(t *testing.T) {
	f := &fakeHerdr{out: map[string]string{
		"tab create": `{"result":{"root_pane":{"pane_id":"w2:p9"}}}`,
	}}
	h := &Herdr{Bin: "herdr", Run: f.run, Self: "quorum"}
	require.NoError(t, h.OpenAttach(context.Background(), proto.SessionInfo{ID: "s1", Machine: "vps-1", Name: "--focus"}))
	require.Equal(t, []string{"tab", "create", "--focus", "--label", "--focus · vps-1"}, f.calls[0].args)
}
