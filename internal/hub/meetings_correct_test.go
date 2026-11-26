package hub

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// fakeChat answers each correction prompt with answer(call, user) and records the user texts.
type fakeChat struct {
	mu     sync.Mutex
	users  []string
	answer func(n int, user string) (string, error)
}

func (f *fakeChat) chat(_ context.Context, msgs []chatMsg) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	user := msgs[len(msgs)-1].Content
	f.users = append(f.users, user)
	return f.answer(len(f.users), user)
}

func segsOf(texts ...string) []proto.MeetingSegment {
	out := make([]proto.MeetingSegment, len(texts))
	for i, t := range texts {
		out[i] = seg(int64(i*5), "Speaker 1", t)
	}
	return out
}

func TestWordEditDistance(t *testing.T) {
	require.Equal(t, 0, wordEditDistance("La Guía", "la guía"))
	require.Equal(t, 1, wordEditDistance("la nota de sorvan", "la nota de zorvan"))
	require.Equal(t, 2, wordEditDistance("a b c", "a"))
	require.Equal(t, 3, wordEditDistance("", "x y z"))
	require.Equal(t, 0, wordEditDistance("Hola, ¿qué tal?", "hola qué tal")) // punctuation is not a word change
}

func TestCorrectionGuard(t *testing.T) {
	for _, c := range []struct {
		orig, fixed string
		ok          bool
	}{
		{"Zorvanit.", "Zorvanite.", true},                                              // a one-word name fix
		{"Quilon Labs", "Quillon Labs", true},                                          // 2 words, one changed
		{"hola, ¿qué tal", "Hola. ¿Qué tal?", true},                                    // punctuation only: distance 0
		{"we ship the zorvanit beta", "we ship the zorvanite build", true},             // 2 of 5
		{"we will ship the new beta soon", "we will launch a fresh build soon", false}, // 3 of 7
		{"we should release it tomorrow", "we must launch it today", false},            // a paraphrase, 3 of 5
		{"ok", "", false},
		{"same text", "same  text", false},
	} {
		_, ok := acceptCorrection(c.orig, c.fixed)
		require.Equal(t, c.ok, ok, "%q → %q", c.orig, c.fixed)
	}
}

func TestCorrectDropsAChunkThatChangedMost(t *testing.T) {
	segs := make([]proto.MeetingSegment, 124)
	for i := range segs {
		segs[i] = seg(int64(i), "Speaker 1", fmt.Sprintf("line %d about zorvanit", i))
	}
	segs[3].Text = "  " // not spoken: left out of the share
	fc := &fakeChat{answer: func(n int, _ string) (string, error) {
		var items []string
		if n == 1 { // 60 of the chunk's 119 spoken segments: more than half
			for i := 0; i < 61; i++ {
				if i != 3 {
					items = append(items, fmt.Sprintf(`{"i":%d,"text":"line %d about zorvanite"}`, i, i))
				}
			}
		} else { // 2 of 4: exactly half is kept
			items = []string{`{"i":120,"text":"line 120 about zorvanite"}`, `{"i":121,"text":"line 121 about zorvanite"}`}
		}
		return "[" + strings.Join(items, ",") + "]", nil
	}}
	fixes, err := correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, nil)
	require.NoError(t, err)
	require.Equal(t, map[int]string{120: "line 120 about zorvanite", 121: "line 121 about zorvanite"}, fixes)
}

func TestCorrectAcceptsSurgicalFix(t *testing.T) {
	fc := &fakeChat{answer: func(int, string) (string, error) {
		return "```json\n[{\"i\": 1, \"text\": \"la nota de zorvan\"}]\n```", nil
	}}
	segs := segsOf("buenos días", "la nota de sorvan")
	fixes, err := correctTranscript(context.Background(), fc.chat, segs, "Quillon Labs", []string{"zorvanite", "zorvan"}, map[string]string{"Speaker 1": "Ana"}, nil)
	require.NoError(t, err)
	require.Equal(t, map[int]string{1: "la nota de zorvan"}, fixes)
	require.Len(t, fc.users, 1)
	u := fc.users[0]
	require.Contains(t, u, "Project: Quillon Labs")
	require.Contains(t, u, "zorvanite, zorvan")
	require.Contains(t, u, "Speakers: Ana")
	require.Contains(t, u, "0\tAna\tbuenos días\n1\tAna\tla nota de sorvan")
}

func TestCorrectRejectsRewrite(t *testing.T) {
	fc := &fakeChat{answer: func(int, string) (string, error) {
		// 3 of 5 words changed: a paraphrase, not a fix
		return `[{"i":0,"text":"we must ship it today"},{"i":1,"text":"send the zorvanite report"}]`, nil
	}}
	segs := segsOf("we should release it tomorrow", "send the zorvanit report")
	fixes, err := correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, nil)
	require.NoError(t, err)
	require.Equal(t, map[int]string{1: "send the zorvanite report"}, fixes)
}

