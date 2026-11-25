package hub

import (
	"encoding/json"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	maxTitleRunes = 80
	maxBodyRunes  = 120
)

// attentionText builds the notification text of an attention. sessionName is the name the app
// shows (recap, else name; empty when the session has none), ask the session's open ask event, if
// any: a permission ask names its tool, an AskUserQuestion says question.
func attentionText(sessionName, machine, kind string, ask *proto.Event) (title, body string) {
	name := strings.Join(strings.Fields(sessionName), " ")
	if name == "" {
		name = "Session"
	}
	title = name + " · " + machine
	switch kind {
	case "done":
		body = "Finished"
	default:
		body = "Needs you"
		if ask != nil {
			var a proto.Ask
			if json.Unmarshal(ask.Data, &a) == nil {
				tool := strings.Join(strings.Fields(a.Tool), " ")
				switch {
				case a.Kind == "question" || tool == "AskUserQuestion":
					body = "Needs you: question"
				case a.Kind == "permission" && tool != "":
					body = "Needs you: permission for " + tool
				}
			}
		}
	}
	return cutRunes(title, maxTitleRunes), cutRunes(body, maxBodyRunes)
}

// attentionName is the session name the app shows: the recap, else the name.
func attentionName(si proto.SessionInfo) string {
	if strings.TrimSpace(si.Recap) != "" {
		return si.Recap
	}
	return si.Name
}

// cutRunes cuts s to max runes, the last one being "…" when it was cut.
func cutRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}
