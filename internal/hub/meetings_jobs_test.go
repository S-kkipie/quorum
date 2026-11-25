package hub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

type jobFx struct {
	*meetFx
	ts *httptest.Server
}

func newJobFx(t *testing.T) *jobFx {
	t.Helper()
	f := &jobFx{meetFx: newMeetFx(t)}
	f.ts = httptest.NewServer(f.h)
	t.Cleanup(f.ts.Close)
	return f
}

// worker is a fake machine on the hub's machine link.
type worker struct {
	t    *testing.T
	name string
	c    *websocket.Conn
	mu   sync.Mutex
	// refuse makes meeting_job_start answer this error (e.g. a busy daemon)
	refuse string
	starts chan proto.MeetingJobStart
	cancel chan proto.MeetingJobCancel
}

// connect links a fake machine; transcribe sets the Transcribe capability in its hello.
func (f *jobFx) connect(t *testing.T, name string, transcribe bool) *worker {
	t.Helper()
	tok, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, f.st.AddToken("machine", name, tok))
	return f.reconnect(t, name, tok, transcribe)
}

func (f *jobFx) reconnect(t *testing.T, name, tok string, transcribe bool) *worker {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.ts.URL, "http")+"/api/machine/ws",
		&websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok}}})
	require.NoError(t, err)
	t.Cleanup(func() { c.CloseNow() })
	w := &worker{t: t, name: name, c: c, starts: make(chan proto.MeetingJobStart, 8), cancel: make(chan proto.MeetingJobCancel, 8)}
	hello := proto.MachineHello{Machine: name, OS: "linux", Env: "wsl", Version: proto.Version,
		Caps: proto.MachineCaps{Transcribe: transcribe, MeetingWorker: map[bool]string{true: "ready"}[transcribe]}}
	require.NoError(t, wsjson.Write(context.Background(), c, proto.Envelope{Type: "hello", Machine: name, Payload: mustJSON(hello)}))
	go func() {
		for {
			var env proto.Envelope
			if wsjson.Read(context.Background(), c, &env) != nil {
				return
			}
			var r proto.RPC
			if env.Type != "rpc" || json.Unmarshal(env.Payload, &r) != nil {
				continue
			}
			res := proto.RPCResult{ReqID: r.ReqID, Result: mustJSON(map[string]bool{"ok": true})}
			var started *proto.MeetingJobStart
			switch r.Method {
			case "meeting_job_start":
				w.mu.Lock()
				refuse := w.refuse
				w.mu.Unlock()
				if refuse != "" {
					res = proto.RPCResult{ReqID: r.ReqID, Error: refuse}
				} else {
					var p proto.MeetingJobStart
					_ = json.Unmarshal(r.Params, &p)
					started = &p
				}
			case "meeting_job_cancel":
				var p proto.MeetingJobCancel
				_ = json.Unmarshal(r.Params, &p)
				w.cancel <- p
			}
			_ = wsjson.Write(context.Background(), c, proto.Envelope{Type: "rpc_result", Payload: mustJSON(res)})
			// announced after the answer, so a test that closes the link next never races the rpc result
			if started != nil {
				w.starts <- *started
			}
		}
	}()
	eventually(t, func() bool { return online2(f.st, name) && f.s.hub.Connected(name) })
	return w
}

func (w *worker) start() proto.MeetingJobStart {
	w.t.Helper()
	select {
	case p := <-w.starts:
		return p
	case <-time.After(3 * time.Second):
		w.t.Fatalf("%s got no meeting_job_start", w.name)
		return proto.MeetingJobStart{}
	}
}

func (w *worker) noStart(d time.Duration) {
	w.t.Helper()
	select {
	case p := <-w.starts:
		w.t.Fatalf("%s got an unexpected job %+v", w.name, p)
	case <-time.After(d):
	}
}

func (w *worker) progress(p proto.MeetingProgress) {
	require.NoError(w.t, wsjson.Write(context.Background(), w.c, proto.Envelope{Type: "meeting_progress", Payload: mustJSON(p)}))
}

