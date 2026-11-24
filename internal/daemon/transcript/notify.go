package transcript

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Caps shared with the mod's parser (mod/src/background.ts).
const (
	// NoticeMax bounds how much of a notification text is parsed: its head and its last noticeTail bytes.
	NoticeMax     = 256 << 10
	noticeTail    = 8 << 10
	outputTailMax = 2000
	summaryMax    = 500
)

var (
	endStatus = map[string]bool{"completed": true, "failed": true, "killed": true, "stopped": true,
		"cancelled": true, "canceled": true, "error": true, "timeout": true}
	exitInSummary = regexp.MustCompile(`(?i)exit code:?\s*(-?\d+)`)
	intRe         = regexp.MustCompile(`^-?\d+$`)
	kindCommand   = regexp.MustCompile(`(?i)^\s*((background\s+)?command\b|shell\b)`)
	kindMonitor   = regexp.MustCompile(`(?i)^\s*monitor\b`)
	kindSubagent  = regexp.MustCompile(`(?i)^\s*(agent|subagent)\b`)
)

// IsTaskNotification reports whether a user text is a notification Claude Code injected when a
// background task (command, monitor, subagent) reported (it starts with `<task-notification>`).
func IsTaskNotification(s string) bool {
	return strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "<task-notification>")
}

// tagOf is the trimmed text of the first <name>…</name> of body (linear).
func tagOf(body, name string) (string, bool) {
	open := strings.Index(body, "<"+name+">")
	if open < 0 {
		return "", false
	}
	from := open + len(name) + 2
	end := strings.Index(body[from:], "</"+name+">")
	if end < 0 {
		return "", false
	}
	return strings.TrimSpace(body[from : from+end]), true
}

// wideTag is the text between the first <name> and the last </name> (a result may quote markup).
func wideTag(body, name string) (string, bool) {
	open := strings.Index(body, "<"+name+">")
	end := strings.LastIndex(body, "</"+name+">")
	if open < 0 || end < open+len(name)+2 {
		return "", false
	}
	return strings.TrimSpace(body[open+len(name)+2 : end]), true
}

// cutBytes cuts s to at most n bytes at a rune boundary.
func cutBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// tailBytes keeps the last n bytes of s, starting at a rune boundary.
func tailBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && s[i]&0xC0 == 0x80 {
		i++
	}
	return s[i:]
}

func guessKind(summary string) string {
	switch {
	case kindCommand.MatchString(summary):
		return "command"
	case kindMonitor.MatchString(summary):
		return "monitor"
	case kindSubagent.MatchString(summary):
		return "subagent"
	}
	return "task"
}

// TaskEnds maps a notification text to one task_end per block whose status ends its task, as the
// mod does live (the kind is guessed from the summary: the transcript does not track tasks).
// Missing fields are tolerated; a block without a task id is skipped; the output file is never read.
func TaskEnds(text string) []proto.TaskEnd {
	if len(text) > NoticeMax {
		text = text[:NoticeMax-noticeTail] + text[len(text)-noticeTail:]
	}
	const open, closeTag = "<task-notification>", "</task-notification>"
	var out []proto.TaskEnd
	for at := strings.Index(text, open); at >= 0; {
		start := at + len(open)
		end := strings.Index(text[start:], closeTag)
		if end < 0 {
			break
		}
		whole := text[start : start+end]
		next := start + end + len(closeTag)
		// header tags are searched only before the result / output
		body := whole
		for _, t := range []string{"<result>", "<output>"} {
			if i := strings.Index(body, t); i >= 0 {
				body = body[:i]
			}
		}
		id, _ := tagOf(body, "task-id")
		status, _ := tagOf(body, "status")
		status = strings.ToLower(status)
		if id != "" && endStatus[status] {
			summary, _ := tagOf(body, "summary")
			summary = cutBytes(summary, summaryMax)
			te := proto.TaskEnd{TaskID: id, Kind: guessKind(summary), Summary: summary, Status: status}
			code, ok := tagOf(body, "exit-code")
			if !ok {
				if m := exitInSummary.FindStringSubmatch(summary); m != nil {
					code, ok = m[1], true
				}
			}
			if ok && intRe.MatchString(code) {
				if n, err := strconv.Atoi(code); err == nil {
					te.ExitCode = &n
				}
			}
			if o, ok := wideTag(whole, "result"); ok && o != "" {
				te.OutputTail = tailBytes(o, outputTailMax)
			} else if o, ok := wideTag(whole, "output"); ok && o != "" {
				te.OutputTail = tailBytes(o, outputTailMax)
			}
			out = append(out, te)
		}
		if i := strings.Index(text[next:], open); i >= 0 {
			at = next + i
		} else {
			at = -1
		}
	}
	return out
}
