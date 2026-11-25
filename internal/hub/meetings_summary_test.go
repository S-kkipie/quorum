package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/hub/summary"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// fakeCompleter answers each prompt with answer(prompt) and records the prompts.
type fakeCompleter struct {
	mu      sync.Mutex
	prompts []string
	answer  func(n int, prompt string) (string, error)
	// gate, when set, holds each call until it is closed or the call's context ends
	gate chan struct{}
	// entered gets a value as each call starts
	entered chan struct{}
}

func (c *fakeCompleter) Complete(ctx context.Context, prompt string, maxTokens int, jsonOut bool) (string, error) {
	c.mu.Lock()
	gate, entered := c.gate, c.entered
	c.mu.Unlock()
	if entered != nil {
		entered <- struct{}{}
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prompts = append(c.prompts, prompt)
	if maxTokens <= 0 || !jsonOut {
		return "", errors.New("the meeting summary must ask for JSON with an output cap")
	}
	return c.answer(len(c.prompts), prompt)
}

func (c *fakeCompleter) calls() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.prompts...)
}

// sumFx is a hub with a fake hub-side model and a fake gh.
type sumFx struct {
	*meetFx
	model   *fakeCompleter
	issues  []string // the titles gh was asked to create
	issueMu sync.Mutex
	// onIssue runs inside the fake gh before it answers
	onIssue func()
	// realCompleter is the hub's own provider factory
	realCompleter func(provider string, set meetingSettings, key string) (summary.Completer, error)
}