func postJSON(t *testing.T, base, url, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(base+url, "application/json", strings.NewReader(body))
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (f *jobFx) meeting(t *testing.T, id string) proto.Meeting {
	t.Helper()
	m, err := f.st.MeetingDetail(id)
	require.NoError(t, err)
	return m
}

func (f *jobFx) status(id string) string {
	m, err := f.st.Meeting(id)
	if err != nil {
		return "error: " + err.Error()
	}
	return m.Status
}

const transcriptBody = `{"result":{"segments":[{"start_ms":1200,"end_ms":3000,"speaker":"Speaker 2","text":" second "},
	{"start_ms":0,"end_ms":1100,"speaker":"Speaker 1","text":"first"},{"start_ms":3100,"end_ms":3200,"speaker":"","text":"  "}],
	"duration_s":61.6,"language":"es"}}`

func TestMeetingJobAssignedToTranscribeMachine(t *testing.T) {
	f := newJobFx(t)
	plain := f.connect(t, "plain", false)
	gpu := f.connect(t, "gpu", true)
	m := f.uploadMeeting(t, "", "fake audio bytes")

	p := gpu.start()
	plain.noStart(100 * time.Millisecond)
	require.Equal(t, m.ID, p.MeetingID)
	require.Equal(t, proto.MeetingStepTranscribe, p.Step)
	require.Equal(t, 1, p.Attempt)
	require.NotEmpty(t, p.JobID)
	var set proto.MeetingTranscribeSettings
	require.NoError(t, json.Unmarshal(p.Settings, &set))
	require.Equal(t, "es", set.Language)
	require.Equal(t, "large-v3-turbo", set.Model)
	eventually(t, func() bool { return f.status(m.ID) == "transcribing" })

	// the signed audio URL needs no device token
	resp, err := http.Get(f.ts.URL + p.AudioURL)
	require.NoError(t, err)
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "fake audio bytes", string(b))

	// progress moves the meeting
	gpu.progress(proto.MeetingProgress{JobID: p.JobID, Attempt: 1, Pct: 40, Stage: "transcribing"})
	eventually(t, func() bool { mm, _ := f.st.Meeting(m.ID); return mm.Progress == 40 && mm.Status == "transcribing" })
	// a report from another machine or another attempt is ignored
	plain.progress(proto.MeetingProgress{JobID: p.JobID, Attempt: 1, Pct: 90, Stage: "transcribing"})
	gpu.progress(proto.MeetingProgress{JobID: p.JobID, Attempt: 2, Pct: 95, Stage: "transcribing"})
	gpu.progress(proto.MeetingProgress{JobID: p.JobID, Attempt: 1, Pct: 60, Stage: "diarizing"})
	eventually(t, func() bool { mm, _ := f.st.Meeting(m.ID); return mm.Progress == 60 })

	code, body := postJSON(t, f.ts.URL, p.ResultURL, transcriptBody)
	require.Equal(t, 200, code, body)
	mm := f.meeting(t, m.ID)
	require.Equal(t, "summarising", mm.Status) // the local summary is queued next
	require.Equal(t, int64(62), mm.DurationS)
	require.Equal(t, []proto.MeetingSegment{
		{StartMs: 0, EndMs: 1100, Speaker: "Speaker 1", Text: "first"},
		{StartMs: 1200, EndMs: 3000, Speaker: "Speaker 2", Text: "second"},
	}, mm.Segments)
	// a second post of the same attempt is not applied again
	code, _ = postJSON(t, f.ts.URL, p.ResultURL, transcriptBody)
	require.Equal(t, 409, code)
	// and the job URL no longer serves the audio
	resp, err = http.Get(f.ts.URL + p.AudioURL)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 409, resp.StatusCode)
}

