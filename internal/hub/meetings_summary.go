package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/connectors"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/hub/summary"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Meeting summaries. After a transcript is stored the hub summarises it with the provider of Settings →
// Meetings: "local" queues a summarize_local job (the machine's Ollama; the worker fetches the transcript
// from a signed URL), "ccapi" and "openai-compatible" run here through a summary.Completer, with the
// same prompts and rules as the worker (meetings_minutes.go). Every summary, the worker's too, is repaired
// here against the transcript, then stored with its actions ("mine" from the project person and the
// owner's aliases) and projected into the project's meeting_notes (source quorum) for the briefing.

const (
	providerLocal  = "local"
	providerCCAPI  = "ccapi"
	providerOpenAI = "openai-compatible"

	defaultOllamaModel = "gemma3:12b"
	// summaryMaxTokens bounds one answer of a hub provider (a section's minutes or the merge).
	summaryMaxTokens = 8000

	metaMeetingSettings = "meetings_settings"
	metaMeetingKey      = "meetings_api_key"

	maxAliases      = 20
	maxNameRunes    = 64
	maxSpeakerNames = 100
	issueTitleRunes = 200
)

func validProvider(p string) bool {
	return p == providerLocal || p == providerCCAPI || p == providerOpenAI
}

// meetingSettings is Settings → Meetings. The API key is stored apart and never returned (HasKey).
type meetingSettings struct {
	Provider string   `json:"provider"`
	Model    string   `json:"model"`
	BaseURL  string   `json:"baseUrl"`
	Language string   `json:"language"`
	Aliases  []string `json:"aliases"`
	HasKey   bool     `json:"hasKey"`
}

// meetSummaries is the server's summary state.
type meetSummaries struct {
	mu  sync.Mutex
	gen map[string]int // the current summary run of each meeting; an older run's result is discarded
	// one hub-side summary at a time (a long meeting is many calls)
	sem chan struct{}
	// completer returns the hub provider's model (tests fake it).
	completer func(provider string, set meetingSettings, key string) (summary.Completer, error)
	// createIssue creates a GitHub issue through gh (tests fake it).
	createIssue func(ctx context.Context, cfg proto.ConnectorConfig, token string, env []string, title, body string) (string, error)
	issueMu     sync.Mutex
	// wg tracks the hub-side runs (tests wait for them).
	wg sync.WaitGroup
}

func (s *Server) initMeetingSummaries(auto *summary.Auto) {
	s.meet.gen = map[string]int{}
	s.meet.sem = make(chan struct{}, 1)
	s.meet.createIssue = connectors.CreateGitHubIssue
	s.meet.completer = func(provider string, set meetingSettings, key string) (summary.Completer, error) {
		switch provider {
		case providerCCAPI:
			model := ""
			if set.Provider == providerCCAPI {
				model = set.Model
			}
			return auto.Long(model), nil
		case providerOpenAI:
			if set.BaseURL == "" || set.Model == "" {
				return nil, errors.New("Set the base URL and the model of the OpenAI-compatible provider in Settings → Meetings.")
			}
			return &summary.OpenAI{BaseURL: set.BaseURL, Model: set.Model, Key: key}, nil
		}
		return nil, fmt.Errorf("unknown summary provider %q", provider)
	}
	s.jobs.onTranscribed = func(id string) {
		if err := s.summarizeMeeting(id, ""); err != nil {
			log.Printf("hub: meetings: summary of %s: %v", id, err)
			s.setMeetingState(id, "failed", trimRunes("The summary could not start: "+err.Error(), maxJobError), 0, "")
		}
	}
	s.jobs.onLocalSummary = s.applyLocalSummary
	step := s.jobs.steps[proto.MeetingStepSummarizeLocal]
	step.needsTranscript = true
	step.settings = localSummarySettings
	s.jobs.steps[proto.MeetingStepSummarizeLocal] = step
}