func newSumFx(t *testing.T, answer func(n int, prompt string) (string, error)) *sumFx {
	t.Helper()
	f := &sumFx{meetFx: newMeetFx(t), model: &fakeCompleter{answer: answer}}
	f.realCompleter = f.s.meet.completer
	f.s.meet.completer = func(provider string, set meetingSettings, key string) (summary.Completer, error) {
		return f.model, nil
	}
	f.s.meet.createIssue = func(_ context.Context, cfg proto.ConnectorConfig, _ string, _ []string, title, body string) (string, error) {
		if f.onIssue != nil {
			f.onIssue()
		}
		f.issueMu.Lock()
		defer f.issueMu.Unlock()
		f.issues = append(f.issues, title)
		if !strings.Contains(body, "Meeting in Quorum: ") || !strings.Contains(body, title) {
			return "", errors.New("the issue body lacks the action or the link: " + body)
		}
		return fmt.Sprintf("https://github.com/%s/issues/%d", cfg.Settings["repo"], len(f.issues)), nil
	}
	rr := f.do("PUT", "/api/settings/meetings", `{"provider":"ccapi"}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	return f
}

// project creates a project with a connector of kind (settings: repo and person).
func (f *sumFx) project(t *testing.T, kind string, settings map[string]string) proto.Project {
	t.Helper()
	w, err := f.st.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := f.st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "Acme", Connector: proto.ConnectorConfig{Kind: kind, Settings: settings}})
	require.NoError(t, err)
	return p
}

// transcribed makes a meeting of the project whose transcription just finished with segs, then waits for
// the hub-side summary.
func (f *sumFx) transcribed(t *testing.T, projectID string, segs []proto.MeetingSegment) proto.Meeting {
	t.Helper()
	m := f.uploadMeeting(t, projectID, "audio")
	f.s.cancelMeetingJobs(m.ID) // no machine: the test plays the transcription's end
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, segs))
	f.s.jobs.onTranscribed(m.ID)
	f.s.meet.wg.Wait()
	return f.detail(t, m.ID)
}

func (f *sumFx) detail(t *testing.T, id string) proto.Meeting {
	t.Helper()
	rr := f.do("GET", "/api/meetings/"+id, "")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	var m proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &m))
	return m
}

func seg(sec int64, speaker, text string) proto.MeetingSegment {
	return proto.MeetingSegment{StartMs: sec * 1000, EndMs: sec*1000 + 4000, Speaker: speaker, Text: text}
}

var shortTranscript = []proto.MeetingSegment{
	seg(0, "Speaker 1", "Ana will send the report on Friday"),
	seg(10, "Speaker 2", "We agreed to ship the beta"),
	seg(20, "Speaker 1", "Who books the room? Not decided"),
}

const shortAnswer = `{"title":"Beta sync","summary":"We talked about the beta.","topics":["beta"],
	"decisions":[{"text":"Ship the beta","ts":"00:10"}],"openPoints":[{"text":"Who books the room","ts":"00:20"}],
	"actions":[{"text":"Send the report","owner":"Ana","due":"Friday","ts":"00:00"},
	           {"text":"Book the room","owner":"Carlos","due":"tomorrow","ts":"00:20"}],
	"attendees":["Ana","Speaker 2","Carlos"]}`

func TestMeetingSummaryDropsInventedOwners(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "ready", m.Status, m.Error)
	require.Equal(t, "ccapi", m.Provider)
	require.Len(t, f.model.calls(), 1)
	require.Contains(t, f.model.calls()[0], "Never invent owners")
	require.Contains(t, f.model.calls()[0], "[00:10] Speaker 2: We agreed to ship the beta")
	require.Equal(t, "Standup", m.Title) // the upload's title stays
	require.Equal(t, &proto.MeetingSummary{Title: "Beta sync", Summary: "We talked about the beta.", Topics: []string{"beta"},
		Decisions:  []proto.MeetingPoint{{Text: "Ship the beta", TsMs: 10000}},
		OpenPoints: []proto.MeetingPoint{{Text: "Who books the room", TsMs: 20000}},
		Attendees:  []string{"Ana"}}, m.Summary)
	require.Len(t, m.Actions, 2)
	// Ana and Friday are in the transcript; Carlos and "tomorrow" were invented: unassigned, no date
	require.Equal(t, "Ana", m.Actions[0].Owner)
	require.Equal(t, "Friday", m.Actions[0].Due)
	require.Equal(t, "", m.Actions[1].Owner)
	require.Equal(t, "", m.Actions[1].Due)
	require.Equal(t, int64(20000), m.Actions[1].TsMs)
	require.False(t, m.Actions[0].Mine, "no person and no aliases: nothing is mine")
}

func TestMeetingSummarySectionsAt15Minutes(t *testing.T) {
	f := newSumFx(t, func(n int, p string) (string, error) {
		if strings.Contains(p, "You merge the minutes") {
			return `{"title":"Whole","summary":"All parts.","decisions":[{"text":"D","ts":"15:00"}]}`, nil
		}
		return fmt.Sprintf(`{"title":"Part %d","summary":"S%d"}`, n, n), nil
	})
	segs := []proto.MeetingSegment{seg(0, "", "start"), seg(899, "", "just before the cut"), seg(900, "", "second section"), seg(1900, "", "third section")}
	m := f.transcribed(t, "", segs)
	require.Equal(t, "ready", m.Status, m.Error)
	calls := f.model.calls()
	require.Len(t, calls, 4) // three 15-minute sections, then the merge
	require.Contains(t, calls[0], "This is part 1 of 3 of a longer meeting.")
	require.Contains(t, calls[0], "[14:59] just before the cut")
	require.NotContains(t, calls[0], "second section")
	require.Contains(t, calls[1], "[15:00] second section")
	require.Contains(t, calls[2], "[31:40] third section")
	require.Contains(t, calls[3], `PART 3:`+"\n"+`{"title":"Part 3","summary":"S3"`)
	require.Equal(t, "All parts.", m.Summary.Summary)
	require.Equal(t, []proto.MeetingPoint{{Text: "D", TsMs: 900000}}, m.Summary.Decisions)
}

func TestMeetingSummaryMineWithPersonAndAliases(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) {
		return `{"summary":"x","actions":[{"text":"Write the spec","owner":"zorv"},{"text":"Review","owner":"Zorvan Q"},
			{"text":"Deploy","owner":"Luis"},{"text":"Call the client","owner":""}]}`, nil
	})
	rr := f.do("PUT", "/api/settings/meetings", `{"aliases":[" Zorv ","zorv","Zorván"]}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	p := f.project(t, "none", map[string]string{"person": "Zorvan Q"})
	m := f.transcribed(t, p.ID, []proto.MeetingSegment{seg(0, "Speaker 1", "Zorv writes the spec, Zorvan Q reviews, Luis deploys")})
	require.Equal(t, "ready", m.Status, m.Error)
	mine := map[string]bool{}
	for _, a := range m.Actions {
		mine[a.Text] = a.Mine
	}
	require.Equal(t, map[string]bool{"Write the spec": true, "Review": true, "Deploy": false, "Call the client": false}, mine)

	// the projection writes mine with the person's name, so the briefing shows them
	b, err := f.s.briefing(p.ID, time.Now())
	require.NoError(t, err)
	var acts []string
	for _, a := range b.Meetings.Actions {
		acts = append(acts, a.Text)
	}
	require.Equal(t, []string{"Write the spec", "Review"}, acts)
	notes, err := f.st.MeetingNotes(p.ID, "")
	require.NoError(t, err)
	require.Len(t, notes, 1)
	require.Equal(t, "- Zorvan Q: Write the spec\n- Zorvan Q: Review\n- Luis: Deploy\n- Call the client", notes[0].Actions)

	// without the alias, "zorv" is no longer mine: the projection is rewritten
	rr = f.do("PUT", "/api/settings/meetings", `{"aliases":[]}`)
	require.Equal(t, 200, rr.Code)
	m = f.detail(t, m.ID)
	require.False(t, m.Actions[0].Mine)
	require.True(t, m.Actions[1].Mine)
}

func TestIsMine(t *testing.T) {
	require.False(t, isMine("Ana", nil, ""))
	require.False(t, isMine("", []string{"Ana"}, ""))
	require.False(t, isMine("  ", []string{""}, ""))
	require.True(t, isMine(" ana ", []string{"Ana"}, ""))
	require.True(t, isMine("Me", []string{"Ana"}, "me|others"))
	require.False(t, isMine("Me", []string{"Ana"}, ""))
	require.False(t, isMine("Me", nil, "me|others"))
}

func TestBriefingPersonActionsAcceptAliases(t *testing.T) {
	text := "- Zorv: write it\n  and send it\n- Luis: deploy\nzorvan: review\n- Other: x"
	require.Equal(t, []string{"write it and send it", "review"}, personActions(text, "Zorvan", "Zorv"))
	require.Equal(t, []string{"review"}, personActions(text, "Zorvan"))
	require.Nil(t, personActions(text))
}

func TestMeetingProjectionRewrittenOnReprocessAndKeptBySync(t *testing.T) {
	answer := shortAnswer
	var mu sync.Mutex
	f := newSumFx(t, func(int, string) (string, error) { mu.Lock(); defer mu.Unlock(); return answer, nil })
	p := f.project(t, "github", map[string]string{"repo": "acme/app", "person": "Ana"})
	m := f.transcribed(t, p.ID, shortTranscript)
	require.Equal(t, "ready", m.Status, m.Error)
	require.True(t, m.Actions[0].Mine)

	b, err := f.s.briefing(p.ID, time.Now())
	require.NoError(t, err)
	require.Equal(t, []proto.MeetingItem{{Text: "Ship the beta", NoteTitle: "Standup", Date: time.Now().Format(time.DateOnly)}}, b.Meetings.Decisions)
	require.Len(t, b.Meetings.OpenPoints, 1)
	require.Equal(t, "Send the report", b.Meetings.Actions[0].Text)

	// the first action becomes an issue
	rr := f.do("POST", "/api/meetings/"+m.ID+"/actions/"+m.Actions[0].ID+"/issue", "")
	require.Equal(t, 201, rr.Code, rr.Body.String())
	issued := m.Actions[0].ID

	// a connector sync replaces the connector's notes and keeps the meeting's
	_, err = f.st.ReplaceMeetingNotes(p.ID, []proto.MeetingNote{{ExternalID: "n1", Title: "Notes", Date: time.Now().Format(time.DateOnly), Decisions: "- Use Go"}}, time.Now().UnixMilli())
	require.NoError(t, err)
	_, err = f.st.ReplaceMeetingNotes(p.ID, nil, time.Now().UnixMilli())
	require.NoError(t, err)
	b, err = f.s.briefing(p.ID, time.Now())
	require.NoError(t, err)
	require.Len(t, b.Meetings.Decisions, 1)
	require.Equal(t, "Ship the beta", b.Meetings.Decisions[0].Text)

	// re-summarise with other answers: the projection is rewritten, not duplicated, and the action with an
	// issue stays (with its id and URL)
	mu.Lock()
	answer = `{"title":"Beta sync","summary":"Again.","decisions":[{"text":"Ship the beta on Monday"}],
		"actions":[{"text":"send the  report","owner":"Ana"},{"text":"Prepare the demo","owner":"Ana"}]}`
	mu.Unlock()
	rr = f.do("POST", "/api/meetings/"+m.ID+"/reprocess", `{"provider":"openai-compatible"}`)
	require.Equal(t, 202, rr.Code, rr.Body.String())
	f.s.meet.wg.Wait()
	m = f.detail(t, m.ID)
	require.Equal(t, "ready", m.Status, m.Error)
	require.Equal(t, "openai-compatible", m.Provider)
	require.Len(t, m.Actions, 2)
	require.Equal(t, issued, m.Actions[0].ID)
	require.Equal(t, "https://github.com/acme/app/issues/1", m.Actions[0].IssueURL)
	require.Equal(t, "Prepare the demo", m.Actions[1].Text)
	notes, err := f.st.MeetingNotes(p.ID, "")
	require.NoError(t, err)
	require.Len(t, notes, 1)
	require.Equal(t, "- Ship the beta on Monday", notes[0].Decisions)
	b, err = f.s.briefing(p.ID, time.Now())
	require.NoError(t, err)
	require.Len(t, b.Meetings.Decisions, 1)
	require.Equal(t, "Ship the beta on Monday", b.Meetings.Decisions[0].Text)
	require.Len(t, b.Meetings.Actions, 2)

	// deleting the meeting drops its projection
	require.Equal(t, 204, f.do("DELETE", "/api/meetings/"+m.ID, "").Code)
	notes, _ = f.st.MeetingNotes(p.ID, "")
	require.Empty(t, notes)
}

func TestMeetingActionIssueIdempotentAndNeedsGitHub(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	gh := f.project(t, "github", map[string]string{"repo": "acme/app"})
	m := f.transcribed(t, gh.ID, shortTranscript)
	path := "/api/meetings/" + m.ID + "/actions/" + m.Actions[0].ID + "/issue"
	var wg sync.WaitGroup
	codes := make([]int, 3)
	for i := range codes {
		wg.Add(1)
		go func() { defer wg.Done(); codes[i] = f.do("POST", path, "").Code }()
	}
	wg.Wait()
	created := 0
	for _, c := range codes {
		require.Contains(t, []int{200, 201}, c)
		if c == 201 {
			created++
		}
	}
	require.Equal(t, 1, created)
	require.Equal(t, []string{"Send the report"}, f.issues)
	rr := f.do("POST", path, "")
	require.Equal(t, 200, rr.Code)
	var out struct {
		URL     string `json:"url"`
		Created bool   `json:"created"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out))
	require.Equal(t, "https://github.com/acme/app/issues/1", out.URL)
	require.False(t, out.Created)
	require.Equal(t, out.URL, f.detail(t, m.ID).Actions[0].IssueURL)

	// no GitHub connector, no project, unknown action
	plain := f.project(t, "none", nil)
	m2 := f.transcribed(t, plain.ID, shortTranscript)
	require.Equal(t, 400, f.do("POST", "/api/meetings/"+m2.ID+"/actions/"+m2.Actions[0].ID+"/issue", "").Code)
	m3 := f.transcribed(t, "", shortTranscript)
	require.Equal(t, 400, f.do("POST", "/api/meetings/"+m3.ID+"/actions/"+m3.Actions[0].ID+"/issue", "").Code)
	require.Equal(t, 404, f.do("POST", "/api/meetings/"+m.ID+"/actions/nope/issue", "").Code)
	require.Len(t, f.issues, 1)
}

func TestIssueBodyAndLink(t *testing.T) {
	req, _ := http.NewRequest("POST", "http://hub.local:8080/api/x", nil)
	require.Equal(t, "http://hub.local:8080/?meeting=m1", meetingLink(req, "m1"))
	req.Header.Set("Origin", "https://app.example")
	require.Equal(t, "https://app.example/?meeting=m1", meetingLink(req, "m1"))
	at := time.Date(2026, 11, 20, 10, 0, 0, 0, time.Local).UnixMilli()
	m := proto.Meeting{Title: "Beta sync", StartedAt: at}
	body := issueBody(proto.MeetingAction{Text: "Send the report", Owner: "Zorvan", Mine: true, Due: "Friday", TsMs: 65000}, m, "https://app.example/?meeting=m1")
	require.Equal(t, "Send the report\n\nOwner: Zorvan\nDue: Friday\nFrom the meeting \"Beta sync\" on 2026-11-20 (at 01:05).\n\nMeeting in Quorum: https://app.example/?meeting=m1\n", body)
	// someone else's action never names them in the repo
	body = issueBody(proto.MeetingAction{Text: "Send the report", Owner: "Quillon", TsMs: 65000}, m, "https://app.example/?meeting=m1")
	require.NotContains(t, body, "Quillon")
	require.Equal(t, "Send the report\n\nFrom the meeting \"Beta sync\" on 2026-11-20 (at 01:05).\n\nMeeting in Quorum: https://app.example/?meeting=m1\n", body)
}

func TestMeetingSettingsKeyIsWriteOnly(t *testing.T) {
	f := newMeetFx(t)
	rr := f.do("GET", "/api/settings/meetings", "")
	require.Equal(t, 200, rr.Code)
	require.JSONEq(t, `{"provider":"local","model":"","baseUrl":"","language":"es","aliases":[],"hasKey":false}`, rr.Body.String())
	rr = f.do("PUT", "/api/settings/meetings", `{"provider":"openai-compatible","model":"m-1","baseUrl":"https://llm.example/v1","key":"sk-very-secret","language":"auto","aliases":["Zorv"]}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.NotContains(t, rr.Body.String(), "sk-very-secret")
	require.JSONEq(t, `{"provider":"openai-compatible","model":"m-1","baseUrl":"https://llm.example/v1","language":"auto","aliases":["Zorv"],"hasKey":true}`, rr.Body.String())
	rr = f.do("GET", "/api/settings/meetings", "")
	require.NotContains(t, rr.Body.String(), "sk-very-secret")
	raw, err := f.st.Meta(metaMeetingSettings)
	require.NoError(t, err)
	require.NotContains(t, raw, "sk-very-secret")
	require.NotContains(t, raw, "hasKey")
	require.Equal(t, "sk-very-secret", f.s.meetingKey())
	// a PUT without key keeps it; "" removes it
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"model":"m-2"}`).Code)
	require.True(t, f.s.meetingSettings().HasKey)
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"key":""}`).Code)
	require.False(t, f.s.meetingSettings().HasKey)
	for _, bad := range []string{`{"provider":"gpt"}`, `{"baseUrl":"file:///etc/passwd"}`, `{"language":"not a language"}`, `{"aliases":["` + strings.Repeat("x", 65) + `"]}`} {
		require.Equal(t, 400, f.do("PUT", "/api/settings/meetings", bad).Code, bad)
	}
	// the default language reaches the transcription
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"language":"pt"}`).Code)
	set, err := transcribeSettings(f.s, store.MeetingJob{}, proto.Meeting{})
	require.NoError(t, err)
	require.Contains(t, set, `"language":"pt"`)
}

func TestMeetingSpeakerNamesServedAndPassedToTheSummary(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	m := f.transcribed(t, "", shortTranscript)
	rr := f.do("POST", "/api/meetings/"+m.ID+"/speakers", `{"Speaker 2":"  Luis  M "}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	m = f.detail(t, m.ID)
	require.Equal(t, map[string]string{"Speaker 2": "Luis M"}, m.Speakers)
	require.Equal(t, proto.MeetingSegment{StartMs: 10000, EndMs: 14000, Speaker: "Luis M", Label: "Speaker 2", Text: "We agreed to ship the beta"}, m.Segments[1])
	require.Equal(t, "Speaker 1", m.Segments[0].Speaker)
	require.Equal(t, "Speaker 1", m.Segments[0].Label)

	require.Equal(t, 400, f.do("POST", "/api/meetings/"+m.ID+"/speakers", `{"Speaker 9":"X"}`).Code)
	require.Equal(t, 400, f.do("POST", "/api/meetings/"+m.ID+"/speakers", `{"Speaker 1":"`+strings.Repeat("x", 65)+`"}`).Code)
	require.Equal(t, 404, f.do("POST", "/api/meetings/nope/speakers", `{}`).Code)

	// the re-summary sees the names
	require.Equal(t, 202, f.do("POST", "/api/meetings/"+m.ID+"/reprocess", "").Code)
	f.s.meet.wg.Wait()
	last := f.model.calls()[len(f.model.calls())-1]
	require.Contains(t, last, "[00:10] Luis M: We agreed to ship the beta")
	require.Contains(t, last, "use these spellings): Luis M")

	// "" removes a name
	require.Equal(t, 200, f.do("POST", "/api/meetings/"+m.ID+"/speakers", `{"Speaker 2":""}`).Code)
	require.Equal(t, "Speaker 2", f.detail(t, m.ID).Segments[1].Speaker)
}