func TestMeetingJobQueuedWithoutCapableMachine(t *testing.T) {
	f := newJobFx(t)
	plain := f.connect(t, "plain", false)
	m := f.uploadMeeting(t, "", "audio")
	f.s.dispatchMeetingJobs()
	plain.noStart(150 * time.Millisecond)
	require.Equal(t, "queued", f.status(m.ID))
	q, err := f.st.MeetingJobsWithStatus(store.JobQueued)
	require.NoError(t, err)
	require.Len(t, q, 1)

	// a capable machine coming online takes it
	gpu := f.connect(t, "gpu", true)
	p := gpu.start()
	require.Equal(t, m.ID, p.MeetingID)
}

func TestMeetingJobOneAtATimePerMachine(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	m1 := f.uploadMeeting(t, "", "one")
	p1 := gpu.start()
	m2 := f.uploadMeeting(t, "", "two")
	f.s.dispatchMeetingJobs()
	gpu.noStart(150 * time.Millisecond)
	require.Equal(t, "queued", f.status(m2.ID))
	code, body := postJSON(t, f.ts.URL, p1.ResultURL, transcriptBody)
	require.Equal(t, 200, code, body)
	require.Equal(t, "summarising", f.status(m1.ID))
	p2 := gpu.start() // the oldest job first: m2's transcription, then m1's summary
	require.Equal(t, m2.ID, p2.MeetingID)
}

func TestMeetingJobRefusedGoesBackToQueue(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	gpu.mu.Lock()
	gpu.refuse = "busy: another meeting job is running"
	gpu.mu.Unlock()
	m := f.uploadMeeting(t, "", "audio")
	eventually(t, func() bool {
		q, _ := f.st.MeetingJobsWithStatus(store.JobQueued)
		return len(q) == 1 && f.status(m.ID) == "queued"
	})
	gpu.mu.Lock()
	gpu.refuse = ""
	gpu.mu.Unlock()
	f.s.dispatchMeetingJobs()
	require.Equal(t, 1, gpu.start().Attempt)
}

func TestMeetingJobOfflineRequeuedAndStaleAttemptDiscarded(t *testing.T) {
	f := newJobFx(t)
	tok, _ := NewToken()
	require.NoError(t, f.st.AddToken("machine", "gpu", tok))
	gpu := f.reconnect(t, "gpu", tok, true)
	m := f.uploadMeeting(t, "", "audio")
	p1 := gpu.start()

	gpu.c.CloseNow() // the laptop goes off mid-transcription
	eventually(t, func() bool { return !f.s.hub.Connected("gpu") })
	f.s.checkMeetingJobs(time.Now().Add(time.Minute))
	j, err := f.st.MeetingJob(p1.JobID)
	require.NoError(t, err)
	require.Equal(t, store.JobRunning, j.Status, "under 2 min of silence the job waits")

	f.s.checkMeetingJobs(time.Now().Add(jobSilence + 10*time.Second))
	j, err = f.st.MeetingJob(p1.JobID)
	require.NoError(t, err)
	require.Equal(t, store.JobQueued, j.Status)
	require.Equal(t, 2, j.Attempt)
	require.Equal(t, "queued", f.status(m.ID))

	// the old attempt's late result is discarded
	code, _ := postJSON(t, f.ts.URL, p1.ResultURL, transcriptBody)
	require.Equal(t, 409, code)
	require.Equal(t, "queued", f.status(m.ID))
	require.Empty(t, f.meeting(t, m.ID).Segments)

	// the laptop comes back: attempt 2 runs there and finishes the meeting
	gpu2 := f.reconnect(t, "gpu", tok, true)
	p2 := gpu2.start()
	require.Equal(t, p1.JobID, p2.JobID)
	require.Equal(t, 2, p2.Attempt)
	require.NotEqual(t, p1.ResultURL, p2.ResultURL)
	// attempt 1 finishing late, while attempt 2 runs, is still discarded
	code, _ = postJSON(t, f.ts.URL, p1.ResultURL, transcriptBody)
	require.Equal(t, 409, code)
	require.Equal(t, "transcribing", f.status(m.ID))
	code, body := postJSON(t, f.ts.URL, p2.ResultURL, transcriptBody)
	require.Equal(t, 200, code, body)
	require.Equal(t, "summarising", f.status(m.ID))
	require.Len(t, f.meeting(t, m.ID).Segments, 2)
}

