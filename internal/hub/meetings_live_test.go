package hub

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func (f *meetFx) startLive(t *testing.T) proto.Meeting {
	t.Helper()
	rr := f.do("POST", "/api/meetings/live", `{"title":"Sync","language":"es"}`)
	require.Equal(t, 201, rr.Code, rr.Body.String())
	var m proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &m))
	return m
}

type sliceAnswer struct {
	NextSeq   int   `json:"nextSeq"`
	Bytes     int64 `json:"bytes"`
	Duplicate bool  `json:"duplicate"`
}

func (f *meetFx) slice(t *testing.T, id string, seq int, body string) sliceAnswer {
	t.Helper()
	rr := f.do("PUT", fmt.Sprintf("/api/meetings/%s/live/%d", id, seq), body)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	var a sliceAnswer
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &a))
	return a
}

func (f *meetFx) audioOf(t *testing.T, id string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.dir, id+".webm"))
	require.NoError(t, err)
	return string(b)
}

func (f *meetFx) partsOf(id string) []string {
	es, _ := os.ReadDir(filepath.Join(f.dir, "live", id))
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

func (f *meetFx) chunkJobs(t *testing.T, id string) int {
	t.Helper()
	n := 0
	for _, st := range []string{"queued", "running"} {
		js, err := f.st.MeetingJobsWithStatus(st)
		require.NoError(t, err)
		for _, j := range js {
			if j.MeetingID == id && j.Step == proto.MeetingStepTranscribeChunk {
				n++
			}
		}
	}
	return n
}

func TestLiveStartCreatesMeetingAndWarmup(t *testing.T) {
	f := newMeetFx(t)
	w, err := f.st.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := f.st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "Acme"})
	require.NoError(t, err)
	m := f.startLive(t)
	require.Equal(t, "live", m.Status)
	require.Equal(t, 1, f.chunkJobs(t, m.ID))
	rr := f.do("POST", "/api/meetings/live", fmt.Sprintf(`{"projectId":%q}`, p.ID))
	require.Equal(t, 201, rr.Code)
	require.Equal(t, 400, f.do("POST", "/api/meetings/live", `{"language":"!!"}`).Code)
	rr = f.do("POST", "/api/meetings/live", `{"projectId":"nope"}`)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "no such project")
	f.free = 1 << 30
	require.Equal(t, 507, f.do("POST", "/api/meetings/live", `{}`).Code)
}

func TestLiveSlicesAssembleOutOfOrder(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	require.Equal(t, 0, f.slice(t, m.ID, 1, "bb").NextSeq)
	require.Equal(t, 2, f.slice(t, m.ID, 0, "aa").NextSeq)
	a := f.slice(t, m.ID, 2, "cc")
	require.Equal(t, 3, a.NextSeq)
	require.Equal(t, int64(6), a.Bytes)
	require.Equal(t, "aabbcc", f.audioOf(t, m.ID))
	require.Empty(t, f.partsOf(m.ID))
	ls, err := f.s.liveState(m.ID)
	require.NoError(t, err)
	require.Equal(t, 3, ls.Slices)
}

func TestLiveDuplicateSliceIsNoop(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	require.False(t, f.slice(t, m.ID, 0, "aa").Duplicate)
	a := f.slice(t, m.ID, 0, "aa")
	require.True(t, a.Duplicate)
	require.Equal(t, 1, a.NextSeq)
	require.Equal(t, "aa", f.audioOf(t, m.ID))
	require.Equal(t, 1, f.slice(t, m.ID, 0, "zz").NextSeq)
	require.Equal(t, "aa", f.audioOf(t, m.ID))
}

func TestLiveSliceLimits(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	put := func(id, seq, body string) (int, string) {
		rr := f.do("PUT", "/api/meetings/"+id+"/live/"+seq, body)
		return rr.Code, rr.Body.String()
	}
	c, _ := put(m.ID, "0", strings.Repeat("x", 2<<20+1))
	require.Equal(t, 413, c)
	for _, s := range []string{"x", "-1", "100000"} {
		c, b := put(m.ID, s, "a")
		require.Equal(t, 400, c, s)
		require.Contains(t, b, "invalid slice number")
	}
	c, b := put(m.ID, "64", "a")
	require.Equal(t, 409, c)
	require.Contains(t, b, "too far ahead")
	c, _ = put(m.ID, "63", "a")
	require.Equal(t, 200, c)
	c, _ = put("nope", "0", "a")
	require.Equal(t, 404, c)
	old := meetingMaxSize
	meetingMaxSize = 3
	defer func() { meetingMaxSize = old }()
	c, b = put(m.ID, "0", "abcd")
	require.Equal(t, 413, c)
	require.Contains(t, b, "400 MB")
	meetingMaxSize = old
	f.free = 1 << 30
	c, _ = put(m.ID, "0", "a")
	require.Equal(t, 507, c)
	f.free = 100 << 30
	require.Equal(t, 200, f.do("POST", "/api/meetings/"+m.ID+"/live/stop", `{"slices":0,"force":true}`).Code)
	c, b = put(m.ID, "0", "a")
	require.Equal(t, 409, c)
	require.Contains(t, b, "the meeting is not recording")
}

