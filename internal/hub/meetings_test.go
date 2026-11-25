package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

type meetFx struct {
	s    *Server
	st   *store.Store
	h    http.Handler
	auth map[string]string
	dir  string
	free uint64
}

func newMeetFx(t *testing.T) *meetFx {
	t.Helper()
	s, st, h := newTestServer(t)
	tok, err := NewToken()
	require.NoError(t, err)
	require.NoError(t, st.AddToken("device", "tel", tok))
	f := &meetFx{s: s, st: st, h: h, auth: map[string]string{"Authorization": "Bearer " + tok}, dir: t.TempDir(), free: 100 << 30}
	s.audioDir = f.dir
	s.diskFree = func(string) (uint64, error) { return f.free, nil }
	return f
}

func (f *meetFx) do(method, path, body string) *httptest.ResponseRecorder {
	return do(f.h, method, path, body, f.auth)
}

func (f *meetFx) begin(t *testing.T, body string) string {
	t.Helper()
	rr := f.do("POST", "/api/meetings/uploads", body)
	require.Equal(t, 201, rr.Code, rr.Body.String())
	var out struct {
		UploadID  string `json:"uploadId"`
		Offset    int64  `json:"offset"`
		ChunkSize int64  `json:"chunkSize"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out))
	require.NotEmpty(t, out.UploadID)
	require.Equal(t, int64(0), out.Offset)
	require.Equal(t, int64(8<<20), out.ChunkSize)
	return out.UploadID
}

func (f *meetFx) put(id string, off int, data string) *httptest.ResponseRecorder {
	return f.do("PUT", fmt.Sprintf("/api/meetings/uploads/%s?offset=%d", id, off), data)
}

func offsetOf(t *testing.T, rr *httptest.ResponseRecorder) int64 {
	t.Helper()
	var out struct {
		Offset *int64 `json:"offset"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out), rr.Body.String())
	require.NotNil(t, out.Offset, rr.Body.String())
	return *out.Offset
}

// uploadMeeting runs a whole upload of data and returns the queued meeting.
func (f *meetFx) uploadMeeting(t *testing.T, projectID, data string) proto.Meeting {
	t.Helper()
	id := f.begin(t, fmt.Sprintf(`{"name":"standup.ogg","size":%d,"mime":"audio/ogg","projectId":%q,"title":"Standup"}`, len(data), projectID))
	require.Equal(t, 200, f.put(id, 0, data).Code)
	rr := f.do("POST", "/api/meetings/uploads/"+id+"/complete", "")
	require.Equal(t, 201, rr.Code, rr.Body.String())
	var m proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &m))
	return m
}

func TestMeetingUploadChunksAndResume(t *testing.T) {
	f := newMeetFx(t)
	id := f.begin(t, `{"name":"call.m4a","size":10,"mime":"audio/mp4","title":"Call"}`)
	rr := f.put(id, 0, "hello")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Equal(t, int64(5), offsetOf(t, rr))
	// a chunk sent again (the response was lost) or one that skips ahead: 409 with the current offset
	rr = f.put(id, 0, "hello")
	require.Equal(t, 409, rr.Code)
	require.Equal(t, int64(5), offsetOf(t, rr))
	rr = f.put(id, 7, "ld")
	require.Equal(t, 409, rr.Code)
	require.Equal(t, int64(5), offsetOf(t, rr))
	// a client that lost track probes with an empty chunk
	rr = f.put(id, 0, "")
	require.Equal(t, 409, rr.Code)
	require.Equal(t, int64(5), offsetOf(t, rr))
	// complete before the last byte: 409 with the offset
	rr = f.do("POST", "/api/meetings/uploads/"+id+"/complete", "")
	require.Equal(t, 409, rr.Code)
	require.Equal(t, int64(5), offsetOf(t, rr))
	// past the declared size: 413, nothing written
	rr = f.put(id, 5, "world!")
	require.Equal(t, 413, rr.Code)
	rr = f.put(id, 5, "world")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Equal(t, int64(10), offsetOf(t, rr))
	rr = f.do("POST", "/api/meetings/uploads/"+id+"/complete", "")
	require.Equal(t, 201, rr.Code, rr.Body.String())
	var m proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &m))
	require.Equal(t, "queued", m.Status)
	require.Equal(t, "Call", m.Title)
	require.True(t, m.HasAudio)
	path, mime, size, ok, err := f.st.MeetingAudio(m.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "audio/mp4", mime)
	require.Equal(t, int64(10), size)
	require.Equal(t, filepath.Join(f.dir, m.ID+".m4a"), path)
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, "helloworld", string(b))
	_, err = os.Stat(filepath.Join(f.dir, "uploads", id+".part"))
	require.True(t, errors.Is(err, os.ErrNotExist), "the partial file was moved")
	// a retried complete returns the same meeting; more chunks are refused
	rr = f.do("POST", "/api/meetings/uploads/"+id+"/complete", "")
	require.Equal(t, 201, rr.Code)
	require.Contains(t, rr.Body.String(), m.ID)
	require.Equal(t, 409, f.put(id, 10, "x").Code)
	require.Equal(t, 404, f.put("nope", 0, "x").Code)
	require.Equal(t, 400, f.do("PUT", "/api/meetings/uploads/"+id+"?offset=abc", "x").Code)
}