func TestMeetingReprocessNeedsATranscript(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	m := f.uploadMeeting(t, "", "audio") // queued, no transcript
	require.Equal(t, 409, f.do("POST", "/api/meetings/"+m.ID+"/reprocess", "").Code)
	require.Equal(t, 400, f.do("POST", "/api/meetings/"+m.ID+"/reprocess", `{"provider":"gpt"}`).Code)
	require.Equal(t, 404, f.do("POST", "/api/meetings/nope/reprocess", "").Code)
}

func TestMeetingSummaryFailureIsReadableAndRetrySummarisesAgain(t *testing.T) {
	fail := true
	var mu sync.Mutex
	f := newSumFx(t, func(int, string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if fail {
			return "", errors.New("the summary provider answered HTTP 529")
		}
		return shortAnswer, nil
	})
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "failed", m.Status)
	require.Equal(t, "The summary failed: the summary provider answered HTTP 529", m.Error)
	mu.Lock()
	fail = false
	mu.Unlock()
	rr := f.do("POST", "/api/meetings/"+m.ID+"/retry", "")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	f.s.meet.wg.Wait()
	m = f.detail(t, m.ID)
	require.Equal(t, "ready", m.Status)
	require.Len(t, m.Segments, 3, "the transcript was not redone")
	// a model that never answers JSON
	f2 := newSumFx(t, func(int, string) (string, error) { return "I cannot help", nil })
	m2 := f2.transcribed(t, "", shortTranscript)
	require.Equal(t, "failed", m2.Status)
	require.Contains(t, m2.Error, "did not return valid JSON")
}

