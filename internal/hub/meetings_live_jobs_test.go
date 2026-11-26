package hub

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// liveMeeting creates a live meeting (empty audio file path in the fixture's audio dir).
func (f *jobFx) liveMeeting(t *testing.T) proto.Meeting {
	t.Helper()
	m, err := f.st.CreateLiveMeeting(store.MeetingUpload{Title: "Live", Language: "es"}, func(id string) string { return f.dir + "/" + id + ".webm" })
	require.NoError(t, err)
	return m
}

func (f *jobFx) queuedChunks(t *testing.T, id string) []store.MeetingJob {
	t.Helper()
	q, err := f.st.MeetingJobsWithStatus(store.JobQueued)
	require.NoError(t, err)
	var out []store.MeetingJob
	for _, j := range q {
		if j.MeetingID == id && j.Step == proto.MeetingStepTranscribeChunk {
			out = append(out, j)
		}
	}
	return out
}

func chunkBody(through int64, segs ...proto.MeetingWorkerSegment) string {
	b, _ := json.Marshal(map[string]any{"result": proto.MeetingChunkResult{Segments: segs, ThroughMs: through, Language: "es"}})
	return string(b)
}

func TestChunkSettingsBuiltAtDispatch(t *testing.T) {
	f := newJobFx(t)
	m := f.liveMeeting(t)
	require.NoError(t, f.st.AdvanceLive(m.ID, 3, 900, 1))
	require.NoError(t, f.st.SetLiveThrough(m.ID, 15000))
	gpu := f.connect(t, "gpu", true)
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	p := gpu.start()
	require.Equal(t, proto.MeetingStepTranscribeChunk, p.Step)
	require.NotEmpty(t, p.AudioURL)
	var set proto.MeetingChunkSettings
	require.NoError(t, json.Unmarshal(p.Settings, &set))
	require.Equal(t, int64(15000), set.FromMs)
	require.Equal(t, int64(2000), set.ContextMs)
	require.Equal(t, int64(900), set.LiveBytes)
	require.Equal(t, "large-v3", set.Model)
	require.Equal(t, "es", set.Language)
	require.Equal(t, "live", f.status(m.ID), "a chunk job never changes the meeting status")
}

func TestChunkJobsCoalesce(t *testing.T) {
	f := newJobFx(t)
	m := f.liveMeeting(t)
	for i := 0; i < 80; i++ {
		require.NoError(t, f.s.queueLiveChunk(m.ID))
	}
	require.Len(t, f.queuedChunks(t, m.ID), 1)
	ls, err := f.s.liveState(m.ID)
	require.NoError(t, err)
	require.True(t, ls.Waiting)

	require.NoError(t, f.st.AdvanceLive(m.ID, 80, 7200, 1))
	gpu := f.connect(t, "gpu", true)
	p := gpu.start()
	var set proto.MeetingChunkSettings
	require.NoError(t, json.Unmarshal(p.Settings, &set))
	require.Equal(t, int64(7200), set.LiveBytes)
	gpu.noStart(150 * time.Millisecond)
	ls, err = f.s.liveState(m.ID)
	require.NoError(t, err)
	require.False(t, ls.Waiting)
	require.Equal(t, 80, ls.Slices)
	require.Equal(t, int64(7200), ls.Bytes)

	// a new slice while the job runs queues one more, and only one
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	require.Len(t, f.queuedChunks(t, m.ID), 1)
}

func TestLiveWaitingWhenOldestChunkIsStale(t *testing.T) {
	f := newJobFx(t)
	m := f.liveMeeting(t)
	f.connect(t, "gpu", true)
	// a connected transcriber but a queued chunk older than liveWaitAfter
	_, err := f.st.CreateMeetingJob(m.ID, proto.MeetingStepTranscribeChunk, "")
	require.NoError(t, err)
	f.s.hub.now = func() time.Time { return time.Now().Add(liveWaitAfter + time.Second) }
	ls, err := f.s.liveState(m.ID)
	require.NoError(t, err)
	require.True(t, ls.Waiting)
}