func TestMeetingUploadInterruptedKeepsReceivedBytes(t *testing.T) {
	f := newMeetFx(t)
	id := f.begin(t, `{"name":"a.wav","size":8,"mime":"audio/wav"}`)
	// the network drops after 3 bytes of a 6-byte chunk
	req := httptest.NewRequest("PUT", "/api/meetings/uploads/"+id+"?offset=0", io.MultiReader(strings.NewReader("abc"), errReader{}))
	req.Header.Set("Authorization", f.auth["Authorization"])
	rr := httptest.NewRecorder()
	f.h.ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Equal(t, int64(3), offsetOf(t, rr))
	// resume from there
	require.Equal(t, 409, f.put(id, 0, "abcdefgh").Code)
	rr = f.put(id, 3, "defgh")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	rr = f.do("POST", "/api/meetings/uploads/"+id+"/complete", "")
	require.Equal(t, 201, rr.Code)
	var m proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &m))
	p, _, _, _, _ := f.st.MeetingAudio(m.ID)
	b, _ := os.ReadFile(p)
	require.Equal(t, "abcdefgh", string(b))
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func TestMeetingUploadLimits(t *testing.T) {
	f := newMeetFx(t)
	rr := f.do("POST", "/api/meetings/uploads", fmt.Sprintf(`{"name":"big.mp3","size":%d}`, int64(400<<20)+1))
	require.Equal(t, 413, rr.Code, rr.Body.String())
	rr = f.do("POST", "/api/meetings/uploads", `{"name":"ok.mp3","size":0}`)
	require.Equal(t, 400, rr.Code)
	rr = f.do("POST", "/api/meetings/uploads", `{"name":"notes.txt","size":10,"mime":"text/plain"}`)
	require.Equal(t, 415, rr.Code)
	rr = f.do("POST", "/api/meetings/uploads", `{"name":"a.ogg","size":10,"projectId":"nope"}`)
	require.Equal(t, 400, rr.Code)
	rr = f.do("POST", "/api/meetings/uploads", `{"name":"a.ogg","size":10,"channels":"left|right"}`)
	require.Equal(t, 400, rr.Code)
	rr = f.do("POST", "/api/meetings/uploads", `{"name":"a.ogg","size":10,"language":"es; DROP"}`)
	require.Equal(t, 400, rr.Code)
	// exactly 400 MB is allowed
	f.begin(t, fmt.Sprintf(`{"name":"max.opus","size":%d}`, int64(400<<20)))
	// a chunk over 8 MB is refused before reading it
	id := f.begin(t, fmt.Sprintf(`{"name":"max.flac","size":%d}`, int64(100<<20)))
	req := httptest.NewRequest("PUT", "/api/meetings/uploads/"+id+"?offset=0", strings.NewReader(""))
	req.ContentLength = 8<<20 + 1
	req.Header.Set("Authorization", f.auth["Authorization"])
	rr = httptest.NewRecorder()
	f.h.ServeHTTP(rr, req)
	require.Equal(t, 413, rr.Code)
	// a chunk without a Content-Length that streams past 8 MB is cut there
	rr = f.do("PUT", "/api/meetings/uploads/"+id+"?offset=0", "")
	require.Equal(t, 200, rr.Code)
	req = httptest.NewRequest("PUT", "/api/meetings/uploads/"+id+"?offset=0", io.LimitReader(zeros{}, 9<<20))
	req.ContentLength = -1
	req.Header.Set("Authorization", f.auth["Authorization"])
	rr = httptest.NewRecorder()
	f.h.ServeHTTP(rr, req)
	require.Equal(t, 413, rr.Code)
	u, err := f.st.MeetingUploadByID(id)
	require.NoError(t, err)
	require.Equal(t, int64(8<<20), u.Offset, "the first 8 MB are kept")
}