func TestMeetingWithoutSpeechIsReadyWithAnEmptySummary(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	m := f.transcribed(t, "", nil)
	require.Equal(t, "ready", m.Status)
	require.Empty(t, f.model.calls())
	require.NotNil(t, m.Summary)
}

func TestMeetingLocalSummaryThroughTheWorker(t *testing.T) {
	f := newJobFx(t)
	rr := f.do("PUT", "/api/settings/meetings", `{"provider":"local","model":"gemma3:4b","aliases":["Zorv"]}`)
	require.Equal(t, 200, rr.Code)
	gpu := f.connect(t, "gpu", true)
	m := f.uploadMeeting(t, "", "audio")
	p := gpu.start()
	// named while it transcribes: the summary job is built with the names when it is dispatched
	require.NoError(t, f.st.SetMeetingSpeakers(m.ID, map[string]string{"Speaker 2": "Luis"}))
	code, body := postJSON(t, f.ts.URL, p.ResultURL, transcriptBody)
	require.Equal(t, 200, code, body)

	s := gpu.start()
	require.Equal(t, proto.MeetingStepSummarizeLocal, s.Step)
	require.Empty(t, s.AudioURL)
	require.NotEmpty(t, s.TranscriptURL)
	var set map[string]any
	require.NoError(t, json.Unmarshal(s.Settings, &set))
	require.Equal(t, "gemma3:4b", set["model"])
	require.Equal(t, "es", set["language"])
	require.Equal(t, map[string]any{"Speaker 2": "Luis"}, set["speakerNames"])
	require.Equal(t, []any{"Luis", "Zorv"}, set["glossary"])
	require.NotContains(t, string(s.Settings), "second", "the transcript is not in the RPC")
	require.Equal(t, "summarising", f.status(m.ID))

	// the worker fetches the transcript from the signed URL, with no device token
	resp, err := http.Get(f.ts.URL + s.TranscriptURL)
	require.NoError(t, err)
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.JSONEq(t, `{"segments":[{"start_ms":0,"end_ms":1100,"speaker":"Speaker 1","text":"first"},{"start_ms":1200,"end_ms":3000,"speaker":"Speaker 2","text":"second"}]}`, string(b))
	resp, err = http.Get(f.ts.URL + strings.Replace(s.TranscriptURL, "/api/meeting-jobs/", "/api/meeting-jobs/x", 1))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 403, resp.StatusCode)

	// the worker's summary is checked again by the hub: the invented owner goes
	res := `{"result":{"title":"T","summary":"S","topics":[],"decisions":[],"openPoints":[],
		"actions":[{"text":"Do it","owner":"Luis","due":"","ts_ms":1200},{"text":"Other","owner":"Marta","due":"lunes"}],"attendees":["Luis"]}}`
	code, body = postJSON(t, f.ts.URL, s.ResultURL, res)
	require.Equal(t, 200, code, body)
	mm := f.meeting(t, m.ID)
	require.Equal(t, "ready", mm.Status, mm.Error)
	require.Equal(t, "local", mm.Provider)
	require.Equal(t, "Luis", mm.Actions[0].Owner)
	require.Equal(t, "", mm.Actions[1].Owner)
	require.Equal(t, "", mm.Actions[1].Due)
	// the transcript link died with the job
	resp, err = http.Get(f.ts.URL + s.TranscriptURL)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 409, resp.StatusCode)
}

