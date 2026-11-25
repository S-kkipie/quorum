package hub

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/hub/store"
)

// Limits of a meeting upload (variables for tests).
var (
	// meetingMaxSize is the largest recording the hub accepts.
	meetingMaxSize int64 = 400 << 20
	// meetingChunkMax is the largest chunk of one PUT; the app sends 8 MB chunks.
	meetingChunkMax int64 = 8 << 20
	// meetingMinFree: new audio is refused when the hub disk would keep less than this free.
	meetingMinFree uint64 = 2 << 30
)

const (
	meetingChunkSize = 8 << 20 // what the hub tells clients to send
	meetingTitleMax  = 200
	meetingNameMax   = 1024
	meetingCopyBuf   = 64 << 10
	// meetingChannels is the channel layout of a two-channel Quorum recording.
	meetingChannels = "me|others"
)

// meetingFormats maps the accepted file extensions to their media type.
var meetingFormats = map[string]string{
	".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".opus": "audio/ogg", ".webm": "audio/webm", ".flac": "audio/flac",
}

// meetingMimes maps the accepted media types to the extension the file is stored with.
var meetingMimes = map[string]string{
	"audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/aac": ".m4a",
	"audio/mpeg": ".mp3", "audio/mp3": ".mp3",
	"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/vnd.wave": ".wav",
	"audio/ogg": ".ogg", "audio/opus": ".opus", "application/ogg": ".ogg",
	"audio/webm": ".webm", "video/webm": ".webm",
	"audio/flac": ".flac", "audio/x-flac": ".flac",
}

// meetingFormat returns the extension the recording is stored with and its media type, or ok false
// when neither the name's extension nor the mime is an accepted audio format.
func meetingFormat(name, mime string) (ext, mt string, ok bool) {
	e := strings.ToLower(filepath.Ext(name))
	if m, found := meetingFormats[e]; found {
		if _, known := meetingMimes[mime]; !known {
			mime = m // served with this type: a missing or odd mime never becomes text/html
		}
		return e, mime, true
	}
	if e, found := meetingMimes[mime]; found {
		return e, mime, true
	}
	return "", "", false
}