// recoverSummaries restarts the summaries that were running when the hub stopped: a summarising meeting
// with no job (a hub-side run dies with the hub; a local summary keeps its job).
func (s *Server) recoverSummaries() {
	ms, err := s.st.Meetings(store.MeetingFilter{})
	if err != nil {
		log.Printf("hub: meetings: recover summaries: %v", err)
		return
	}
	for _, m := range ms {
		if m.Status != "summarising" {
			continue
		}
		if act, err := s.st.ActiveMeetingJobs(m.ID); err != nil || len(act) > 0 {
			continue
		}
		provider := m.Provider
		if !validProvider(provider) {
			provider = ""
		}
		if err := s.summarizeMeeting(m.ID, provider); err != nil {
			log.Printf("hub: meetings: restart the summary of %s: %v", m.ID, err)
			s.setMeetingState(m.ID, "failed", trimRunes("The summary could not start: "+err.Error(), maxJobError), 0, "")
		}
	}
}

// meetingSettings reads Settings → Meetings with its defaults.
func (s *Server) meetingSettings() meetingSettings {
	set := meetingSettings{Provider: providerLocal, Language: defaultLanguage, Aliases: []string{}}
	if raw, err := s.st.Meta(metaMeetingSettings); err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &set)
	}
	if !validProvider(set.Provider) {
		set.Provider = providerLocal
	}
	if set.Aliases == nil {
		set.Aliases = []string{}
	}
	key, _ := s.st.Meta(metaMeetingKey)
	set.HasKey = key != ""
	return set
}

func (s *Server) meetingKey() string {
	k, _ := s.st.Meta(metaMeetingKey)
	return k
}

// defaultMeetingLanguage is the language of a meeting that has none.
func (s *Server) defaultMeetingLanguage() string {
	if l := s.meetingSettings().Language; l != "" {
		return l
	}
	return defaultLanguage
}

// summaryLanguage is the language code the summary is written in.
func (s *Server) summaryLanguage(m proto.Meeting) string {
	if m.Language != "" && m.Language != "auto" {
		return m.Language
	}
	if l := s.defaultMeetingLanguage(); l != "auto" {
		return l
	}
	return ""
}

// nextSummaryRun starts a new summary run of the meeting: every older run's result is discarded.
func (s *Server) nextSummaryRun(id string) int {
	s.meet.mu.Lock()
	defer s.meet.mu.Unlock()
	s.meet.gen[id]++
	return s.meet.gen[id]
}

func (s *Server) currentSummaryRun(id string, gen int) bool {
	s.meet.mu.Lock()
	defer s.meet.mu.Unlock()
	return s.meet.gen[id] == gen
}

// summarizeMeeting summarises the meeting's transcript with provider ("" = the configured one).
func (s *Server) summarizeMeeting(id, provider string) error {
	set := s.meetingSettings()
	if provider == "" {
		provider = set.Provider
	}
	if !validProvider(provider) {
		return fmt.Errorf("unknown summary provider %q", provider)
	}
	segs, err := s.st.MeetingSegments(id)
	if err != nil {
		return err
	}
	gen := s.nextSummaryRun(id)
	// a summary still queued or running on a machine is replaced
	s.cancelMeetingJobs(id)
	if err := s.st.SetMeetingProvider(id, provider); err != nil {
		return err
	}
	if len(renderLines(segs, nil)) == 0 {
		// nothing was said: an empty summary, no model needed
		return s.applyMinutes(id, emptyMinutes())
	}
	if provider == providerLocal {
		if _, err := s.enqueueMeetingJob(id, proto.MeetingStepSummarizeLocal, ""); err != nil {
			return err
		}
		s.setMeetingState(id, "summarising", "", 0, "")
		return nil
	}
	c, err := s.meet.completer(provider, set, s.meetingKey())
	if err != nil {
		return err
	}
	s.setMeetingState(id, "summarising", "", 0, "")
	s.meet.wg.Add(1)
	go func() {
		defer s.meet.wg.Done()
		s.runHubSummary(id, gen, c)
	}()
	return nil
}

