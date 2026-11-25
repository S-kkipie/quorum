package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Meeting jobs: the hub keeps a persistent queue of processing steps (store.MeetingJob) and hands each
// queued job to an online machine that reports the Transcribe capability, one job per machine at a time.
// The rpc meeting_job_start only starts the worker; the machine then reports meeting_progress envelopes
// (also as a heartbeat) and POSTs the result to the attempt's signed URL. A running job whose machine has
// been silent for more than jobSilence is re-queued as attempt+1; after maxJobAttempts lost attempts, or
// when the worker reports an error, the meeting fails with a readable error (the app offers Retry).
const (
	jobSilence     = 2 * time.Minute
	maxJobAttempts = 3
	jobCheckEvery  = 15 * time.Second
	// maxJobResult bounds a posted result (a 2 h meeting's segments are a few MB).
	maxJobResult = 64 << 20
	maxJobError  = 500 // runes of a worker error kept on the meeting
	maxSegments  = 100000
	maxSegText   = 4000
	// defaultWhisperModel is the transcription model the spike chose.
	defaultWhisperModel = "large-v3-turbo"
	defaultLanguage     = "es"
)

// jobStep describes how a step runs: the meeting status while it is queued and while it runs, whether
// the worker needs the audio, and how its result is checked and applied.
type jobStep struct {
	queuedStatus  string
	runningStatus string
	needsAudio    bool
	// needsTranscript: the worker fetches the transcript from the job's transcript URL
	needsTranscript bool
	// settings builds the step's settings at dispatch time ("" keeps the job's stored settings).
	settings func(s *Server, job store.MeetingJob, m proto.Meeting) (string, error)
	// parse checks a result before it is claimed (an invalid result changes nothing: 400).
	parse func(raw json.RawMessage) (any, error)
	// apply stores a claimed result and moves the meeting on.
	apply func(s *Server, job store.MeetingJob, v any) error
}

// meetingJobs is the server's job state.
type meetingJobs struct {
	mu    sync.Mutex  // serializes dispatching
	kick  atomic.Bool // a dispatch is pending
	steps map[string]jobStep
	// onTranscribed runs after a transcript is stored (the summary, meetings_summary.go); nil makes the
	// meeting ready.
	onTranscribed func(meetingID string)
	// onLocalSummary applies a summarize_local result; nil fails the job.
	onLocalSummary func(job store.MeetingJob, raw json.RawMessage) error
}

func (s *Server) initMeetingJobs() {
	s.jobs.steps = map[string]jobStep{
		proto.MeetingStepTranscribe: {
			queuedStatus: "queued", runningStatus: "transcribing", needsAudio: true,
			settings: transcribeSettings, parse: parseTranscript, apply: applyTranscript,
		},
		proto.MeetingStepSummarizeLocal: {
			queuedStatus: "summarising", runningStatus: "summarising",
			parse: func(raw json.RawMessage) (any, error) {
				var obj map[string]json.RawMessage
				if err := json.Unmarshal(raw, &obj); err != nil {
					return nil, errors.New("the summary is not a JSON object")
				}
				return raw, nil
			},
			apply: func(s *Server, job store.MeetingJob, v any) error {
				if s.jobs.onLocalSummary == nil {
					return errors.New("this hub cannot store local summaries")
				}
				return s.jobs.onLocalSummary(job, v.(json.RawMessage))
			},
		},
	}
	if err := s.st.ResetMeetingJobHeartbeats(); err != nil {
		log.Printf("hub: meetings: job heartbeats: %v", err)
	}
	s.recoverQueuedMeetings()
	s.hub.onMeetingProgress = s.onMeetingProgress
	s.hub.onMachineChanged = func(string) { s.kickJobs() }
}

// recoverQueuedMeetings gives a job to every queued (or uploaded but never queued) meeting that has none
// (a hub stopped between the status change and the job, or a meeting queued before jobs existed).
func (s *Server) recoverQueuedMeetings() {
	ms, err := s.st.Meetings(store.MeetingFilter{})
	if err != nil {
		log.Printf("hub: meetings: recover jobs: %v", err)
		return
	}
	for _, m := range ms {
		if m.Status != "uploaded" && m.Status != "queued" && m.Status != "transcribing" {
			continue
		}
		if act, err := s.st.ActiveMeetingJobs(m.ID); err != nil || len(act) > 0 {
			continue
		}
		if _, err := s.st.CreateMeetingJob(m.ID, proto.MeetingStepTranscribe, ""); err != nil {
			log.Printf("hub: meetings: recover job of %s: %v", m.ID, err)
			continue
		}
		if m.Status != "queued" {
			s.setMeetingState(m.ID, "queued", "", 0, "")
		}
	}
}