func TestMeetingReprocessReplacesAQueuedLocalSummary(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"provider":"local"}`).Code)
	m := f.transcribed(t, "", shortTranscript)
	require.Equal(t, "summarising", m.Status)
	act, err := f.st.ActiveMeetingJobs(m.ID)
	require.NoError(t, err)
	require.Len(t, act, 1)
	// no machine can run it: the owner switches to Claude
	require.Equal(t, 202, f.do("POST", "/api/meetings/"+m.ID+"/reprocess", `{"provider":"ccapi"}`).Code)
	f.s.meet.wg.Wait()
	act, err = f.st.ActiveMeetingJobs(m.ID)
	require.NoError(t, err)
	require.Empty(t, act)
	m = f.detail(t, m.ID)
	require.Equal(t, "ready", m.Status)
	require.Equal(t, "ccapi", m.Provider)
}

func TestMeetingMineFollowsTheProjectPerson(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	p := f.project(t, "none", map[string]string{"person": "Luis"})
	m := f.transcribed(t, p.ID, shortTranscript)
	require.False(t, m.Actions[0].Mine)
	rr := f.do("PATCH", "/api/projects/"+p.ID, `{"connector":{"settings":{"person":"Ana"}}}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.True(t, f.detail(t, m.ID).Actions[0].Mine)
	notes, err := f.st.MeetingNotes(p.ID, "")
	require.NoError(t, err)
	require.Contains(t, notes[0].Actions, "- Ana: Send the report")
	// moving the meeting to another project follows that project's person
	other := f.project(t, "none", map[string]string{"person": "Nobody"})
	require.Equal(t, 200, f.do("PATCH", "/api/meetings/"+m.ID, `{"projectId":"`+other.ID+`"}`).Code)
	require.False(t, f.detail(t, m.ID).Actions[0].Mine)
	notes, _ = f.st.MeetingNotes(p.ID, "")
	require.Empty(t, notes)
	notes, _ = f.st.MeetingNotes(other.ID, "")
	require.Len(t, notes, 1)
}