// runHubSummary runs a ccapi or OpenAI-compatible summary of the meeting (one at a time).
func (s *Server) runHubSummary(id string, gen int, c summary.Completer) {
	s.meet.sem <- struct{}{}
	defer func() { <-s.meet.sem }()
	if !s.currentSummaryRun(id, gen) {
		return
	}
	m, err := s.st.Meeting(id)
	if err != nil {
		return
	}
	segs, err := s.st.MeetingSegments(id)
	if err != nil {
		return
	}
	names, _ := s.st.MeetingSpeakers(id)
	chat := func(ctx context.Context, msgs []chatMsg) (string, error) {
		if !s.currentSummaryRun(id, gen) {
			return "", errStaleSummary
		}
		return c.Complete(ctx, oneMessage(msgs), summaryMaxTokens, true)
	}
	progress := func(pct int, stage string) {
		if s.currentSummaryRun(id, gen) {
			s.setMeetingState(id, "summarising", "", pct, stage)
		}
	}
	out, err := summarizeSegments(context.Background(), chat, segs, names, s.summaryLanguage(m), s.glossary(m, names), progress)
	if !s.currentSummaryRun(id, gen) {
		return
	}
	if err != nil {
		log.Printf("hub: meetings: summary of %s: %v", id, err)
		s.setMeetingState(id, "failed", trimRunes("The summary failed: "+err.Error(), maxJobError), 0, "")
		return
	}
	if err := s.applyMinutes(id, out); err != nil {
		log.Printf("hub: meetings: store the summary of %s: %v", id, err)
		s.setMeetingState(id, "failed", trimRunes("The summary could not be stored: "+err.Error(), maxJobError), 0, "")
	}
}

var errStaleSummary = errors.New("a newer summary replaced this one")

// glossary is what the prompt asks the model to spell as given: the speaker names, the project person
// and the owner's aliases.
func (s *Server) glossary(m proto.Meeting, names map[string]string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(x string) {
		x = strings.TrimSpace(x)
		if x != "" && !seen[strings.ToLower(x)] {
			seen[strings.ToLower(x)] = true
			out = append(out, x)
		}
	}
	for _, sg := range sortedNames(names) {
		add(sg)
	}
	if m.ProjectID != "" {
		if p, err := s.st.GetProject(m.ProjectID); err == nil {
			add(store.ProjectPerson(p))
		}
	}
	for _, a := range s.meetingSettings().Aliases {
		add(a)
	}
	return out
}

func sortedNames(names map[string]string) []string {
	var out []string
	for _, n := range names {
		out = append(out, n)
	}
	sort.Strings(out) // map order is random: keep the prompt stable
	return out
}

// localSummarySettings builds a summarize_local job's settings at dispatch time (the names may have
// changed since it was queued). The transcript goes through the job's transcript URL.
func localSummarySettings(s *Server, _ store.MeetingJob, m proto.Meeting) (string, error) {
	set := s.meetingSettings()
	model := defaultOllamaModel
	if set.Provider == providerLocal && set.Model != "" {
		model = set.Model
	}
	names, err := s.st.MeetingSpeakers(m.ID)
	if err != nil {
		return "", err
	}
	if names == nil {
		names = map[string]string{}
	}
	b, err := json.Marshal(map[string]any{
		"language": s.summaryLanguage(m), "speakerNames": names, "glossary": s.glossary(m, names), "model": model,
	})
	return string(b), err
}

// handleMeetingJobTranscript: GET /api/meeting-jobs/{token}/transcript serves the transcript to the job's
// worker ({segments: [{start_ms, end_ms, speaker, text}]}, the stored labels).
func (s *Server) handleMeetingJobTranscript(w http.ResponseWriter, r *http.Request) {
	j, ok := s.jobFromToken(w, r.PathValue("token"))
	if !ok {
		return
	}
	segs, err := s.st.MeetingSegments(j.MeetingID)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	out := make([]proto.MeetingWorkerSegment, len(segs))
	for i, sg := range segs {
		out[i] = proto.MeetingWorkerSegment{StartMs: sg.StartMs, EndMs: sg.EndMs, Speaker: sg.Speaker, Text: sg.Text}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, 200, map[string]any{"segments": out})
}