func TestMeetingUploadDiskFull(t *testing.T) {
	f := newMeetFx(t)
	f.free = 2<<30 - 1
	rr := f.do("POST", "/api/meetings/uploads", `{"name":"a.ogg","size":10}`)
	require.Equal(t, 507, rr.Code, rr.Body.String())
	// 2 GB free is not enough for a file on top of the reserve
	f.free = 2 << 30
	rr = f.do("POST", "/api/meetings/uploads", `{"name":"a.ogg","size":10}`)
	require.Equal(t, 507, rr.Code)
	f.free = 3 << 30
	id := f.begin(t, `{"name":"a.ogg","size":10}`)
	// the disk filled up meanwhile: chunks are refused
	f.free = 1 << 30
	rr = f.put(id, 0, "12345")
	require.Equal(t, 507, rr.Code)
	f.free = 3 << 30
	require.Equal(t, 200, f.put(id, 0, "12345").Code)
	f.s.diskFree = func(string) (uint64, error) { return 0, errors.New("statfs failed") }
	require.Equal(t, 507, f.do("POST", "/api/meetings/uploads", `{"name":"a.ogg","size":10}`).Code)
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestMeetingUploadBoundedMemory(t *testing.T) {
	f := newMeetFx(t)
	const size = 50 << 20
	old := meetingChunkMax
	meetingChunkMax = 64 << 20
	t.Cleanup(func() { meetingChunkMax = old })
	id := f.begin(t, fmt.Sprintf(`{"name":"long.webm","size":%d}`, size))
	req := httptest.NewRequest("PUT", "/api/meetings/uploads/"+id+"?offset=0", io.LimitReader(zeros{}, size))
	req.Header.Set("Authorization", f.auth["Authorization"])
	rr := httptest.NewRecorder()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	f.h.ServeHTTP(rr, req)
	runtime.ReadMemStats(&after)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Equal(t, int64(size), offsetOf(t, rr))
	require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(4<<20), "the chunk is streamed, not buffered")
	st, err := os.Stat(filepath.Join(f.dir, "uploads", id+".part"))
	require.NoError(t, err)
	require.Equal(t, int64(size), st.Size())
}

func TestMeetingCRUD(t *testing.T) {
	f := newMeetFx(t)
	w, err := f.st.CreateWorkspace(proto.Workspace{Name: "w"})
	require.NoError(t, err)
	p, err := f.st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "p"})
	require.NoError(t, err)
	p2, err := f.st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "p2"})
	require.NoError(t, err)
	m := f.uploadMeeting(t, p.ID, "abc")
	require.Equal(t, p.ID, m.ProjectID)
	loose := f.uploadMeeting(t, "", "def")

	rr := f.do("GET", "/api/meetings?projectId="+p.ID, "")
	require.Equal(t, 200, rr.Code)
	var ms []proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &ms))
	require.Len(t, ms, 1)
	require.Equal(t, m.ID, ms[0].ID)
	rr = f.do("GET", "/api/meetings?unassigned=1", "")
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &ms))
	require.Len(t, ms, 1)
	require.Equal(t, loose.ID, ms[0].ID)
	rr = f.do("GET", "/api/meetings", "")
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &ms))
	require.Len(t, ms, 2)

	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, []proto.MeetingSegment{{StartMs: 0, EndMs: 1000, Speaker: "Speaker 1", Text: "hola"}}))
	rr = f.do("GET", "/api/meetings/"+m.ID, "")
	require.Equal(t, 200, rr.Code)
	var d proto.Meeting
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &d))
	require.Len(t, d.Segments, 1)
	require.Equal(t, 404, f.do("GET", "/api/meetings/nope", "").Code)

	rr = f.do("PATCH", "/api/meetings/"+m.ID, `{"title":"  Planning  ","language":"en","projectId":"`+p2.ID+`"}`)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &d))
	require.Equal(t, "Planning", d.Title)
	require.Equal(t, "en", d.Language)
	require.Equal(t, p2.ID, d.ProjectID)
	require.Equal(t, 400, f.do("PATCH", "/api/meetings/"+m.ID, `{"projectId":"nope"}`).Code)
	require.Equal(t, 400, f.do("PATCH", "/api/meetings/"+m.ID, `{"language":"x y"}`).Code)
	require.Equal(t, 400, f.do("PATCH", "/api/meetings/"+m.ID, `{"title":"`+strings.Repeat("a", 201)+`"}`).Code)
	require.Equal(t, 404, f.do("PATCH", "/api/meetings/nope", `{"title":"x"}`).Code)
	rr = f.do("PATCH", "/api/meetings/"+m.ID, `{"projectId":""}`)
	require.Equal(t, 200, rr.Code)
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &d))
	require.Equal(t, "", d.ProjectID)

	path, _, _, _, _ := f.st.MeetingAudio(m.ID)
	rr = f.do("DELETE", "/api/meetings/"+m.ID, "")
	require.Equal(t, 204, rr.Code, rr.Body.String())
	_, err = os.Stat(path)
	require.True(t, errors.Is(err, os.ErrNotExist), "the audio file is deleted")
	require.Equal(t, 404, f.do("GET", "/api/meetings/"+m.ID, "").Code)
	require.Equal(t, 404, f.do("DELETE", "/api/meetings/"+m.ID, "").Code)

	rr = f.do("GET", "/api/meetings/disk", "")
	require.Equal(t, 200, rr.Code)
	require.JSONEq(t, fmt.Sprintf(`{"audioBytes":3,"freeBytes":%d}`, f.free), rr.Body.String())

	require.Equal(t, 401, do(f.h, "GET", "/api/meetings", "", nil).Code)
	require.Equal(t, 401, do(f.h, "POST", "/api/meetings/uploads", `{}`, nil).Code)
}

