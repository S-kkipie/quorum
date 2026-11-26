package hub

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Live recording routes: a meeting is recorded by one MediaRecorder, so its slices form one continuous WebM
// stream. They arrive in any order, are held as <audioDir>/live/<id>/<seq>.part until every earlier one is
// there and are then appended to the meeting's audio file.
const (
	liveSliceMax = 2 << 20 // the largest slice
	liveMaxAhead = 64      // slices held beyond the next expected one
	liveSeqMax   = 100000  // seq is below this
	// liveIdleStop: a live meeting without a slice for this long is stopped by the hub.
	liveIdleStop = 10 * time.Minute
)

// liveLocks serializes the assembly and the stop of one meeting.
type liveLocks struct {
	mu  sync.Mutex
	ids map[string]*sync.Mutex
}

func (l *liveLocks) lock(id string) func() {
	l.mu.Lock()
	if l.ids == nil {
		l.ids = map[string]*sync.Mutex{}
	}
	m := l.ids[id]
	if m == nil {
		m = &sync.Mutex{}
		l.ids[id] = m
	}
	l.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func (s *Server) liveDir(id string) string { return filepath.Join(s.audioDir, "live", id) }

func livePart(dir string, seq int) string { return filepath.Join(dir, strconv.Itoa(seq)+".part") }

// handleLiveStart: POST /api/meetings/live {projectId?, title?, language?, startedAt?} → 201 with the meeting.
func (s *Server) handleLiveStart(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ProjectID string `json:"projectId"`
		Title     string `json:"title"`
		StartedAt int64  `json:"startedAt"`
		Language  string `json:"language"`
	}
	if !decode(w, r, &b) {
		return
	}
	title, ok := meetingTitle(b.Title)
	if !ok {
		apiErr(w, 400, "the title is too long")
		return
	}
	if !validMeetingLanguage(b.Language) {
		apiErr(w, 400, "invalid language")
		return
	}
	if b.StartedAt < 0 {
		apiErr(w, 400, "invalid start time")
		return
	}
	free, err := s.meetingDisk()
	if err != nil {
		log.Printf("hub: meetings: disk: %v", err)
		diskFullErr(w)
		return
	}
	if free < meetingMinFree {
		diskFullErr(w)
		return
	}
	m, err := s.st.CreateLiveMeeting(store.MeetingUpload{ProjectID: b.ProjectID, Title: title, Language: b.Language, StartedAt: b.StartedAt},
		func(id string) string { return filepath.Join(s.audioDir, id+".webm") })
	if errors.Is(err, store.ErrNoProject) {
		apiErr(w, 400, "no such project")
		return
	}
	if err != nil {
		log.Printf("hub: meetings: start live: %v", err)
		apiErr(w, 500, "internal error")
		return
	}
	// the row names the file before it exists, as an upload does
	path, _, _, _, _ := s.st.MeetingAudio(m.ID)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		err = f.Close()
	}
	if err != nil {
		log.Printf("hub: meetings: start live: %v", err)
		_, _ = s.st.DeleteMeeting(m.ID)
		_ = os.Remove(path)
		apiErr(w, 500, "internal error")
		return
	}
	if err := s.queueLiveChunk(m.ID); err != nil { // the warm-up: loads the model before the first slice
		log.Printf("hub: meetings: warm-up chunk of %s: %v", m.ID, err)
	}
	s.publishMeeting(m.ID, m.ProjectID, m.Status)
	writeJSON(w, 201, m)
}