func TestMeetingJobHeartbeatKeepsItRunning(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	f.uploadMeeting(t, "", "audio")
	p := gpu.start()
	base := time.Now()
	f.st.SetClockForTest(func() time.Time { return base.Add(100 * time.Second) })
	gpu.progress(proto.MeetingProgress{JobID: p.JobID, Attempt: 1, Pct: 10, Stage: "transcribing"})
	eventually(t, func() bool { j, _ := f.st.MeetingJob(p.JobID); return j.Pct == 10 })
	f.s.checkMeetingJobs(base.Add(3 * time.Minute)) // 80 s after the heartbeat
	j, _ := f.st.MeetingJob(p.JobID)
	require.Equal(t, store.JobRunning, j.Status)
}

func TestMeetingJobFailsAfterThreeLostAttempts(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	m := f.uploadMeeting(t, "", "audio")
	for attempt := 1; attempt <= maxJobAttempts; attempt++ {
		p := gpu.start()
		require.Equal(t, attempt, p.Attempt)
		f.s.checkMeetingJobs(time.Now().Add(jobSilence + time.Minute))
		c := <-gpu.cancel // the silent attempt is stopped on the machine
		require.Equal(t, attempt, c.Attempt)
	}
	mm := f.meeting(t, m.ID)
	require.Equal(t, "failed", mm.Status)
	require.Contains(t, mm.Error, "stopped responding 3 times")
	gpu.noStart(150 * time.Millisecond) // no endless retries
}

func TestMeetingJobWorkerErrorFailsAndRetry(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	m := f.uploadMeeting(t, "", "audio")
	p := gpu.start()
	code, body := postJSON(t, f.ts.URL, p.ResultURL, `{"error":"CUDA error: out of memory while loading the Whisper model"}`)
	require.Equal(t, 200, code, body)
	mm := f.meeting(t, m.ID)
	require.Equal(t, "failed", mm.Status)
	require.Equal(t, "CUDA error: out of memory while loading the Whisper model", mm.Error)
	gpu.noStart(150 * time.Millisecond) // a worker error is final

	// Retry processes it again from the audio as a new job
	rr := f.do("POST", "/api/meetings/"+m.ID+"/retry", "")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	p2 := gpu.start()
	require.NotEqual(t, p.JobID, p2.JobID)
	require.Equal(t, 1, p2.Attempt)
	require.Equal(t, "transcribing", f.status(m.ID))
	// only failed meetings retry
	require.Equal(t, 409, f.do("POST", "/api/meetings/"+m.ID+"/retry", "").Code)
}

func TestMeetingJobBadTokenForbidden(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	m := f.uploadMeeting(t, "", "audio")
	p := gpu.start()
	code, _ := postJSON(t, f.ts.URL, "/api/meeting-jobs/garbage/result", transcriptBody)
	require.Equal(t, 403, code)
	tampered := strings.Replace(p.ResultURL, "/result", "x/result", 1)
	code, _ = postJSON(t, f.ts.URL, tampered, transcriptBody)
	require.Equal(t, 403, code)
	// a playback token is not a job token
	audioTok, err := f.st.CreateMeetingToken("audio", m.ID, "", time.Hour)
	require.NoError(t, err)
	code, _ = postJSON(t, f.ts.URL, "/api/meeting-jobs/"+audioTok+"/result", transcriptBody)
	require.Equal(t, 403, code)
	resp, err := http.Get(f.ts.URL + "/api/meeting-jobs/" + audioTok + "/audio")
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 403, resp.StatusCode)
	// an invalid result changes nothing
	code, _ = postJSON(t, f.ts.URL, p.ResultURL, `{"result":"not a transcript"}`)
	require.Equal(t, 400, code)
	require.Equal(t, "transcribing", f.status(m.ID))
}