func TestLiveStopQueuesFullPipeline(t *testing.T) {
	f := newJobFx(t)
	m := f.startLive(t)
	for i, b := range []string{"a", "b", "c"} {
		f.slice(t, m.ID, i, b)
	}
	require.NoError(t, f.st.AppendMeetingSegments(m.ID, []proto.MeetingSegment{{StartMs: 0, EndMs: 10, Text: "live"}}))
	rr := f.do("POST", "/api/meetings/"+m.ID+"/live/stop", `{"slices":3}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	var out proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out))
	require.Equal(t, "queued", out.Status)
	require.Equal(t, "queued", f.status(m.ID))
	require.Equal(t, 0, f.chunkJobs(t, m.ID))
	act, err := f.st.ActiveMeetingJobs(m.ID)
	require.NoError(t, err)
	require.Len(t, act, 1)
	require.Equal(t, proto.MeetingStepTranscribe, act[0].Step)
	_, err = os.Stat(filepath.Join(f.dir, "live", m.ID))
	require.True(t, os.IsNotExist(err))

	gpu := f.connect(t, "gpu", true)
	p := gpu.start()
	require.Equal(t, proto.MeetingStepTranscribe, p.Step)
	code, body := postJSON(t, f.ts.URL, p.ResultURL, transcriptBody)
	require.Equal(t, 200, code, body)
	segs, err := f.st.MeetingSegments(m.ID)
	require.NoError(t, err)
	require.Len(t, segs, 2)
	require.Equal(t, "first", segs[0].Text)
}

func TestLiveStopMissingSlices(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	f.slice(t, m.ID, 0, "aa")
	f.slice(t, m.ID, 2, "cc")
	rr := f.do("POST", "/api/meetings/"+m.ID+"/live/stop", `{"slices":3}`)
	require.Equal(t, 409, rr.Code)
	var e struct {
		Error   string `json:"error"`
		Missing []int  `json:"missing"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &e))
	require.Equal(t, "some slices have not arrived", e.Error)
	require.Equal(t, []int{1}, e.Missing)
	require.Equal(t, "live", f.status(m.ID))
	rr = f.do("POST", "/api/meetings/"+m.ID+"/live/stop", `{"slices":3,"force":true}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Equal(t, "aa", f.audioOf(t, m.ID))
	require.Equal(t, "queued", f.status(m.ID))
	require.Empty(t, f.partsOf(m.ID))
}

func TestLiveStopEmptyFails(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	rr := f.do("POST", "/api/meetings/"+m.ID+"/live/stop", `{"slices":0}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	got, err := f.st.Meeting(m.ID)
	require.NoError(t, err)
	require.Equal(t, "failed", got.Status)
	require.Equal(t, "Nothing was recorded.", got.Error)
	_, err = os.Stat(filepath.Join(f.dir, m.ID+".webm"))
	require.True(t, os.IsNotExist(err))
	require.Equal(t, 0, f.chunkJobs(t, m.ID))
}

func TestLiveAutoStopAfterTenMinutes(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	base := time.Now()
	f.s.hub.now = func() time.Time { return base }
	f.slice(t, m.ID, 0, "aa")
	f.s.checkLiveMeetings(base.Add(9*time.Minute + 59*time.Second))
	require.Equal(t, "live", f.status(m.ID))
	f.s.checkLiveMeetings(base.Add(10*time.Minute + time.Second))
	require.Equal(t, "queued", f.status(m.ID))
	rr := f.do("POST", "/api/meetings/"+m.ID+"/live/stop", `{"slices":1}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	var out proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out))
	require.Equal(t, m.ID, out.ID)
}

func TestLiveAutoStopWithoutSlices(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	f.s.checkLiveMeetings(time.Now().Add(11 * time.Minute))
	require.Equal(t, "failed", f.status(m.ID))
}

func TestLiveDeleteRemovesParts(t *testing.T) {
	f := newMeetFx(t)
	m := f.startLive(t)
	f.slice(t, m.ID, 1, "bb")
	require.Equal(t, []string{"1.part"}, f.partsOf(m.ID))
	require.Equal(t, 204, f.do("DELETE", "/api/meetings/"+m.ID, "").Code)
	_, err := os.Stat(filepath.Join(f.dir, "live", m.ID))
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(filepath.Join(f.dir, m.ID+".webm"))
	require.True(t, os.IsNotExist(err))
}

func (f *meetFx) status(id string) string {
	m, err := f.st.Meeting(id)
	if err != nil {
		return "error: " + err.Error()
	}
	return m.Status
}