// startMeetingJobs runs the silence check (and a dispatch) every jobCheckEvery until ctx ends.
func (s *Server) startMeetingJobs(ctx context.Context) {
	go func() {
		t := time.NewTicker(jobCheckEvery)
		defer t.Stop()
		s.recoverSummaries()
		s.kickJobs()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.checkMeetingJobs(s.hub.now())
				s.kickJobs()
			}
		}
	}()
}

// enqueueMeetingJob queues a step of the meeting and starts a dispatch.
func (s *Server) enqueueMeetingJob(meetingID, step, settings string) (store.MeetingJob, error) {
	j, err := s.st.CreateMeetingJob(meetingID, step, settings)
	if err != nil {
		return j, err
	}
	s.kickJobs()
	return j, nil
}

// kickJobs starts a dispatch in the background; kicks that arrive while one is pending fold into it.
func (s *Server) kickJobs() {
	if !s.jobs.kick.CompareAndSwap(false, true) {
		return
	}
	go s.dispatchMeetingJobs()
}

// dispatchMeetingJobs hands queued jobs to idle capable machines, oldest job first.
func (s *Server) dispatchMeetingJobs() {
	s.jobs.mu.Lock()
	defer s.jobs.mu.Unlock()
	s.jobs.kick.Store(false)
	queued, err := s.st.MeetingJobsWithStatus(store.JobQueued)
	if err != nil || len(queued) == 0 {
		if err != nil {
			log.Printf("hub: meetings: queued jobs: %v", err)
		}
		return
	}
	idle := s.idleTranscribers()
	for _, j := range queued {
		if len(idle) == 0 {
			return
		}
		switch s.startMeetingJob(j, idle[0]) {
		case jobStarted, jobRefused:
			// started: the machine is busy; refused: the job waits for the next machine
			idle = idle[1:]
		case jobSkipped:
			// the job ended without reaching the machine, which stays free for the next job
		}
	}
}

// startOutcome is what a dispatch attempt did with the machine.
type startOutcome int

const (
	jobStarted startOutcome = iota // the machine took the job (or may have: no answer)
	jobRefused                     // the machine did not take it; the job is queued again
	jobSkipped                     // the job never reached the machine (failed, cancelled or gone)
)

// idleTranscribers lists the connected machines with Transcribe that run no job, by name.
func (s *Server) idleTranscribers() []string {
	ms, err := s.st.ListMachines()
	if err != nil {
		log.Printf("hub: meetings: machines: %v", err)
		return nil
	}
	running, err := s.st.MeetingJobsWithStatus(store.JobRunning)
	if err != nil {
		log.Printf("hub: meetings: running jobs: %v", err)
		return nil
	}
	busy := map[string]bool{}
	for _, j := range running {
		busy[j.Machine] = true
	}
	var out []string
	for _, m := range ms {
		if m.Online && m.Caps.Transcribe && !busy[m.Name] && s.hub.Connected(m.Name) {
			out = append(out, m.Name)
		}
	}
	sort.Strings(out)
	return out
}

func jobRef(id string, attempt int) string { return id + ":" + strconv.Itoa(attempt) }

func parseJobRef(ref string) (string, int, bool) {
	id, a, ok := strings.Cut(ref, ":")
	n, err := strconv.Atoi(a)
	return id, n, ok && err == nil && id != ""
}