// handleLiveSlice: PUT /api/meetings/{id}/live/{seq} with the slice as the body → 200 {nextSeq, bytes,
// duplicate?}.
func (s *Server) handleLiveSlice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	seq, err := strconv.Atoi(r.PathValue("seq"))
	if err != nil || seq < 0 || seq >= liveSeqMax {
		apiErr(w, 400, "invalid slice number")
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
	ls, err := s.st.MeetingLiveState(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 409, "the meeting is not recording")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if seq < ls.NextSeq { // stored before: its answer was lost
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, liveSliceMax+1))
		writeJSON(w, 200, map[string]any{"nextSeq": ls.NextSeq, "bytes": ls.Bytes, "duplicate": true})
		return
	}
	if seq >= ls.NextSeq+liveMaxAhead {
		apiErr(w, 409, "the slice is too far ahead")
		return
	}
	if r.ContentLength > liveSliceMax {
		apiErr(w, 413, "the slice is too large")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, liveSliceMax+1))
	if err != nil {
		apiErr(w, 400, "the slice was interrupted")
		return
	}
	if len(body) > liveSliceMax {
		apiErr(w, 413, "the slice is too large")
		return
	}
	if ls.Bytes+int64(len(body)) > meetingMaxSize {
		apiErr(w, 413, "the recording is larger than 400 MB")
		return
	}
	if free, err := s.meetingDisk(); err != nil || free < meetingMinFree {
		diskFullErr(w)
		return
	}
	dir := s.liveDir(id)
	if err := writePart(dir, seq, body); err != nil {
		log.Printf("hub: meetings: live part %s/%d: %v", id, seq, err)
		apiErr(w, 500, "internal error")
		return
	}
	unlock := s.liveLk.lock(id)
	ls, err = s.assembleLive(id)
	if err == nil {
		// under the meeting's lock, so a stop cannot slip in between the live check and the queueing
		if qerr := s.queueLiveChunk(id); qerr != nil {
			log.Printf("hub: meetings: chunk of %s: %v", id, qerr)
		}
	}
	unlock()
	if errors.Is(err, store.ErrNotFound) { // stopped or deleted meanwhile
		_ = os.RemoveAll(dir)
		apiErr(w, 409, "the meeting is not recording")
		return
	}
	if err != nil {
		log.Printf("hub: meetings: assemble %s: %v", id, err)
		apiErr(w, 500, "internal error")
		return
	}
	s.publishLive(id, m.ProjectID, nil)
	writeJSON(w, 200, map[string]any{"nextSeq": ls.NextSeq, "bytes": ls.Bytes})
}

// writePart stores a slice as a temp file renamed into place, so a part is never half written.
func writePart(dir string, seq int, body []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "tmp-*")
	if err != nil {
		return err
	}
	_, err = tmp.Write(body)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), livePart(dir, seq))
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// assembleLive appends the contiguous parts to the audio file (truncated first to the stored size, so a crash
// mid-append leaves nothing behind) and stores the progress. The caller holds the meeting's lock. It returns
// store.ErrNotFound when the meeting is not live.
func (s *Server) assembleLive(id string) (store.LiveState, error) {
	ls, err := s.st.MeetingLiveState(id)
	if err != nil {
		return ls, err
	}
	path, _, _, ok, err := s.st.MeetingAudio(id)
	if err != nil {
		return ls, err
	}
	if !ok {
		return ls, errors.New("the meeting has no audio file")
	}
	dir := s.liveDir(id)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return ls, err
	}
	defer f.Close()
	if err = f.Truncate(ls.Bytes); err != nil {
		return ls, err
	}
	if _, err = f.Seek(ls.Bytes, io.SeekStart); err != nil {
		return ls, err
	}
	next, total := ls.NextSeq, ls.Bytes
	var done []int
	for {
		b, rerr := os.ReadFile(livePart(dir, next))
		if errors.Is(rerr, os.ErrNotExist) {
			break
		}
		if rerr != nil {
			err = rerr
			break
		}
		if total+int64(len(b)) > meetingMaxSize {
			break
		}
		if _, err = f.Write(b); err != nil {
			break
		}
		total += int64(len(b))
		done = append(done, next)
		next++
	}
	if len(done) == 0 {
		return ls, err
	}
	if serr := f.Sync(); serr != nil && err == nil {
		err = serr
	}
	if err != nil { // the file is cut back to the stored size by the next assembly
		return ls, err
	}
	if err = s.st.AdvanceLive(id, next, total, s.hub.now().UnixMilli()); err != nil {
		return ls, err
	}
	for _, q := range done {
		_ = os.Remove(livePart(dir, q))
	}
	ls.NextSeq, ls.Bytes = next, total
	return ls, nil
}