func TestMeetingHubSummaryRestartsAfterAHubRestart(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	m := f.uploadMeeting(t, "", "audio")
	f.s.cancelMeetingJobs(m.ID)
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, shortTranscript))
	require.NoError(t, f.st.SetMeetingProvider(m.ID, "ccapi"))
	require.NoError(t, f.st.SetMeetingStatus(m.ID, "summarising", "", 40)) // the hub stopped mid-summary
	f.s.recoverSummaries()
	f.s.meet.wg.Wait()
	require.Equal(t, "ready", f.detail(t, m.ID).Status)
}

func TestMeetingReprocessWithAnUnconfiguredProviderChangesNothing(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	f.s.meet.completer = func(provider string, set meetingSettings, key string) (summary.Completer, error) {
		if provider == providerOpenAI {
			return f.realCompleter(provider, set, key)
		}
		return f.model, nil
	}
	f.model.gate, f.model.entered = make(chan struct{}), make(chan struct{}, 4)
	m := f.uploadMeeting(t, "", "audio")
	f.s.cancelMeetingJobs(m.ID)
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, shortTranscript))
	f.s.jobs.onTranscribed(m.ID)
	<-f.model.entered // the ccapi summary is running
	rr := f.do("POST", "/api/meetings/"+m.ID+"/reprocess", `{"provider":"openai-compatible"}`)
	require.Equal(t, 400, rr.Code, rr.Body.String())
	require.Contains(t, rr.Body.String(), "OpenAI-compatible")
	mm, _ := f.st.Meeting(m.ID)
	require.Equal(t, "ccapi", mm.Provider)
	require.Equal(t, "summarising", mm.Status)
	close(f.model.gate)
	f.s.meet.wg.Wait()
	mm = f.detail(t, m.ID)
	require.Equal(t, "ready", mm.Status, mm.Error)
	require.Len(t, mm.Actions, 2)
}