// startMeetingJob gives job to machine.
func (s *Server) startMeetingJob(j store.MeetingJob, machine string) startOutcome {
	step, ok := s.jobs.steps[j.Step]
	if !ok {
		s.failJob(j, "unknown processing step "+j.Step)
		return jobSkipped
	}
	m, err := s.st.Meeting(j.MeetingID)
	if errors.Is(err, store.ErrNotFound) {
		s.st.FailMeetingJob(j.ID, "the meeting is gone")
		return jobSkipped
	}
	if err != nil {
		log.Printf("hub: meetings: job %s: %v", j.ID, err)
		return jobSkipped
	}
	if step.needsAudio && !m.HasAudio {
		s.failJob(j, "The recording is no longer on the hub, so it cannot be transcribed.")
		return jobSkipped
	}
	settings := j.Settings
	if step.settings != nil {
		if settings, err = step.settings(s, j, m); err != nil {
			s.failJob(j, err.Error())
			return jobSkipped
		}
	}
	if ok, err := s.st.StartMeetingJob(j.ID, machine); err != nil || !ok {
		return jobSkipped // cancelled meanwhile
	}
	ref := jobRef(j.ID, j.Attempt)
	tok, err := s.st.CreateMeetingToken("job", j.MeetingID, ref, store.MeetingJobTokenTTL)
	if err != nil {
		log.Printf("hub: meetings: job token: %v", err)
		s.st.UnstartMeetingJob(j.ID, j.Attempt)
		return jobSkipped
	}
	req := proto.MeetingJobStart{
		JobID: j.ID, Attempt: j.Attempt, MeetingID: j.MeetingID, Step: j.Step,
		ResultURL: "/api/meeting-jobs/" + tok + "/result", Settings: json.RawMessage(settings),
	}
	if step.needsAudio {
		req.AudioURL = "/api/meeting-jobs/" + tok + "/audio"
	}
	if step.needsTranscript {
		req.TranscriptURL = "/api/meeting-jobs/" + tok + "/transcript"
	}
	s.setMeetingState(m.ID, step.runningStatus, "", 0, "starting")
	err = s.hub.call(context.Background(), machine, "meeting_job_start", req, nil)
	switch {
	case err == nil:
		return jobStarted
	case errors.Is(err, errTimeout) || errors.Is(err, context.DeadlineExceeded):
		// it may have started: progress (or the silence rule) decides
		log.Printf("hub: meetings: %s did not answer the start of job %s", machine, j.ID)
		return jobStarted
	default:
		log.Printf("hub: meetings: %s did not take job %s: %v", machine, j.ID, err)
		if ok, _ := s.st.UnstartMeetingJob(j.ID, j.Attempt); ok {
			s.st.DeleteMeetingTokensRef("job", ref)
			s.setMeetingState(m.ID, step.queuedStatus, "", 0, "")
		}
		return jobRefused
	}
}

func transcribeSettings(s *Server, _ store.MeetingJob, m proto.Meeting) (string, error) {
	lang := m.Language
	if lang == "" {
		lang = s.defaultMeetingLanguage()
	}
	b, err := json.Marshal(proto.MeetingTranscribeSettings{Language: lang, Channels: m.Channels, Speakers: m.SpeakerCount, Model: defaultWhisperModel})
	return string(b), err
}

// checkMeetingJobs re-queues (or fails, after maxJobAttempts) the running jobs whose machine has been
// silent for more than jobSilence at now.
func (s *Server) checkMeetingJobs(now time.Time) {
	running, err := s.st.MeetingJobsWithStatus(store.JobRunning)
	if err != nil {
		log.Printf("hub: meetings: running jobs: %v", err)
		return
	}
	for _, j := range running {
		if now.Sub(time.UnixMilli(j.HeartbeatAt)) <= jobSilence {
			continue
		}
		if j.Attempt >= maxJobAttempts {
			s.failJob(j, fmt.Sprintf("The machine processing this meeting (%s) stopped responding %d times. Press Retry to try again.", j.Machine, maxJobAttempts))
			s.cancelOnMachine(j)
			continue
		}
		ok, err := s.st.RequeueMeetingJob(j.ID, j.Attempt)
		if err != nil || !ok {
			continue
		}
		log.Printf("hub: meetings: %s went silent on job %s; queued again as attempt %d", j.Machine, j.ID, j.Attempt+1)
		s.cancelOnMachine(j)
		if step, ok := s.jobs.steps[j.Step]; ok {
			s.setMeetingState(j.MeetingID, step.queuedStatus, "", 0, "")
		}
	}
	s.kickJobs()
}

// cancelOnMachine asks the job's machine (when it is connected) to stop that attempt's worker.
func (s *Server) cancelOnMachine(j store.MeetingJob) { s.cancelAttempt(j.Machine, j.ID, j.Attempt) }

func (s *Server) cancelAttempt(machine, jobID string, attempt int) {
	if machine == "" || !s.hub.Connected(machine) {
		return
	}
	go func() {
		if err := s.hub.call(context.Background(), machine, "meeting_job_cancel", proto.MeetingJobCancel{JobID: jobID, Attempt: attempt}, nil); err != nil {
			log.Printf("hub: meetings: cancel job %s on %s: %v", jobID, machine, err)
		}
	}()
}

// failJob ends the job as failed and the meeting with the error.
func (s *Server) failJob(j store.MeetingJob, msg string) {
	msg = trimRunes(strings.TrimSpace(msg), maxJobError)
	if msg == "" {
		msg = "The meeting could not be processed."
	}
	if ok, err := s.st.FailMeetingJob(j.ID, msg); err != nil || !ok {
		return
	}
	s.setMeetingState(j.MeetingID, "failed", msg, 0, "")
}

func trimRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// setMeetingState stores the meeting's status and progress and publishes meeting_changed (also when
// only the progress or the stage moved).
func (s *Server) setMeetingState(id, status, errMsg string, progress int, stage string) {
	if err := s.st.SetMeetingStatus(id, status, errMsg, progress); err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("hub: meetings: status of %s: %v", id, err)
		}
		return
	}
	m, err := s.st.Meeting(id)
	if err != nil {
		return
	}
	s.publishMeetingState(m, stage)
}

// publishMeetingState sends meeting_changed with the progress and the worker's stage.
func (s *Server) publishMeetingState(m proto.Meeting, stage string) {
	p, _ := json.Marshal(map[string]any{"id": m.ID, "projectId": m.ProjectID, "status": m.Status, "progress": m.Progress, "stage": stage})
	s.hub.publish(proto.Envelope{Type: "meeting_changed", Payload: p})
}

// onMeetingProgress applies a machine's meeting_progress: only the running attempt on that machine counts.
// A machine still working on an attempt that is no longer current (re-queued, finished, cancelled or
// deleted) is told to stop it.
func (s *Server) onMeetingProgress(machine string, p proto.MeetingProgress) {
	if p.JobID == "" || p.Attempt < 1 {
		return
	}
	j, err := s.st.MeetingJob(p.JobID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return
	}
	if err != nil || j.Status != store.JobRunning || j.Attempt != p.Attempt || j.Machine != machine {
		s.cancelAttempt(machine, p.JobID, p.Attempt)
		return
	}
	pct := min(max(p.Pct, 0), 100)
	stage := trimRunes(p.Stage, 32)
	if ok, err := s.st.HeartbeatMeetingJob(j.ID, j.Attempt, machine, pct, stage); err != nil || !ok {
		return
	}
	if pct == j.Pct && stage == j.Stage {
		return // a heartbeat: nothing new to show
	}
	step, ok := s.jobs.steps[j.Step]
	if !ok {
		return
	}
	s.setMeetingState(j.MeetingID, step.runningStatus, "", pct, stage)
}

// jobFromToken resolves a job URL's token to its job and attempt; it writes the error and returns false
// when the token is bad (403) or the attempt is not the running one (409: a stale attempt is discarded).
func (s *Server) jobFromToken(w http.ResponseWriter, tok string) (store.MeetingJob, bool) {
	info, ok, err := s.st.MeetingToken("job", tok)
	if err != nil {
		apiErr(w, 500, "internal error")
		return store.MeetingJob{}, false
	}
	id, attempt, refOK := parseJobRef(info.Ref)
	if !ok || !refOK {
		apiErr(w, 403, "invalid or expired job link")
		return store.MeetingJob{}, false
	}
	j, err := s.st.MeetingJob(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 409, "this job no longer exists; the result was discarded")
		return j, false
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return j, false
	}
	if j.Attempt != attempt || j.Status != store.JobRunning {
		apiErr(w, 409, "this job attempt is no longer current; the result was discarded")
		return j, false
	}
	return j, true
}

// handleMeetingJobAudio: GET /api/meeting-jobs/{token}/audio streams the audio to the job's worker.
func (s *Server) handleMeetingJobAudio(w http.ResponseWriter, r *http.Request) {
	j, ok := s.jobFromToken(w, r.PathValue("token"))
	if !ok {
		return
	}
	s.serveMeetingAudio(w, r, j.MeetingID)
}