func TestChunkResultAppendsAndPushes(t *testing.T) {
	f := newJobFx(t)
	m := f.liveMeeting(t)
	require.NoError(t, f.st.AdvanceLive(m.ID, 2, 500, 77))
	require.NoError(t, f.st.SetLiveThrough(m.ID, 5000))
	gpu := f.connect(t, "gpu", true)
	cp := &capture{}
	f.s.hub.SetBroadcaster(cp)
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	p := gpu.start()

	code, body := postJSON(t, f.ts.URL, p.ResultURL, chunkBody(18000,
		proto.MeetingWorkerSegment{StartMs: 0, EndMs: 4000, Text: "a"},
		proto.MeetingWorkerSegment{StartMs: 15500, EndMs: 18000, Text: " b "}))
	require.Equal(t, 200, code, body)

	segs, err := f.st.MeetingSegments(m.ID)
	require.NoError(t, err)
	require.Equal(t, []proto.MeetingSegment{{StartMs: 15500, EndMs: 18000, Text: "b"}}, segs)
	ls, err := f.st.MeetingLiveState(m.ID)
	require.NoError(t, err)
	require.Equal(t, int64(18000), ls.ThroughMs)

	var push proto.MeetingLivePush
	cp.mu.Lock()
	for _, e := range cp.envs {
		if e.Type == "meeting_live" {
			require.NoError(t, json.Unmarshal(e.Payload, &push))
		}
	}
	cp.mu.Unlock()
	require.Equal(t, m.ID, push.ID)
	require.Equal(t, []proto.MeetingSegment{{StartMs: 15500, EndMs: 18000, Text: "b"}}, push.Segments)
	require.Equal(t, int64(18000), push.Live.ThroughMs)
	require.Equal(t, 2, push.Live.Slices)
	require.Equal(t, int64(500), push.Live.Bytes)
	require.Equal(t, int64(77), push.Live.LastSliceAt)

	// the detail carries the live state
	d := f.do("GET", "/api/meetings/"+m.ID, "")
	require.Equal(t, 200, d.Code)
	var got proto.Meeting
	require.NoError(t, json.Unmarshal(d.Body.Bytes(), &got))
	require.NotNil(t, got.Live)
	require.Equal(t, int64(18000), got.Live.ThroughMs)
}

func TestChunkFailureKeepsMeetingLive(t *testing.T) {
	f := newJobFx(t)
	m := f.liveMeeting(t)
	gpu := f.connect(t, "gpu", true)
	cp := &capture{}
	f.s.hub.SetBroadcaster(cp)
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	p := gpu.start()
	code, body := postJSON(t, f.ts.URL, p.ResultURL, `{"error":"boom"}`)
	require.Equal(t, 200, code, body)
	j, err := f.st.MeetingJob(p.JobID)
	require.NoError(t, err)
	require.Equal(t, store.JobFailed, j.Status)

	// three silent attempts of the next chunk job
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	for i := 0; i < maxJobAttempts; i++ {
		q := gpu.start()
		gpu.progress(proto.MeetingProgress{JobID: q.JobID, Attempt: q.Attempt, Pct: 10, Stage: "transcribing"})
		f.s.checkMeetingJobs(time.Now().Add(jobSilence + 10*time.Second))
	}
	eventually(t, func() bool {
		q, _ := f.st.MeetingJobsWithStatus(store.JobFailed)
		return len(q) == 2
	})
	mm, err := f.st.Meeting(m.ID)
	require.NoError(t, err)
	require.Equal(t, "live", mm.Status)
	require.Equal(t, "", mm.Error)
	cp.mu.Lock()
	defer cp.mu.Unlock()
	for _, e := range cp.envs {
		if e.Type == "meeting_changed" {
			require.NotContains(t, string(e.Payload), "failed")
			require.NotContains(t, string(e.Payload), "transcribing")
		}
	}
}

func TestLiveHoldsOtherJobs(t *testing.T) {
	f := newJobFx(t)
	other := f.uploadMeeting(t, "", "other audio") // queued transcribe job, created first
	m := f.liveMeeting(t)
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	gpu := f.connect(t, "gpu", true)
	p := gpu.start()
	require.Equal(t, proto.MeetingStepTranscribeChunk, p.Step)
	require.Equal(t, m.ID, p.MeetingID)

	code, body := postJSON(t, f.ts.URL, p.ResultURL, chunkBody(1000))
	require.Equal(t, 200, code, body)
	f.s.dispatchMeetingJobs()
	gpu.noStart(200 * time.Millisecond)
	require.Equal(t, "queued", f.status(other.ID))

	require.NoError(t, f.st.EndLive(m.ID))
	f.s.kickJobs()
	q := gpu.start()
	require.Equal(t, other.ID, q.MeetingID)
	require.Equal(t, proto.MeetingStepTranscribe, q.Step)
}

func TestLiveChunkResultAfterStopDiscarded(t *testing.T) {
	f := newJobFx(t)
	m := f.liveMeeting(t)
	gpu := f.connect(t, "gpu", true)
	require.NoError(t, f.s.queueLiveChunk(m.ID))
	p := gpu.start()
	require.NoError(t, f.st.EndLive(m.ID))
	code, body := postJSON(t, f.ts.URL, p.ResultURL, chunkBody(9000, proto.MeetingWorkerSegment{StartMs: 100, EndMs: 9000, Text: "late"}))
	require.Contains(t, []int{200, 409}, code, body)
	segs, err := f.st.MeetingSegments(m.ID)
	require.NoError(t, err)
	require.Empty(t, segs)
}