func TestMeetingReprocessCancelsTheRunningSummary(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	f.model.gate, f.model.entered = make(chan struct{}), make(chan struct{}, 4)
	m := f.uploadMeeting(t, "", "audio")
	f.s.cancelMeetingJobs(m.ID)
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, shortTranscript))
	f.s.jobs.onTranscribed(m.ID)
	<-f.model.entered
	// the new run cancels the old call (its context ends) and runs to the end once the gate opens
	require.Equal(t, 202, f.do("POST", "/api/meetings/"+m.ID+"/reprocess", "").Code)
	<-f.model.entered
	close(f.model.gate)
	f.s.meet.wg.Wait()
	mm := f.detail(t, m.ID)
	require.Equal(t, "ready", mm.Status, mm.Error)
	require.Len(t, f.model.calls(), 1, "only the second run reached the model")
}

func TestMeetingIssueWaitsForNoReprocessAndKeepsItsAction(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	p := f.project(t, "github", map[string]string{"repo": "acme/app"})
	m := f.transcribed(t, p.ID, shortTranscript)
	inGh, release := make(chan struct{}), make(chan struct{})
	f.onIssue = func() { close(inGh); <-release }
	code := make(chan int, 1)
	go func() { code <- f.do("POST", "/api/meetings/"+m.ID+"/actions/"+m.Actions[0].ID+"/issue", "").Code }()
	<-inGh
	// a re-summary arrives while gh is creating the issue
	require.Equal(t, 202, f.do("POST", "/api/meetings/"+m.ID+"/reprocess", "").Code)
	time.Sleep(50 * time.Millisecond)
	close(release)
	require.Equal(t, 201, <-code)
	f.s.meet.wg.Wait()
	mm := f.detail(t, m.ID)
	require.Equal(t, "ready", mm.Status)
	require.Equal(t, m.Actions[0].ID, mm.Actions[0].ID)
	require.Equal(t, "https://github.com/acme/app/issues/1", mm.Actions[0].IssueURL)
	require.Len(t, mm.Actions, 2)
}

func TestMeetingIssueOfAReplacedAction(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	p := f.project(t, "github", map[string]string{"repo": "acme/app"})
	m := f.transcribed(t, p.ID, shortTranscript)
	// the action is replaced by one with the same text while gh runs: the issue goes to that one
	f.onIssue = func() {
		require.NoError(t, f.st.ReplaceMeetingActions(m.ID, []proto.MeetingAction{{Text: "Send the  report"}, {Text: "Book the room"}}))
	}
	rr := f.do("POST", "/api/meetings/"+m.ID+"/actions/"+m.Actions[0].ID+"/issue", "")
	require.Equal(t, 201, rr.Code, rr.Body.String())
	mm := f.detail(t, m.ID)
	require.NotEqual(t, m.Actions[0].ID, mm.Actions[0].ID)
	require.Equal(t, "https://github.com/acme/app/issues/1", mm.Actions[0].IssueURL)
	// replaced by other text: 409 with the URL of the issue created
	f.onIssue = func() {
		require.NoError(t, f.st.ReplaceMeetingActions(m.ID, []proto.MeetingAction{{Text: "Something else"}}))
	}
	rr = f.do("POST", "/api/meetings/"+m.ID+"/actions/"+mm.Actions[1].ID+"/issue", "")
	require.Equal(t, 409, rr.Code, rr.Body.String())
	require.Contains(t, rr.Body.String(), `"url":"https://github.com/acme/app/issues/2"`)
}