// handleLiveStop: POST /api/meetings/{id}/live/stop {slices, force?} → 200 with the meeting, or 409 {error,
// missing} when a slice below slices has not arrived and force is not set. A meeting that is no longer live
// answers 200 with the meeting (a retried stop).
func (s *Server) handleLiveStop(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b struct {
		Slices int  `json:"slices"`
		Force  bool `json:"force"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Slices < 0 || b.Slices > liveSeqMax {
		apiErr(w, 400, "invalid slices")
		return
	}
	m, missing, err := s.stopLive(id, b.Slices, b.Force)
	switch {
	case errors.Is(err, store.ErrNotFound):
		apiErr(w, 404, "no such meeting")
	case errors.Is(err, errSlicesMissing):
		writeJSON(w, 409, map[string]any{"error": "some slices have not arrived", "missing": missing})
	case err != nil:
		log.Printf("hub: meetings: stop live %s: %v", id, err)
		apiErr(w, 500, "internal error")
	default:
		writeJSON(w, 200, m)
	}
}

var errSlicesMissing = errors.New("some slices have not arrived")

// stopLive ends a live recording: it appends what is contiguous, discards the parts after a gap, cancels the
// chunk jobs and hands the whole file to the full pipeline (or fails the meeting when nothing was recorded).
// With slices > 0 and force false, a slice below slices that has not arrived gives errSlicesMissing and the
// missing numbers; nothing changes. A meeting that is not live is returned as it is.
func (s *Server) stopLive(id string, slices int, force bool) (proto.Meeting, []int, error) {
	defer s.liveLk.lock(id)()
	ls, err := s.st.MeetingLiveState(id)
	if errors.Is(err, store.ErrNotFound) {
		m, merr := s.st.Meeting(id)
		if merr != nil || m.Status != "live" {
			return m, nil, merr
		}
		// the live state ended but queueing failed: finish the hand-off now, so a retried stop recovers
		_ = os.RemoveAll(s.liveDir(id))
		s.cancelMeetingJobs(id)
		m, err = s.queueMeeting(id)
		return m, nil, err
	}
	if err != nil {
		return proto.Meeting{}, nil, err
	}
	dir := s.liveDir(id)
	if !force {
		var missing []int
		for q := ls.NextSeq; q < slices; q++ {
			if _, serr := os.Stat(livePart(dir, q)); serr != nil {
				missing = append(missing, q)
			}
		}
		if len(missing) > 0 {
			return proto.Meeting{}, missing, errSlicesMissing
		}
	}
	if ls, err = s.assembleLive(id); err != nil {
		return proto.Meeting{}, nil, err
	}
	if es, _ := os.ReadDir(dir); len(es) > 0 {
		log.Printf("hub: meetings: stop %s: discarding %d slice(s) after a gap (next expected %d)", id, len(es), ls.NextSeq)
	}
	_ = os.RemoveAll(dir)
	// a failed chunk job never matters here: the full pipeline reads the whole file
	s.cancelMeetingJobs(id)
	if err := s.st.EndLive(id); err != nil {
		return proto.Meeting{}, nil, err
	}
	if ls.Bytes == 0 {
		if path, _, _, ok, _ := s.st.MeetingAudio(id); ok {
			_ = os.Remove(path)
		}
		if err := s.st.SetMeetingStatus(id, "failed", "Nothing was recorded.", 0); err != nil {
			return proto.Meeting{}, nil, err
		}
		m, err := s.st.Meeting(id)
		if err != nil {
			return m, nil, err
		}
		s.publishMeeting(m.ID, m.ProjectID, m.Status)
		return m, nil, nil
	}
	m, err := s.queueMeeting(id)
	return m, nil, err
}

// checkLiveMeetings stops, with force, the live meetings that got no slice for liveIdleStop (the tab closed or
// the phone locked): the full pipeline runs on what arrived.
func (s *Server) checkLiveMeetings(now time.Time) {
	live, err := s.st.LiveMeetings()
	if err != nil {
		log.Printf("hub: meetings: live meetings: %v", err)
		return
	}
	for _, ls := range live {
		last := ls.LastSliceAt
		if last == 0 {
			last = ls.CreatedAt
		}
		if now.Sub(time.UnixMilli(last)) <= liveIdleStop {
			continue
		}
		log.Printf("hub: meetings: auto-stop of %s: no slice for %s", ls.MeetingID, liveIdleStop)
		if _, _, err := s.stopLive(ls.MeetingID, 0, true); err != nil {
			log.Printf("hub: meetings: auto-stop of %s: %v", ls.MeetingID, err)
		}
	}
}