func TestMeetingAudioSignedURL(t *testing.T) {
	f := newMeetFx(t)
	m := f.uploadMeeting(t, "", "0123456789")
	rr := f.do("GET", "/api/meetings/"+m.ID+"/audio-url", "")
	require.Equal(t, 200, rr.Code, rr.Body.String())
	var out struct {
		URL       string `json:"url"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out))
	require.True(t, strings.HasPrefix(out.URL, "/api/meeting-audio/"), out.URL)
	require.InDelta(t, time.Now().Add(time.Hour).UnixMilli(), out.ExpiresAt, 5000)

	// no device token needed; Range works for seeking
	rr = do(f.h, "GET", out.URL, "", nil)
	require.Equal(t, 200, rr.Code)
	require.Equal(t, "0123456789", rr.Body.String())
	require.Equal(t, "audio/ogg", rr.Header().Get("Content-Type"))
	rr = do(f.h, "GET", out.URL, "", map[string]string{"Range": "bytes=4-6"})
	require.Equal(t, 206, rr.Code)
	require.Equal(t, "456", rr.Body.String())
	require.Equal(t, 403, do(f.h, "GET", out.URL+"x", "", nil).Code)
	require.Equal(t, 403, do(f.h, "GET", "/api/meeting-audio/garbage", "", nil).Code)

	// the link expires after an hour
	f.st.SetClockForTest(func() time.Time { return time.Now().Add(time.Hour + time.Minute) })
	require.Equal(t, 403, do(f.h, "GET", out.URL, "", nil).Code)
	f.st.SetClockForTest(time.Now)

	// once the audio is gone there is no link
	require.NoError(t, f.st.DropMeetingAudio(m.ID))
	require.Equal(t, 404, f.do("GET", "/api/meetings/"+m.ID+"/audio-url", "").Code)
	require.Equal(t, 404, f.do("GET", "/api/meetings/nope/audio-url", "").Code)
}

func TestMeetingRetention(t *testing.T) {
	f := newMeetFx(t)
	m := f.uploadMeeting(t, "", "abc")
	require.NoError(t, f.st.ReplaceMeetingSegments(m.ID, []proto.MeetingSegment{{Text: "kept"}}))
	require.NoError(t, f.st.SetMeetingSummary(m.ID, proto.MeetingSummary{Summary: "kept too"}))
	path, _, _, _, _ := f.st.MeetingAudio(m.ID)
	// a queued meeting never loses its audio
	pruneMeetingFiles(f.st, time.Now().Add(365*24*time.Hour))
	_, err := os.Stat(path)
	require.NoError(t, err)
	require.NoError(t, f.st.SetMeetingStatus(m.ID, "ready", "", 100))
	pruneMeetingFiles(f.st, time.Now().Add(29*24*time.Hour))
	_, err = os.Stat(path)
	require.NoError(t, err, "kept for 30 days")
	pruneMeetingFiles(f.st, time.Now().Add(31*24*time.Hour))
	_, err = os.Stat(path)
	require.True(t, errors.Is(err, os.ErrNotExist), "deleted after 30 days")
	d, err := f.st.MeetingDetail(m.ID)
	require.NoError(t, err)
	require.False(t, d.HasAudio)
	require.Len(t, d.Segments, 1)
	require.Equal(t, "kept too", d.Summary.Summary)

	// an abandoned upload loses its partial file a day after its last chunk
	id := f.begin(t, `{"name":"a.ogg","size":10}`)
	require.Equal(t, 200, f.put(id, 0, "12").Code)
	part := filepath.Join(f.dir, "uploads", id+".part")
	pruneMeetingFiles(f.st, time.Now().Add(time.Hour))
	_, err = os.Stat(part)
	require.NoError(t, err)
	pruneMeetingFiles(f.st, time.Now().Add(25*time.Hour))
	_, err = os.Stat(part)
	require.True(t, errors.Is(err, os.ErrNotExist))
	require.Equal(t, 404, f.put(id, 2, "34").Code)
}