func TestCorrectIgnoresBadItems(t *testing.T) {
	segs := make([]proto.MeetingSegment, 130)
	for i := range segs {
		segs[i] = seg(int64(i), "Speaker 1", fmt.Sprintf("segment number %d of the quilon call", i))
	}
	fc := &fakeChat{answer: func(n int, _ string) (string, error) {
		if n == 1 {
			return `[{"i":125,"text":"out of this chunk"},{"i":3,"text":""},{"i":4,"text":"segment number 4 of the quilon call"},` +
				`"junk",{"text":"no index"},{"i":5,"text":"segment number 5 of the Quillon call"}]`, nil
		}
		return "Sorry, I cannot help with that.", nil // not JSON: the chunk is skipped
	}}
	fixes, err := correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, nil)
	require.NoError(t, err)
	require.Equal(t, map[int]string{5: "segment number 5 of the Quillon call"}, fixes)

	// a chunk that errors is skipped too, and the other chunk's fix is kept
	fc = &fakeChat{answer: func(n int, _ string) (string, error) {
		if n == 1 {
			return "", errors.New("ccapi is down")
		}
		return `[{"i":128,"text":"segment number 128 of the Quillon call"}]`, nil
	}}
	fixes, err = correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, nil)
	require.NoError(t, err)
	require.Equal(t, map[int]string{128: "segment number 128 of the Quillon call"}, fixes)

	// every chunk failed: an error
	fc = &fakeChat{answer: func(int, string) (string, error) { return "{}", nil }}
	_, err = correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, nil)
	require.ErrorIs(t, err, errCorrectionFailed)
}

func TestCorrectChunks(t *testing.T) {
	segs := make([]proto.MeetingSegment, 250)
	for i := range segs {
		segs[i] = seg(int64(i), "Speaker 1", fmt.Sprintf("line %d about zorvanit", i))
	}
	var pcts []int
	fc := &fakeChat{answer: func(n int, user string) (string, error) {
		// fix the first segment of each chunk, by the index the prompt shows
		first := strings.SplitN(strings.SplitN(user, "tabs):\n", 2)[1], "\t", 2)[0]
		return fmt.Sprintf(`[{"i":%s,"text":"line %s about zorvanite"}]`, first, first), nil
	}}
	fixes, err := correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, func(p int) { pcts = append(pcts, p) })
	require.NoError(t, err)
	require.Len(t, fc.users, 3)
	require.Equal(t, map[int]string{0: "line 0 about zorvanite", 120: "line 120 about zorvanite", 240: "line 240 about zorvanite"}, fixes)
	require.Contains(t, fc.users[1], "\n120\tSpeaker 1\tline 120 about zorvanit\n")
	require.Contains(t, fc.users[1], "239\tSpeaker 1\tline 239 about zorvanit")
	require.NotContains(t, fc.users[1], "\n240\t")
	require.NotContains(t, fc.users[1], "\n119\t")
	require.Equal(t, []int{0, 33, 66, 100}, pcts)
}

func TestMeetingSettingsCorrectDefaultsOn(t *testing.T) {
	f := newMeetFx(t)
	// settings stored before the correction pass existed
	require.NoError(t, f.st.SetMeta(metaMeetingSettings, `{"provider":"ccapi","model":"","baseUrl":"","language":"es","aliases":[]}`))
	require.True(t, f.s.meetingSettings().Correct)
	rr := f.do("PUT", "/api/settings/meetings", `{"correct":false}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Contains(t, rr.Body.String(), `"correct":false`)
	require.False(t, f.s.meetingSettings().Correct)
	require.Equal(t, "ccapi", f.s.meetingSettings().Provider)
	rr = f.do("PUT", "/api/settings/meetings", `{"correct":true}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.True(t, f.s.meetingSettings().Correct)
}

func isCorrectionPrompt(p string) bool {
	return strings.Contains(p, "You proofread automatic meeting transcripts")
}

func TestHubSummaryCorrectsOnceThenSummarises(t *testing.T) {
	var summaryPrompts []string
	f := newSumFx(t, func(n int, prompt string) (string, error) {
		if isCorrectionPrompt(prompt) {
			return `[{"i":1,"text":"We agreed to ship the zorvanite"}]`, nil
		}
		summaryPrompts = append(summaryPrompts, prompt)
		return shortAnswer, nil
	})
	rr := f.do("PUT", "/api/settings/meetings", `{"correct":true}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "ready", m.Status, m.Error)
	require.NotZero(t, m.CorrectedAt)
	require.Equal(t, "We agreed to ship the zorvanite", m.Segments[1].Text)
	require.Equal(t, "We agreed to ship the beta", m.Segments[1].OrigText)
	require.Equal(t, "", m.Segments[0].OrigText)
	require.Len(t, summaryPrompts, 1)
	require.Contains(t, summaryPrompts[0], "We agreed to ship the zorvanite")
	require.NotContains(t, summaryPrompts[0], "ship the beta")
	corrections := func() int {
		n := 0
		for _, p := range f.model.calls() {
			if isCorrectionPrompt(p) {
				n++
			}
		}
		return n
	}
	require.Equal(t, 1, corrections())

	// a reprocess summarises the corrected transcript again without a second correction
	rr = f.do("POST", "/api/meetings/"+m.ID+"/reprocess", "")
	require.Equal(t, 202, rr.Code, rr.Body.String())
	f.s.meet.wg.Wait()
	m = f.detail(t, m.ID)
	require.Equal(t, "ready", m.Status, m.Error)
	require.Equal(t, 1, corrections())
	require.Len(t, summaryPrompts, 2)
	require.Contains(t, summaryPrompts[1], "We agreed to ship the zorvanite")
}

func TestHubSummaryCorrectionFailureStillSummarises(t *testing.T) {
	f := newSumFx(t, func(n int, prompt string) (string, error) {
		if isCorrectionPrompt(prompt) {
			return "", errors.New("ccapi is down")
		}
		return shortAnswer, nil
	})
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"correct":true}`).Code)
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "ready", m.Status, m.Error)
	require.NotNil(t, m.Summary)
	require.Equal(t, "Beta sync", m.Summary.Title)
	require.Zero(t, m.CorrectedAt) // not corrected: a later summary tries again
	require.Equal(t, "We agreed to ship the beta", m.Segments[1].Text)
	require.Equal(t, "", m.Segments[1].OrigText)
}