// applyLocalSummary stores a summarize_local result, repaired with the hub's rules.
func (s *Server) applyLocalSummary(job store.MeetingJob, raw json.RawMessage) error {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return errors.New("the summary is not valid JSON")
	}
	segs, err := s.st.MeetingSegments(job.MeetingID)
	if err != nil {
		return err
	}
	names, _ := s.st.MeetingSpeakers(job.MeetingID)
	transcript, maxMs := transcriptText(segs, names)
	return s.applyMinutes(job.MeetingID, repairMinutes(v, transcript, maxMs))
}

// transcriptText is the rendered transcript a summary is checked against, and its last timestamp.
func transcriptText(segs []proto.MeetingSegment, names map[string]string) (string, int64) {
	clean := map[string]string{}
	for k, v := range names {
		if strings.TrimSpace(v) != "" {
			clean[k] = v
		}
	}
	var maxMs int64
	for _, sg := range segs {
		e := sg.EndMs
		if e == 0 {
			e = sg.StartMs
		}
		maxMs = max(maxMs, e)
	}
	return strings.Join(renderLines(segs, clean), "\n"), maxMs
}

// mineNames are the names that make an action the owner's: the project person, then the aliases.
func (s *Server) mineNames(projectID string) []string {
	var out []string
	if projectID != "" {
		if p, err := s.st.GetProject(projectID); err == nil {
			if person := store.ProjectPerson(p); person != "" {
				out = append(out, person)
			}
		}
	}
	for _, a := range s.meetingSettings().Aliases {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

// isMine: the owner is one of names (trimmed, case-insensitive). "Me", the owner's channel of a
// two-channel recording, also counts when there is a name at all. An unassigned owner is never mine.
func isMine(owner string, names []string, channels string) bool {
	owner = strings.TrimSpace(owner)
	if owner == "" || len(names) == 0 {
		return false
	}
	if channels == "me|others" && strings.EqualFold(owner, "Me") {
		return true
	}
	for _, n := range names {
		if strings.EqualFold(owner, strings.TrimSpace(n)) {
			return true
		}
	}
	return false
}

func tsOf(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// applyMinutes stores a repaired summary and its actions, projects them into the briefing and makes the
// meeting ready.
func (s *Server) applyMinutes(id string, out minutes) error {
	m, err := s.st.Meeting(id)
	if err != nil {
		return err
	}
	sum := proto.MeetingSummary{Title: out.Title, Summary: out.Summary, Topics: out.Topics, Attendees: out.Attendees,
		Decisions: []proto.MeetingPoint{}, OpenPoints: []proto.MeetingPoint{}}
	for _, d := range out.Decisions {
		sum.Decisions = append(sum.Decisions, proto.MeetingPoint{Text: d.Text, TsMs: tsOf(d.TsMs)})
	}
	for _, d := range out.OpenPoints {
		sum.OpenPoints = append(sum.OpenPoints, proto.MeetingPoint{Text: d.Text, TsMs: tsOf(d.TsMs)})
	}
	names := s.mineNames(m.ProjectID)
	acts := make([]proto.MeetingAction, 0, len(out.Actions))
	for _, a := range out.Actions {
		acts = append(acts, proto.MeetingAction{Text: a.Text, Owner: a.Owner, Due: a.Due, TsMs: tsOf(a.TsMs), Mine: isMine(a.Owner, names, m.Channels)})
	}
	if err := s.st.SetMeetingSummary(id, sum); err != nil {
		return err
	}
	if err := s.st.ReplaceMeetingActions(id, acts); err != nil {
		return err
	}
	if t, ok := meetingTitle(out.Title); ok && t != "" {
		if err := s.st.SetMeetingTitleIfEmpty(id, t); err != nil {
			return err
		}
	}
	s.setMeetingState(id, "ready", "", 100, "")
	if err := s.projectMeeting(id); err != nil {
		return err
	}
	return nil
}

// projectMeeting recomputes the meeting's "mine" and rewrites its row in the project's meeting_notes
// (none while it is not ready or has no project), then fires the project's briefing event.
func (s *Server) projectMeeting(id string) error {
	m, err := s.st.MeetingDetail(id)
	if err != nil {
		return err
	}
	if m.Status != "ready" || m.Summary == nil {
		return nil
	}
	names := s.mineNames(m.ProjectID)
	mine := map[string]bool{}
	for i, a := range m.Actions {
		mine[a.ID] = isMine(a.Owner, names, m.Channels)
		m.Actions[i].Mine = mine[a.ID]
	}
	if err := s.st.SetMeetingActionsMine(id, mine); err != nil {
		return err
	}
	var note *proto.MeetingNote
	if m.ProjectID != "" {
		note = meetingProjection(m, names, s.hub.now())
	}
	if err := s.st.SetMeetingProjection(id, note, s.hub.now().UnixMilli()); err != nil {
		return err
	}
	s.hub.briefingChanged(m.ProjectID)
	return nil
}

// meetingProjection is the meeting as a meeting note: "- " bullets, and the owner's actions written as
// "- <person or first alias>: text" so the briefing's personActions picks them.
func meetingProjection(m proto.Meeting, names []string, now time.Time) *proto.MeetingNote {
	line := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	var dec, open, acts []string
	for _, d := range m.Summary.Decisions {
		dec = append(dec, "- "+line(d.Text))
	}
	for _, d := range m.Summary.OpenPoints {
		open = append(open, "- "+line(d.Text))
	}
	for _, a := range m.Actions {
		switch {
		case a.Mine:
			acts = append(acts, "- "+names[0]+": "+line(a.Text))
		case strings.TrimSpace(a.Owner) != "":
			acts = append(acts, "- "+line(a.Owner)+": "+line(a.Text))
		default:
			acts = append(acts, "- "+line(a.Text))
		}
	}
	title := firstNonEmpty(strings.TrimSpace(m.Title), strings.TrimSpace(m.Summary.Title), "Meeting")
	return &proto.MeetingNote{
		Title: title, Date: time.UnixMilli(m.StartedAt).Format(time.DateOnly), Summary: m.Summary.Summary,
		Decisions: strings.Join(dec, "\n"), OpenPoints: strings.Join(open, "\n"), Actions: strings.Join(acts, "\n"),
		UpdatedAt: now.UnixMilli(),
	}
}

// reprojectMeetings rewrites the projection (and "mine") of the ready meetings of f: the aliases or the
// project person changed.
func (s *Server) reprojectMeetings(f store.MeetingFilter) {
	ms, err := s.st.Meetings(f)
	if err != nil {
		log.Printf("hub: meetings: reproject: %v", err)
		return
	}
	for _, m := range ms {
		if m.Status == "ready" {
			if err := s.projectMeeting(m.ID); err != nil {
				log.Printf("hub: meetings: reproject %s: %v", m.ID, err)
			}
		}
	}
}

// applySpeakerNames shows each segment with the name its label was given (Label keeps the label).
func applySpeakerNames(m *proto.Meeting) {
	for i, sg := range m.Segments {
		m.Segments[i].Label = sg.Speaker
		if n := strings.TrimSpace(m.Speakers[sg.Speaker]); n != "" && sg.Speaker != "" {
			m.Segments[i].Speaker = n
		}
	}
}

// handleMeetingSpeakers: POST /api/meetings/{id}/speakers {label: name} names the meeting's speakers (""
// removes a name). The names show in the transcript and go to the next summary. (POST: a PUT on this path
// would clash with the upload route in the mux.)
func (s *Server) handleMeetingSpeakers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b map[string]string
	if !decode(w, r, &b) {
		return
	}
	segs, err := s.st.MeetingSegments(id)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	labels := map[string]bool{}
	for _, sg := range segs {
		labels[sg.Speaker] = true
	}
	if len(b) > maxSpeakerNames {
		apiErr(w, 400, "too many speakers")
		return
	}
	names := map[string]string{}
	for label, name := range b {
		name = strings.Join(strings.Fields(name), " ")
		if label == "" || !labels[label] {
			apiErr(w, 400, "no speaker "+label+" in this meeting")
			return
		}
		if utf8.RuneCountInString(name) > maxNameRunes || strings.ContainsRune(name, 0) {
			apiErr(w, 400, "the name is too long")
			return
		}
		names[label] = name
	}
	if err := s.st.SetMeetingSpeakers(id, names); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such meeting")
		return
	} else if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	m, err := s.st.MeetingDetail(id)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	applySpeakerNames(&m)
	s.publishMeeting(m.ID, m.ProjectID, m.Status)
	writeJSON(w, 200, m)
}

// handleReprocessMeeting: POST /api/meetings/{id}/reprocess {provider?} summarises the transcript again
// (with the speaker names given since). Actions that have an issue are kept; the projection is rewritten.
func (s *Server) handleReprocessMeeting(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b struct {
		Provider string `json:"provider"`
	}
	if r.ContentLength != 0 && !decode(w, r, &b) {
		return
	}
	if b.Provider != "" && !validProvider(b.Provider) {
		apiErr(w, 400, "unknown summary provider")
		return
	}
	m, err := s.st.Meeting(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such meeting")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	switch m.Status {
	case "uploaded", "queued", "transcribing":
		apiErr(w, 409, "the meeting is not transcribed yet")
		return
	}
	segs, err := s.st.MeetingSegments(id)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if len(segs) == 0 && m.Status == "failed" {
		apiErr(w, 409, "the meeting has no transcript; press Retry to transcribe it")
		return
	}
	if err := s.summarizeMeeting(id, b.Provider); err != nil {
		apiErr(w, 400, trimRunes(err.Error(), maxJobError))
		return
	}
	m, _ = s.st.Meeting(id)
	writeJSON(w, 202, m)
}

// handleMeetingActionIssue: POST /api/meetings/{id}/actions/{actionId}/issue creates a GitHub issue from the
// action in the repo of the project's GitHub connector, or returns the one already created.
func (s *Server) handleMeetingActionIssue(w http.ResponseWriter, r *http.Request) {
	id, aid := r.PathValue("id"), r.PathValue("actionId")
	m, err := s.st.Meeting(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such meeting")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if _, err := s.st.MeetingAction(id, aid); errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such action")
		return
	} else if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if m.ProjectID == "" {
		apiErr(w, 400, "the meeting has no project")
		return
	}
	p, err := s.st.GetProject(m.ProjectID)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if p.Connector.Kind != "github" || strings.TrimSpace(p.Connector.Settings["repo"]) == "" {
		apiErr(w, 400, "the project has no GitHub connector")
		return
	}
	// one creation at a time, so two taps never make two issues
	s.meet.issueMu.Lock()
	defer s.meet.issueMu.Unlock()
	a, err := s.st.MeetingAction(id, aid)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if a.IssueURL != "" {
		writeJSON(w, 200, map[string]any{"url": a.IssueURL, "created": false, "action": a})
		return
	}
	token, err := s.st.ConnectorToken(p.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		apiErr(w, 500, "internal error")
		return
	}
	// not the request's context: a client that goes away must not leave an issue on GitHub unrecorded
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	u, err := s.meet.createIssue(ctx, p.Connector, token, connectors.BuildEnv(s.st, p.WorkspaceID), issueTitle(a), issueBody(a, m, meetingLink(r, id)))
	if err != nil {
		apiErr(w, 502, trimRunes(err.Error(), maxJobError))
		return
	}
	if _, err := s.st.SetMeetingActionIssue(id, aid, u); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	a, _ = s.st.MeetingAction(id, aid)
	s.publishMeeting(m.ID, m.ProjectID, m.Status)
	writeJSON(w, 201, map[string]any{"url": a.IssueURL, "created": true, "action": a})
}

