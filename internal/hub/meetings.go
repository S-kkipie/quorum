package hub

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// meetingAudioURLTTL is how long a playback link of a meeting's audio works.
const meetingAudioURLTTL = time.Hour

// meetingRoutes registers the meetings API (device auth) and the signed audio route (the token is the auth).
// There is no GET /api/meetings/uploads/{id}: it would clash with GET /api/meetings/{id}/audio-url in the
// mux; a client that lost track sends an empty PUT and reads the offset from the 409.
func (s *Server) meetingRoutes(dev func(string, http.HandlerFunc)) {
	dev("POST /api/meetings/uploads", s.handleMeetingUploadBegin)
	dev("PUT /api/meetings/uploads/{id}", s.handleMeetingUploadChunk)
	dev("POST /api/meetings/uploads/{id}/complete", s.handleMeetingUploadComplete)
	dev("GET /api/meetings", s.handleMeetings)
	dev("GET /api/meetings/disk", s.handleMeetingDisk)
	dev("GET /api/meetings/{id}", s.handleMeeting)
	dev("PATCH /api/meetings/{id}", s.handlePatchMeeting)
	dev("DELETE /api/meetings/{id}", s.handleDeleteMeeting)
	dev("GET /api/meetings/{id}/audio-url", s.handleMeetingAudioURL)
	dev("POST /api/meetings/{id}/retry", s.handleRetryMeeting)
	dev("POST /api/meetings/{id}/reprocess", s.handleReprocessMeeting)
	// POST, not PUT: PUT /api/meetings/{id}/speakers would clash with PUT /api/meetings/uploads/{id}
	dev("POST /api/meetings/{id}/speakers", s.handleMeetingSpeakers)
	dev("POST /api/meetings/{id}/actions/{actionId}/issue", s.handleMeetingActionIssue)
	dev("GET /api/settings/meetings", s.handleGetMeetingSettings)
	dev("PUT /api/settings/meetings", s.handlePutMeetingSettings)
	s.mux.HandleFunc("GET /api/meeting-audio/{token}", s.handleMeetingAudio)
	// the worker's per-job signed URLs (meetings_jobs.go): the token is the auth
	s.mux.HandleFunc("GET /api/meeting-jobs/{token}/audio", s.handleMeetingJobAudio)
	s.mux.HandleFunc("POST /api/meeting-jobs/{token}/result", s.handleMeetingJobResult)
	s.mux.HandleFunc("GET /api/meeting-jobs/{token}/transcript", s.handleMeetingJobTranscript)
}

// publishMeeting sends meeting_changed {id, projectId, status} to the devices.
func (s *Server) publishMeeting(id, projectID, status string) {
	p, _ := json.Marshal(map[string]string{"id": id, "projectId": projectID, "status": status})
	s.hub.publish(proto.Envelope{Type: "meeting_changed", Payload: p})
}

// queueMeeting moves an uploaded meeting to queued with a transcribe job, announces it and starts a
// dispatch.
func (s *Server) queueMeeting(id string) (proto.Meeting, error) {
	if act, err := s.st.ActiveMeetingJobs(id); err != nil {
		return proto.Meeting{}, err
	} else if len(act) == 0 {
		if _, err := s.st.CreateMeetingJob(id, proto.MeetingStepTranscribe, ""); err != nil {
			return proto.Meeting{}, err
		}
	}
	if err := s.st.SetMeetingStatus(id, "queued", "", 0); err != nil {
		return proto.Meeting{}, err
	}
	defer s.kickJobs()
	m, err := s.st.Meeting(id)
	if err != nil {
		return m, err
	}
	s.publishMeeting(m.ID, m.ProjectID, m.Status)
	return m, nil
}

// handleMeetings: GET /api/meetings?projectId=<id> (one project), ?unassigned=1 (the inbox) or all.
func (s *Server) handleMeetings(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ms, err := s.st.Meetings(store.MeetingFilter{ProjectID: q.Get("projectId"), Unassigned: q.Get("unassigned") == "1"})
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	writeJSON(w, 200, ms)
}