// handleMeetingJobResult: POST /api/meeting-jobs/{token}/result with a MeetingJobResult.
func (s *Server) handleMeetingJobResult(w http.ResponseWriter, r *http.Request) {
	j, ok := s.jobFromToken(w, r.PathValue("token"))
	if !ok {
		return
	}
	var res proto.MeetingJobResult
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJobResult)).Decode(&res); err != nil {
		apiErr(w, 400, "invalid result")
		return
	}
	step, ok := s.jobs.steps[j.Step]
	if !ok {
		apiErr(w, 400, "unknown step")
		return
	}
	if res.Error != "" {
		msg := trimRunes(strings.TrimSpace(res.Error), maxJobError)
		if ok, err := s.st.FinishMeetingJob(j.ID, j.Attempt, store.JobFailed, msg); err != nil {
			apiErr(w, 500, "internal error")
			return
		} else if !ok {
			apiErr(w, 409, "this job attempt is no longer current; the result was discarded")
			return
		}
		s.setMeetingState(j.MeetingID, "failed", msg, 0, "")
		s.kickJobs()
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	v, err := step.parse(res.Result)
	if err != nil {
		apiErr(w, 400, err.Error())
		return
	}
	if ok, err := s.st.FinishMeetingJob(j.ID, j.Attempt, store.JobDone, ""); err != nil {
		apiErr(w, 500, "internal error")
		return
	} else if !ok {
		apiErr(w, 409, "this job attempt is no longer current; the result was discarded")
		return
	}
	s.kickJobs() // the machine is free
	if err := step.apply(s, j, v); err != nil {
		log.Printf("hub: meetings: result of job %s: %v", j.ID, err)
		s.setMeetingState(j.MeetingID, "failed", trimRunes("The result could not be stored: "+err.Error(), maxJobError), 0, "")
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func parseTranscript(raw json.RawMessage) (any, error) {
	var t proto.MeetingTranscript
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, errors.New("the transcript is not valid JSON")
	}
	if len(t.Segments) > maxSegments {
		return nil, errors.New("the transcript has too many segments")
	}
	segs := make([]proto.MeetingSegment, 0, len(t.Segments))
	for _, sg := range t.Segments {
		text := trimRunes(strings.TrimSpace(sg.Text), maxSegText)
		if text == "" || sg.StartMs < 0 {
			continue
		}
		end := max(sg.EndMs, sg.StartMs)
		segs = append(segs, proto.MeetingSegment{StartMs: sg.StartMs, EndMs: end, Speaker: trimRunes(strings.TrimSpace(sg.Speaker), 64), Text: text})
	}
	sort.SliceStable(segs, func(a, b int) bool { return segs[a].StartMs < segs[b].StartMs })
	return transcript{segs: segs, duration: t.DurationS, language: t.Language}, nil
}

type transcript struct {
	segs     []proto.MeetingSegment
	duration float64
	language string
}

func applyTranscript(s *Server, j store.MeetingJob, v any) error {
	t := v.(transcript)
	if err := s.st.ReplaceMeetingSegments(j.MeetingID, t.segs); err != nil {
		return err
	}
	if t.duration > 0 {
		if err := s.st.SetMeetingDuration(j.MeetingID, int64(t.duration+0.5)); err != nil {
			return err
		}
	}
	if validMeetingLanguage(t.language) && t.language != "" && t.language != "auto" {
		if err := s.st.SetMeetingDetectedLanguage(j.MeetingID, t.language); err != nil {
			return err
		}
	}
	if s.jobs.onTranscribed != nil {
		s.jobs.onTranscribed(j.MeetingID)
		return nil
	}
	s.setMeetingState(j.MeetingID, "ready", "", 100, "")
	return nil
}

// cancelMeetingJobs cancels the meeting's jobs and stops the running workers (delete, retry).
func (s *Server) cancelMeetingJobs(meetingID string) {
	running, err := s.st.CancelMeetingJobs(meetingID)
	if err != nil {
		log.Printf("hub: meetings: cancel jobs of %s: %v", meetingID, err)
	}
	for _, j := range running {
		s.cancelOnMachine(j)
	}
	if len(running) > 0 {
		s.kickJobs() // their machines are free
	}
}

// handleRetryMeeting: POST /api/meetings/{id}/retry processes a failed meeting again from its audio.
func (s *Server) handleRetryMeeting(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m, err := s.st.Meeting(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such meeting")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if m.Status != "failed" {
		apiErr(w, 409, "only a failed meeting can be retried")
		return
	}
	// a meeting that has its transcript failed while summarising: summarise it again
	if segs, err := s.st.MeetingSegments(id); err != nil {
		apiErr(w, 500, "internal error")
		return
	} else if len(segs) > 0 {
		provider := m.Provider // the provider that failed, as the owner chose it
		if !validProvider(provider) {
			provider = ""
		}
		if err := s.summarizeMeeting(id, provider); err != nil {
			apiErr(w, 400, trimRunes(err.Error(), maxJobError))
			return
		}
		m, _ = s.st.Meeting(id)
		writeJSON(w, 200, m)
		return
	}
	if !m.HasAudio {
		apiErr(w, 409, "the recording is no longer on the hub")
		return
	}
	s.cancelMeetingJobs(id)
	if _, err := s.st.CreateMeetingJob(id, proto.MeetingStepTranscribe, ""); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	s.setMeetingState(id, "queued", "", 0, "")
	s.kickJobs()
	m, _ = s.st.Meeting(id)
	writeJSON(w, 200, m)
}
