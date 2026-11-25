package hub

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func askEvent(kind, tool string) *proto.Event {
	return &proto.Event{Session: "s1", Kind: proto.KindAsk, Data: mustJSON(proto.Ask{AskID: "a1", Kind: kind, Tool: tool})}
}

func TestAttentionTextBodies(t *testing.T) {
	cases := []struct {
		name, kind string
		ask        *proto.Event
		body       string
	}{
		{"permission", "needs_you", askEvent("permission", "Bash"), "Needs you: permission for Bash"},
		{"question", "needs_you", askEvent("question", "AskUserQuestion"), "Needs you: question"},
		{"question by tool", "needs_you", askEvent("", "AskUserQuestion"), "Needs you: question"},
		{"permission without tool", "needs_you", askEvent("permission", ""), "Needs you"},
		{"no ask", "needs_you", nil, "Needs you"},
		{"malformed ask", "needs_you", &proto.Event{Kind: proto.KindAsk, Data: []byte(`nope`)}, "Needs you"},
		{"done", "done", nil, "Finished"},
		{"done ignores an ask", "done", askEvent("permission", "Bash"), "Finished"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			title, body := attentionText("Fix the login", "vps-1", c.kind, c.ask)
			require.Equal(t, "Fix the login · vps-1", title)
			require.Equal(t, c.body, body)
		})
	}
}

func TestAttentionTextUnnamedSession(t *testing.T) {
	title, _ := attentionText("", "laptop", "done", nil)
	require.Equal(t, "Session · laptop", title)
	title, _ = attentionText("   ", "laptop", "done", nil)
	require.Equal(t, "Session · laptop", title, "a blank name counts as no name")
}

func TestAttentionTextCuts(t *testing.T) {
	long := strings.Repeat("a", 200)
	title, body := attentionText(long, "vps-1", "needs_you", askEvent("permission", strings.Repeat("T", 200)))
	require.Equal(t, 80, utf8.RuneCountInString(title))
	require.True(t, strings.HasSuffix(title, "…"))
	require.Equal(t, strings.Repeat("a", 79)+"…", title)
	require.Equal(t, 120, utf8.RuneCountInString(body))
	require.Equal(t, ("Needs you: permission for " + strings.Repeat("T", 200))[:119]+"…", body)

	// exactly at the limit: nothing is cut
	name := strings.Repeat("b", 80-len(" · vps-1"))
	title, _ = attentionText(name, "vps-1", "done", nil)
	require.Equal(t, name+" · vps-1", title)
	require.False(t, strings.HasSuffix(title, "…"))
}

func TestAttentionTextRuneSafe(t *testing.T) {
	emoji := strings.Repeat("\U0001F680", 100) // 4-byte runes
	title, _ := attentionText(emoji, "vps-1", "done", nil)
	require.True(t, utf8.ValidString(title))
	require.Equal(t, 80, utf8.RuneCountInString(title))
	require.Equal(t, strings.Repeat("\U0001F680", 79)+"…", title)

	cjk := strings.Repeat("修", 90)
	title, _ = attentionText(cjk, "laptop", "done", nil)
	require.True(t, utf8.ValidString(title))
	require.Equal(t, strings.Repeat("修", 79)+"…", title)

	short := "修复登录 \U0001F680"
	title, _ = attentionText(short, "laptop", "done", nil)
	require.Equal(t, short+" · laptop", title)
}

func TestAttentionTextFlattensWhitespace(t *testing.T) {
	title, _ := attentionText("Fix\nthe   login\t", "vps-1", "done", nil)
	require.Equal(t, "Fix the login · vps-1", title)
}