// handleMeeting: GET /api/meetings/{id} with its summary, segments (with the speaker names applied),
// actions and speakers.
func (s *Server) handleMeeting(w http.ResponseWriter, r *http.Request) {
	m, err := s.st.MeetingDetail(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such meeting")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	applySpeakerNames(&m)
	if m.Status == "live" {
		if ls, err := s.liveState(m.ID); err == nil {
			m.Live = &ls
		}
	}
	writeJSON(w, 200, m)
}

// maxMeetingSpeakers bounds the number of people a meeting can be given.
const maxMeetingSpeakers = 20

// handlePatchMeeting: PATCH /api/meetings/{id} {title?, projectId?, language?, speakers?}; projectId ""
// unassigns; speakers is the number of people (0 = unknown, up to 20), used by the next transcription.
func (s *Server) handlePatchMeeting(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Title     *string `json:"title"`
		ProjectID *string `json:"projectId"`
		Language  *string `json:"language"`
		Speakers  *int    `json:"speakers"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.Title != nil {
		t, ok := meetingTitle(*b.Title)
		if !ok {
			apiErr(w, 400, "the title is too long")
			return
		}
		b.Title = &t
	}
	if b.Language != nil && !validMeetingLanguage(*b.Language) {
		apiErr(w, 400, "invalid language")
		return
	}
	if b.Speakers != nil && (*b.Speakers < 0 || *b.Speakers > maxMeetingSpeakers) {
		apiErr(w, 400, "speakers must be between 0 (unknown) and 20")
		return
	}
	m, oldProject, err := s.st.PatchMeeting(r.PathValue("id"), store.MeetingPatch{Title: b.Title, ProjectID: b.ProjectID, Language: b.Language, Speakers: b.Speakers})
	switch {
	case errors.Is(err, store.ErrNotFound):
		apiErr(w, 404, "no such meeting")
		return
	case errors.Is(err, store.ErrNoProject):
		apiErr(w, 400, "no such project")
		return
	case err != nil:
		apiErr(w, 500, "internal error")
		return
	}
	s.publishMeeting(m.ID, m.ProjectID, m.Status)
	if oldProject != m.ProjectID {
		// the meeting's briefing projection moved with it; "mine" follows the new project's person
		s.hub.briefingChanged(oldProject)
		if err := s.projectMeeting(m.ID); err != nil {
			log.Printf("hub: meetings: projection of %s: %v", m.ID, err)
		}
		s.hub.briefingChanged(m.ProjectID)
	}
	writeJSON(w, 200, m)
}

// handleDeleteMeeting: DELETE /api/meetings/{id} removes the meeting, its audio file and its projection.
func (s *Server) handleDeleteMeeting(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.cancelMeetingJobs(id)    // stops a worker that is processing it
	s.forgetMeetingSummary(id) // and a hub-side summary
	gone, err := s.st.DeleteMeeting(id)
	if errors.Is(err, store.ErrNotFound) {
		apiErr(w, 404, "no such meeting")
		return
	}
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if gone.AudioPath != "" {
		if err := os.Remove(gone.AudioPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("hub: meetings: delete audio of %s: %v", id, err)
		}
	}
	s.publishMeeting(id, gone.ProjectID, "deleted")
	s.hub.briefingChanged(gone.ProjectID)
	w.WriteHeader(http.StatusNoContent)
}

// handleMeetingDisk: GET /api/meetings/disk → {audioBytes, freeBytes} for Settings.
func (s *Server) handleMeetingDisk(w http.ResponseWriter, r *http.Request) {
	used, err := s.st.MeetingAudioBytes()
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	free, err := s.meetingDisk()
	if err != nil {
		free = 0
	}
	writeJSON(w, 200, map[string]any{"audioBytes": used, "freeBytes": free})
}

// handleMeetingAudioURL: GET /api/meetings/{id}/audio-url → {url, expiresAt}, a playback link valid for
// an hour that needs no device token (an <audio> element sends none). url is relative to the hub.
func (s *Server) handleMeetingAudioURL(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, _, ok, err := s.st.MeetingAudio(id); err != nil {
		apiErr(w, 500, "internal error")
		return
	} else if !ok {
		apiErr(w, 404, "the meeting has no audio")
		return
	}
	tok, err := s.st.CreateMeetingToken("audio", id, "", meetingAudioURLTTL)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	writeJSON(w, 200, map[string]any{"url": "/api/meeting-audio/" + tok, "expiresAt": time.Now().Add(meetingAudioURLTTL).UnixMilli()})
}

// handleMeetingAudio: GET /api/meeting-audio/{token} streams the audio a signed token grants, with Range
// support for seeking. A bad or expired token gives 403; audio deleted since gives 404.
func (s *Server) handleMeetingAudio(w http.ResponseWriter, r *http.Request) {
	info, ok, err := s.st.MeetingToken("audio", r.PathValue("token"))
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if !ok {
		apiErr(w, 403, "this link expired; open the meeting again")
		return
	}
	s.serveMeetingAudio(w, r, info.MeetingID)
}

// serveMeetingAudio streams the meeting's audio file.
func (s *Server) serveMeetingAudio(w http.ResponseWriter, r *http.Request, id string) {
	path, mime, _, ok, err := s.st.MeetingAudio(id)
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if !ok {
		apiErr(w, 404, "the meeting has no audio")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		apiErr(w, 404, "the meeting has no audio")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// orphanAudioAge: an audio file no meeting or upload names is removed once it is this old.
const orphanAudioAge = 24 * time.Hour

// pruneMeetingFiles is the meetings part of the daily retention: the audio of meetings ready for more
// than 30 days (the transcript and summary stay), abandoned uploads, audio files no meeting names (a
// complete that moved the file but never committed its meeting) and expired signed tokens.
func pruneMeetingFiles(st *store.Store, audioDir string, now time.Time) {
	ms := now.UnixMilli()
	audio, err := st.ExpiredMeetingAudio(ms)
	if err != nil {
		log.Printf("hub: retention: meeting audio: %v", err)
	}
	for _, a := range audio {
		if err := os.Remove(a.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("hub: retention: meeting audio %s: %v", a.MeetingID, err)
			continue // kept in the store, so the next run tries again
		}
		if err := st.DropMeetingAudio(a.MeetingID); err != nil {
			log.Printf("hub: retention: meeting audio %s: %v", a.MeetingID, err)
		}
	}
	ups, err := st.ExpiredMeetingUploads(ms)
	if err != nil {
		log.Printf("hub: retention: meeting uploads: %v", err)
	}
	for _, u := range ups {
		// a done upload's path is its meeting's audio: only the marker goes
		if !u.Done && u.Path != "" {
			if err := os.Remove(u.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
				log.Printf("hub: retention: meeting upload %s: %v", u.ID, err)
				continue
			}
		}
		if err := st.DeleteMeetingUpload(u.ID); err != nil {
			log.Printf("hub: retention: meeting upload %s: %v", u.ID, err)
		}
	}
	pruneOrphanAudio(st, audioDir, now)
	if _, err := st.PruneMeetingTokens(ms); err != nil {
		log.Printf("hub: retention: meeting tokens: %v", err)
	}
}

// pruneOrphanAudio removes the audio files (<meeting id><ext> in audioDir) older than orphanAudioAge whose
// meeting does not exist and that no upload will create.
// meetingIDRe matches the store's ids (12 random bytes, hex): only such files are meeting audio.
var meetingIDRe = regexp.MustCompile(`^[0-9a-f]{24}$`)

func pruneOrphanAudio(st *store.Store, audioDir string, now time.Time) {
	if audioDir == "" {
		return
	}
	ents, err := os.ReadDir(audioDir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("hub: retention: meeting audio dir: %v", err)
		}
		return
	}
	for _, e := range ents {
		if !e.Type().IsRegular() {
			continue
		}
		name := e.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if _, ok := meetingFormats[ext]; !ok {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < orphanAudioAge {
			continue
		}
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		if !meetingIDRe.MatchString(stem) {
			continue // not a meeting's audio: never touch it
		}
		used, err := st.MeetingIDInUse(stem)
		if err != nil || used {
			continue
		}
		if err := os.Remove(filepath.Join(audioDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("hub: retention: orphan meeting audio %s: %v", name, err)
		}
	}
}