func issueTitle(a proto.MeetingAction) string {
	t := strings.Join(strings.Fields(a.Text), " ")
	if utf8.RuneCountInString(t) > issueTitleRunes {
		t = string([]rune(t)[:issueTitleRunes-1]) + "…"
	}
	return t
}

func issueBody(a proto.MeetingAction, m proto.Meeting, link string) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(a.Text) + "\n\n")
	if a.Owner != "" {
		b.WriteString("Owner: " + a.Owner + "\n")
	}
	if a.Due != "" {
		b.WriteString("Due: " + a.Due + "\n")
	}
	title := firstNonEmpty(strings.TrimSpace(m.Title), "Untitled meeting")
	fmt.Fprintf(&b, "From the meeting %q on %s", title, time.UnixMilli(m.StartedAt).Format(time.DateOnly))
	if a.TsMs > 0 {
		b.WriteString(" (at " + fmtTs(a.TsMs) + ")")
	}
	b.WriteString(".\n")
	if link != "" {
		b.WriteString("\nMeeting in Quorum: " + link + "\n")
	}
	return b.String()
}

// meetingLink is the meeting's address in the Quorum app at the hub the request came to
// ("<origin>/?meeting=<id>").
func meetingLink(r *http.Request, id string) string {
	base := ""
	if o := r.Header.Get("Origin"); o != "" {
		if u, err := url.Parse(o); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
			base = u.Scheme + "://" + u.Host
		}
	}
	if base == "" && r.Host != "" {
		scheme := "http"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	if base == "" {
		return ""
	}
	return base + "/?meeting=" + url.QueryEscape(id)
}