var meetingLangRe = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$|^auto$`)

// validMeetingLanguage: "" (the default), "auto" or a language code such as "es" or "pt-BR".
func validMeetingLanguage(l string) bool { return l == "" || meetingLangRe.MatchString(l) }

// meetingTitle trims the title; ok is false when it is too long.
func meetingTitle(t string) (string, bool) {
	t = strings.TrimSpace(t)
	return t, utf8.RuneCountInString(t) <= meetingTitleMax && !strings.ContainsRune(t, 0)
}

// uploadBusy marks the uploads a request is writing to, so two PUTs never write one file at once.
type uploadBusy struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (b *uploadBusy) take(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ids == nil {
		b.ids = map[string]bool{}
	}
	if b.ids[id] {
		return false
	}
	b.ids[id] = true
	return true
}

func (b *uploadBusy) done(id string) {
	b.mu.Lock()
	delete(b.ids, id)
	b.mu.Unlock()
}

func defaultAudioDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "audio"
	}
	return filepath.Join(home, ".local", "share", "quorum", "audio")
}

// meetingDisk makes sure the audio folder exists and returns the bytes free on its disk.
func (s *Server) meetingDisk() (uint64, error) {
	if err := os.MkdirAll(filepath.Join(s.audioDir, "uploads"), 0o700); err != nil {
		return 0, err
	}
	return s.diskFree(s.audioDir)
}

func diskFullErr(w http.ResponseWriter) {
	apiErr(w, http.StatusInsufficientStorage, "the hub disk is almost full; free some space or delete old meetings")
}

func uploadOffsetErr(w http.ResponseWriter, code int, msg string, offset int64) {
	writeJSON(w, code, map[string]any{"error": msg, "offset": offset})
}

// handleMeetingUploadBegin starts a resumable upload: POST /api/meetings/uploads {name, size, mime,
// projectId?, title?, startedAt?, language?, channels?} → 201 {uploadId, offset: 0, chunkSize}.
func (s *Server) handleMeetingUploadBegin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name      string `json:"name"`
		Size      int64  `json:"size"`
		Mime      string `json:"mime"`
		ProjectID string `json:"projectId"`
		Title     string `json:"title"`
		StartedAt int64  `json:"startedAt"`
		Language  string `json:"language"`
		Channels  string `json:"channels"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Size <= 0 {
		apiErr(w, 400, "invalid size")
		return
	}
	if b.Size > meetingMaxSize {
		apiErr(w, 413, "the recording is larger than 400 MB")
		return
	}
	if len(b.Name) > meetingNameMax || strings.ContainsRune(b.Name, 0) {
		apiErr(w, 400, "invalid file name")
		return
	}
	_, mime, ok := meetingFormat(b.Name, uploadMime(b.Mime))
	if !ok {
		apiErr(w, 415, "unsupported audio format; use m4a, mp3, wav, ogg, opus, webm or flac")
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
	if b.Channels != "" && b.Channels != meetingChannels {
		apiErr(w, 400, "invalid channels")
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
	if free < meetingMinFree+uint64(b.Size) {
		diskFullErr(w)
		return
	}
	u, err := s.st.CreateMeetingUpload(store.MeetingUpload{Size: b.Size, Name: b.Name, Mime: mime, Channels: b.Channels,
		ProjectID: b.ProjectID, Title: title, Language: b.Language, StartedAt: b.StartedAt})
	if errors.Is(err, store.ErrNoProject) {
		apiErr(w, 400, "no such project")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	part := filepath.Join(s.audioDir, "uploads", u.ID+".part")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		err = f.Close()
	}
	if err == nil {
		err = s.st.SetMeetingUploadPath(u.ID, part)
	}
	if err != nil {
		log.Printf("hub: meetings: start upload: %v", err)
		_ = os.Remove(part)
		_ = s.st.DeleteMeetingUpload(u.ID)
		apiErr(w, 500, "internal error")
		return
	}
	writeJSON(w, 201, map[string]any{"uploadId": u.ID, "offset": 0, "size": u.Size, "chunkSize": meetingChunkSize})
}

// handleMeetingUploadChunk streams PUT /api/meetings/uploads/{id}?offset=N to the upload's file at N.
// N must be the bytes the hub has (409 with the current offset otherwise). Nothing is buffered beyond
// a small copy buffer; the bytes that arrived before an interruption are kept, and the answer (also on
// failure) carries the offset to resume from.
func (s *Server) handleMeetingUploadChunk(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	off, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || off < 0 {
		apiErr(w, 400, "invalid offset")
		return
	}
	u, err := s.st.MeetingUploadByID(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such upload")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if !s.meetUploads.take(id) {
		uploadOffsetErr(w, 409, "another request is writing this upload", u.Offset)
		return
	}
	defer s.meetUploads.done(id)
	if u, err = s.st.MeetingUploadByID(id); err != nil { // re-read under the claim
		apiErr(w, 404, "no such upload")
		return
	}
	if u.Done {
		uploadOffsetErr(w, 409, "the upload is already complete", u.Offset)
		return
	}
	if off != u.Offset {
		uploadOffsetErr(w, 409, "offset mismatch", u.Offset)
		return
	}
	allowed := min(meetingChunkMax, u.Size-u.Offset)
	if r.ContentLength > allowed {
		uploadOffsetErr(w, 413, "the chunk is too large", u.Offset)
		return
	}
	if r.ContentLength != 0 {
		free, err := s.meetingDisk()
		if err != nil || free < meetingMinFree {
			diskFullErr(w)
			return
		}
	}
	f, err := os.OpenFile(u.Path, os.O_WRONLY, 0)
	if err == nil {
		// drop any bytes past the recorded offset (a crash mid-write), then append
		if err = f.Truncate(u.Offset); err == nil {
			_, err = f.Seek(u.Offset, io.SeekStart)
		}
	}
	if err != nil {
		if f != nil {
			f.Close()
		}
		log.Printf("hub: meetings: open upload: %v", err)
		apiErr(w, 500, "internal error")
		return
	}
	written, over, rerr, werr := copyChunk(w, f, r.Body, allowed)
	if serr := f.Sync(); serr != nil && werr == nil {
		werr = serr
	}
	if cerr := f.Close(); cerr != nil && werr == nil {
		werr = cerr
	}
	if werr != nil {
		// the bytes on disk are uncertain: keep the old offset (the next chunk truncates there)
		log.Printf("hub: meetings: write upload: %v", werr)
		uploadOffsetErr(w, 500, "the hub could not write the chunk", u.Offset)
		return
	}
	cur := u.Offset + written
	if err := s.st.SetMeetingUploadOffset(id, cur); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	switch {
	case over:
		uploadOffsetErr(w, 413, "the chunk is too large", cur)
	case rerr != nil:
		uploadOffsetErr(w, 400, "the upload was interrupted", cur)
	default:
		writeJSON(w, 200, map[string]any{"offset": cur})
	}
}

// copyChunk copies at most limit bytes of body to f with a per-read deadline. over is true when the body
// holds more than limit (the extra is not written); rerr is a read failure, werr a write failure.
func copyChunk(w http.ResponseWriter, f *os.File, body io.Reader, limit int64) (written int64, over bool, rerr, werr error) {
	buf := make([]byte, meetingCopyBuf)
	rc := http.NewResponseController(w)
	for {
		// a client that stops sending for a minute is gone (ErrNotSupported is fine)
		_ = rc.SetReadDeadline(time.Now().Add(uploadReadWait))
		n, err := body.Read(buf)
		if n > 0 {
			keep := int64(n)
			if written+keep > limit {
				keep, over = limit-written, true
			}
			if keep > 0 {
				if _, werr = f.Write(buf[:keep]); werr != nil {
					return written, over, nil, werr
				}
				written += keep
			}
			if over {
				return written, true, nil, nil
			}
		}
		if err == io.EOF {
			return written, false, nil, nil
		}
		if err != nil {
			return written, false, err, nil
		}
	}
}

// handleMeetingUploadComplete: POST /api/meetings/uploads/{id}/complete moves the file into the audio
// folder, creates the meeting (uploaded) and queues it → 201 with the meeting. A retry after success
// returns the same meeting.
func (s *Server) handleMeetingUploadComplete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.meetUploads.take(id) {
		u, _ := s.st.MeetingUploadByID(id)
		uploadOffsetErr(w, 409, "another request is writing this upload", u.Offset)
		return
	}
	defer s.meetUploads.done(id)
	u, err := s.st.MeetingUploadByID(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such upload")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if u.Done {
		m, err := s.st.Meeting(u.MeetingID)
		if err != nil {
			apiErr(w, 404, "no such meeting")
			return
		}
		writeJSON(w, 201, m)
		return
	}
	if u.Offset != u.Size {
		uploadOffsetErr(w, 409, "the upload is not complete", u.Offset)
		return
	}
	ext, _, _ := meetingFormat(u.Name, u.Mime)
	dest := filepath.Join(s.audioDir, u.MeetingID+ext)
	if err := os.Rename(u.Path, dest); err != nil {
		// a complete that failed after the move left the file in place already
		if _, serr := os.Stat(dest); serr != nil {
			log.Printf("hub: meetings: move upload: %v", err)
			apiErr(w, 500, "internal error")
			return
		}
	}
	m, err := s.st.CompleteMeetingUpload(id, dest)
	if err != nil {
		log.Printf("hub: meetings: complete upload: %v", err)
		apiErr(w, 500, "internal error")
		return
	}
	if m, err = s.queueMeeting(m.ID); err != nil {
		log.Printf("hub: meetings: queue %s: %v", m.ID, err)
		apiErr(w, 500, "internal error")
		return
	}
	writeJSON(w, 201, m)
}