func TestMeetingJobCancelledOnDelete(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	m := f.uploadMeeting(t, "", "audio")
	p := gpu.start()
	require.Equal(t, 204, f.do("DELETE", "/api/meetings/"+m.ID, "").Code)
	select {
	case c := <-gpu.cancel:
		require.Equal(t, p.JobID, c.JobID)
		require.Equal(t, 1, c.Attempt)
	case <-time.After(3 * time.Second):
		t.Fatal("no meeting_job_cancel")
	}
	code, _ := postJSON(t, f.ts.URL, p.ResultURL, transcriptBody)
	require.Equal(t, 403, code) // the meeting's tokens went with it
	_, err := f.st.MeetingJob(p.JobID)
	require.ErrorIs(t, err, store.ErrNotFound) // and its jobs
}

func TestMeetingJobsSurviveRestart(t *testing.T) {
	f := newJobFx(t)
	m := f.uploadMeeting(t, "", "audio")
	// a new server on the same store (hub restart) still has the job and hands it out
	s2 := NewServer(f.st)
	s2.audioDir = f.dir
	ts2 := httptest.NewServer(s2.Handler())
	t.Cleanup(ts2.Close)
	f2 := &jobFx{meetFx: &meetFx{s: s2, st: f.st, h: s2.Handler(), auth: f.auth, dir: f.dir}, ts: ts2}
	gpu := f2.connect(t, "gpu", true)
	p := gpu.start()
	require.Equal(t, m.ID, p.MeetingID)
}

func TestMeetingJobStaleProgressCancelsTheOldAttempt(t *testing.T) {
	f := newJobFx(t)
	gpu := f.connect(t, "gpu", true)
	f.uploadMeeting(t, "", "audio")
	p := gpu.start()
	f.s.checkMeetingJobs(time.Now().Add(jobSilence + time.Minute)) // re-queued as attempt 2
	<-gpu.cancel
	p2 := gpu.start()
	require.Equal(t, 2, p2.Attempt)
	// the machine still reports attempt 1: it is told to stop it, and attempt 2 is untouched
	gpu.progress(proto.MeetingProgress{JobID: p.JobID, Attempt: 1, Pct: 50, Stage: "transcribing"})
	select {
	case c := <-gpu.cancel:
		require.Equal(t, proto.MeetingJobCancel{JobID: p.JobID, Attempt: 1}, c)
	case <-time.After(3 * time.Second):
		t.Fatal("no cancel for the stale attempt")
	}
	j, _ := f.st.MeetingJob(p.JobID)
	require.Equal(t, store.JobRunning, j.Status)
	require.Equal(t, 2, j.Attempt)
	require.Equal(t, 0, j.Pct)
}

func TestMeetingJobSkippedJobLeavesTheMachineFree(t *testing.T) {
	f := newJobFx(t)
	gone := f.uploadMeeting(t, "", "first")
	next := f.uploadMeeting(t, "", "second")
	require.NoError(t, f.st.DropMeetingAudio(gone.ID)) // the oldest job cannot run
	gpu := f.connect(t, "gpu", true)
	p := gpu.start()
	require.Equal(t, next.ID, p.MeetingID, "the machine takes the next job in the same dispatch")
	require.Equal(t, "failed", f.status(gone.ID))
}

func TestMeetingSpeakersReachTheTranscription(t *testing.T) {
	f := newJobFx(t)
	m := f.uploadMeeting(t, "", "audio")
	require.Equal(t, 400, f.do("PATCH", "/api/meetings/"+m.ID, `{"speakers":21}`).Code)
	require.Equal(t, 400, f.do("PATCH", "/api/meetings/"+m.ID, `{"speakers":-1}`).Code)
	rr := f.do("PATCH", "/api/meetings/"+m.ID, `{"speakers":4}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	var got proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, 4, got.SpeakerCount)
	gpu := f.connect(t, "gpu", true)
	var set proto.MeetingTranscribeSettings
	require.NoError(t, json.Unmarshal(gpu.start().Settings, &set))
	require.Equal(t, 4, set.Speakers)
}