// handleGetMeetingSettings: GET /api/settings/meetings (the key is never returned: hasKey).
func (s *Server) handleGetMeetingSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.meetingSettings())
}

// handlePutMeetingSettings: PUT /api/settings/meetings {provider?, model?, baseUrl?, key?, language?,
// aliases?}; key is write-only ("" removes it). Changed aliases rewrite every meeting's "mine".
func (s *Server) handlePutMeetingSettings(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Provider *string   `json:"provider"`
		Model    *string   `json:"model"`
		BaseURL  *string   `json:"baseUrl"`
		Key      *string   `json:"key"`
		Language *string   `json:"language"`
		Aliases  *[]string `json:"aliases"`
	}
	if !decode(w, r, &b) {
		return
	}
	set := s.meetingSettings()
	if b.Provider != nil {
		if !validProvider(*b.Provider) {
			apiErr(w, 400, "unknown summary provider")
			return
		}
		set.Provider = *b.Provider
	}
	if b.Model != nil {
		m := strings.TrimSpace(*b.Model)
		if utf8.RuneCountInString(m) > 200 || strings.ContainsAny(m, "\x00\n") {
			apiErr(w, 400, "invalid model")
			return
		}
		set.Model = m
	}
	if b.BaseURL != nil {
		u := strings.TrimSpace(*b.BaseURL)
		if u != "" && !summary.ValidBaseURL(u) {
			apiErr(w, 400, "the base URL must be an http(s) URL")
			return
		}
		set.BaseURL = u
	}
	if b.Language != nil {
		if !validMeetingLanguage(*b.Language) {
			apiErr(w, 400, "invalid language")
			return
		}
		set.Language = *b.Language
	}
	aliasesChanged := false
	if b.Aliases != nil {
		var out []string
		seen := map[string]bool{}
		for _, a := range *b.Aliases {
			a = strings.Join(strings.Fields(a), " ")
			if a == "" || seen[strings.ToLower(a)] {
				continue
			}
			if utf8.RuneCountInString(a) > maxNameRunes || strings.ContainsRune(a, 0) {
				apiErr(w, 400, "a name is too long")
				return
			}
			seen[strings.ToLower(a)] = true
			out = append(out, a)
		}
		if len(out) > maxAliases {
			apiErr(w, 400, "at most 20 names")
			return
		}
		if out == nil {
			out = []string{}
		}
		aliasesChanged = strings.Join(out, "\x00") != strings.Join(set.Aliases, "\x00")
		set.Aliases = out
	}
	if b.Key != nil {
		k := strings.TrimSpace(*b.Key)
		if len(k) > 4096 || strings.ContainsAny(k, "\x00\n\r") {
			apiErr(w, 400, "invalid key")
			return
		}
		if err := s.st.SetMeta(metaMeetingKey, k); err != nil {
			apiErr(w, 500, "internal error")
			return
		}
	}
	raw, _ := json.Marshal(set)
	if err := s.st.SetMeta(metaMeetingSettings, string(raw)); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if aliasesChanged {
		s.reprojectMeetings(store.MeetingFilter{})
	}
	writeJSON(w, 200, s.meetingSettings())
}