func TestMeetingRetryUsesTheMeetingsProvider(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	m := f.uploadMeeting(t, "", "audio")
	f.s.cancelMeetingJobs(m.ID)
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, shortTranscript))
	require.NoError(t, f.st.SetMeetingProvider(m.ID, "ccapi"))
	require.NoError(t, f.st.SetMeetingStatus(m.ID, "failed", "The summary failed: x", 0))
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"provider":"local"}`).Code)
	require.Equal(t, 200, f.do("POST", "/api/meetings/"+m.ID+"/retry", "").Code)
	f.s.meet.wg.Wait()
	mm := f.detail(t, m.ID)
	require.Equal(t, "ready", mm.Status)
	require.Equal(t, "ccapi", mm.Provider)
}

func TestMeetingSpeakersUnknownMeetingIs404(t *testing.T) {
	f := newMeetFx(t)
	require.Equal(t, 404, f.do("POST", "/api/meetings/nope/speakers", `{"Speaker 1":"Ana"}`).Code)
}

func TestMeetingSettingsNewHostClearsTheKey(t *testing.T) {
	f := newMeetFx(t)
	rr := f.do("PUT", "/api/settings/meetings", `{"provider":"openai-compatible","model":"m-1","baseUrl":"https://llm.example/v1","key":"sk-one"}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	// the same host keeps the key
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"baseUrl":"https://LLM.example/v2"}`).Code)
	require.Equal(t, "sk-one", f.s.meetingKey())
	// another host never receives it: re-enter it
	rr = f.do("PUT", "/api/settings/meetings", `{"baseUrl":"https://elsewhere.example/v1"}`)
	require.Equal(t, 200, rr.Code)
	require.Contains(t, rr.Body.String(), `"hasKey":false`)
	require.Equal(t, "", f.s.meetingKey())
	// a key sent with the new host is kept
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"baseUrl":"https://third.example/v1","key":"sk-two"}`).Code)
	require.Equal(t, "sk-two", f.s.meetingKey())
	// a port is part of the host
	require.Equal(t, 200, f.do("PUT", "/api/settings/meetings", `{"baseUrl":"https://third.example:8443/v1"}`).Code)
	require.Equal(t, "", f.s.meetingKey())
}

func TestMeetingDeleteCancelsTheHubSummary(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	f.model.gate, f.model.entered = make(chan struct{}), make(chan struct{}, 4)
	m := f.uploadMeeting(t, "", "audio")
	f.s.cancelMeetingJobs(m.ID)
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, shortTranscript))
	f.s.jobs.onTranscribed(m.ID)
	<-f.model.entered // the ccapi summary is running
	f.s.lockMeeting(m.ID)() // a lock entry exists
	require.Equal(t, 204, f.do("DELETE", "/api/meetings/"+m.ID, "").Code)
	f.s.meet.wg.Wait() // the run ended without the gate opening: its call was cancelled
	require.Empty(t, f.model.calls())
	f.s.meet.mu.Lock()
	_, hasGen := f.s.meet.gen[m.ID]
	_, hasCancel := f.s.meet.cancel[m.ID]
	f.s.meet.mu.Unlock()
	f.s.meet.locksMu.Lock()
	_, hasLock := f.s.meet.locks[m.ID]
	f.s.meet.locksMu.Unlock()
	require.False(t, hasGen || hasCancel || hasLock, "the meeting's run and lock entries are gone")
	close(f.model.gate)
}

func TestProjectDeletePublishesItsMeetings(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	p := f.project(t, "none", nil)
	m := f.uploadMeeting(t, p.ID, "audio")
	f.uploadMeeting(t, "", "audio") // an inbox meeting is not announced
	cp := &capture{}
	f.s.hub.SetBroadcaster(cp)
	require.Equal(t, 204, f.do("DELETE", "/api/projects/"+p.ID, "").Code)
	var changed []map[string]string
	cp.mu.Lock()
	for _, e := range cp.envs {
		if e.Type == "meeting_changed" {
			var v map[string]string
			require.NoError(t, json.Unmarshal(e.Payload, &v))
			changed = append(changed, v)
		}
	}
	cp.mu.Unlock()
	require.Equal(t, []map[string]string{{"id": m.ID, "projectId": "", "status": m.Status}}, changed)
	got, err := f.st.Meeting(m.ID)
	require.NoError(t, err)
	require.Equal(t, "", got.ProjectID)
}