func TestCorrectionOffSetting(t *testing.T) {
	f := newSumFx(t, func(n int, prompt string) (string, error) {
		if isCorrectionPrompt(prompt) {
			return "", errors.New("the correction must not run")
		}
		return shortAnswer, nil
	})
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"correct":false}`).Code)
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "ready", m.Status, m.Error)
	require.Len(t, f.model.calls(), 1)
	require.False(t, isCorrectionPrompt(f.model.calls()[0]))
	require.Zero(t, m.CorrectedAt)
}

func TestCorrectionOnlyWithCCAPI(t *testing.T) {
	f := newSumFx(t, func(n int, prompt string) (string, error) {
		if isCorrectionPrompt(prompt) {
			return "", errors.New("the correction must not run")
		}
		return shortAnswer, nil
	})
	rr := f.do("PUT", "/api/settings/meetings", `{"provider":"openai-compatible","model":"m-1","baseUrl":"https://llm.example/v1","correct":true}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "ready", m.Status, m.Error)
	require.Len(t, f.model.calls(), 1)
	require.Zero(t, m.CorrectedAt)
}

func TestCorrectionOfAReplacedTranscriptIsDropped(t *testing.T) {
	var f *sumFx
	f = newSumFx(t, func(n int, prompt string) (string, error) {
		if isCorrectionPrompt(prompt) {
			// a new transcript lands while the correction runs
			ms, err := f.st.Meetings(store.MeetingFilter{})
			if err != nil || len(ms) != 1 {
				return "", errors.New("no meeting")
			}
			if err := f.st.ReplaceMeetingSegments(ms[0].ID, []proto.MeetingSegment{seg(0, "Speaker 1", "a different transcript")}); err != nil {
				return "", err
			}
			return `[{"i":0,"text":"a different zorvanite"}]`, nil
		}
		return shortAnswer, nil
	})
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"correct":true}`).Code)
	m := f.transcribed(t, "", shortTranscript)
	require.Zero(t, m.CorrectedAt) // the new transcript still gets its own correction
	require.Len(t, m.Segments, 1)
	require.Equal(t, "a different transcript", m.Segments[0].Text)
	require.Equal(t, "", m.Segments[0].OrigText)
}

func TestCorrectSmallChunkKeepsItsOnlyFix(t *testing.T) {
	fc := &fakeChat{answer: func(int, string) (string, error) { return `[{"i":0,"text":"the zorvanite beta"}]`, nil }}
	fixes, err := correctTranscript(context.Background(), fc.chat, segsOf("the zorvanit beta"), "", nil, nil, nil)
	require.NoError(t, err)
	require.Equal(t, map[int]string{0: "the zorvanite beta"}, fixes)
}

func TestCorrectCaseFixesDoNotCountTowardTheShare(t *testing.T) {
	segs := make([]proto.MeetingSegment, 20)
	var items []string
	for i := range segs {
		segs[i] = seg(int64(i), "Speaker 1", fmt.Sprintf("line %d about zorvanit", i))
		text := fmt.Sprintf("Line %d about zorvanit.", i) // punctuation and case only
		if i < 5 {
			text = fmt.Sprintf("line %d about zorvanite", i)
		}
		items = append(items, fmt.Sprintf(`{"i":%d,"text":%q}`, i, text))
	}
	fc := &fakeChat{answer: func(int, string) (string, error) { return "[" + strings.Join(items, ",") + "]", nil }}
	fixes, err := correctTranscript(context.Background(), fc.chat, segs, "", nil, nil, nil)
	require.NoError(t, err)
	require.Len(t, fixes, 20) // 5 real changes of 20: kept, with the 15 case-only fixes
	require.Equal(t, "Line 7 about zorvanit.", fixes[7])
}

func TestCorrectionGuardDropsALongerText(t *testing.T) {
	_, ok := acceptCorrection("zorvanit", "zorvanite "+strings.Repeat("x", 40))
	require.False(t, ok)
	long := strings.Repeat("a ", 2100)
	_, ok = acceptCorrection(long, long+"b")
	require.False(t, ok) // over maxSegText runes
}
