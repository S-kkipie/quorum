package hub

import (
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Live meetings: while a meeting records, each new slice queues a transcribe_chunk job (at most one queued
// per meeting, however many slices arrive while no machine is free). The job's settings are computed when it
// is handed to a machine, so a machine that was off catches up in one job. Chunk jobs never change the
// meeting's status: a failed chunk is retried from the same point by the next one.
const (
	// liveContext is the audio before FromMs that is decoded again, for context.
	liveContext = 2000
	// liveWaitAfter: a live meeting is waiting when its oldest queued chunk job is older than this.
	liveWaitAfter = 30 * time.Second
)

// queueLiveChunk queues a chunk job of the live meeting unless one is already queued.
func (s *Server) queueLiveChunk(meetingID string) error {
	s.jobs.liveMu.Lock()
	defer s.jobs.liveMu.Unlock()
	if len(s.queuedChunks(meetingID)) > 0 {
		return nil
	}
	if _, err := s.enqueueMeetingJob(meetingID, proto.MeetingStepTranscribeChunk, ""); err != nil {
		return err
	}
	return nil
}

// queuedChunks lists the meeting's queued chunk jobs, oldest first.
func (s *Server) queuedChunks(meetingID string) []store.MeetingJob {
	q, err := s.st.MeetingJobsWithStatus(store.JobQueued)
	if err != nil {
		log.Printf("hub: meetings: queued jobs: %v", err)
		return nil
	}
	var out []store.MeetingJob
	for _, j := range q {
		if j.MeetingID == meetingID && j.Step == proto.MeetingStepTranscribeChunk {
			out = append(out, j)
		}
	}
	return out
}

// chunkSettings builds a chunk job's settings from the meeting's state now.
func chunkSettings(s *Server, _ store.MeetingJob, m proto.Meeting) (string, error) {
	ls, err := s.st.MeetingLiveState(m.ID)
	if errors.Is(err, store.ErrNotFound) {
		return "", errors.New("the meeting is no longer recording")
	}
	if err != nil {
		return "", err
	}
	lang := m.Language
	if lang == "" {
		lang = s.defaultMeetingLanguage()
	}
	prompt := ""
	if m.ProjectID != "" {
		if p, err := s.st.GetProject(m.ProjectID); err == nil {
			prompt = whisperPrompt(glossaryTerms(p.Glossary))
		}
	}
	b, err := json.Marshal(proto.MeetingChunkSettings{Language: lang, Model: defaultWhisperModel, Prompt: prompt,
		FromMs: ls.ThroughMs, ContextMs: liveContext, LiveBytes: ls.Bytes})
	return string(b), err
}

type chunkResult struct {
	segs    []proto.MeetingSegment
	through int64
}

// parseChunk checks a chunk result: empty segments are dropped, the rest sorted by start.
func parseChunk(raw json.RawMessage) (any, error) {
	var r proto.MeetingChunkResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, errors.New("the chunk result is not valid JSON")
	}
	if len(r.Segments) > maxSegments {
		return nil, errors.New("the chunk has too many segments")
	}
	t, err := parseTranscript(mustMarshal(proto.MeetingTranscript{Segments: r.Segments}))
	if err != nil {
		return nil, err
	}
	segs := t.(transcript).segs
	for i := range segs {
		segs[i].Speaker = ""
	}
	return chunkResult{segs: segs, through: max(r.ThroughMs, 0)}, nil
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// applyChunk stores the new segments of a chunk result and pushes them to the apps. The result of a meeting
// that stopped recording is discarded (the full transcription replaces the live one).
func applyChunk(s *Server, j store.MeetingJob, v any) error {
	r := v.(chunkResult)
	fresh, err := s.st.ApplyLiveChunk(j.MeetingID, r.segs, r.through)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	m, err := s.st.Meeting(j.MeetingID)
	if err != nil {
		return nil // the segments are stored; only the push is lost
	}
	s.publishLive(j.MeetingID, m.ProjectID, fresh)
	return nil
}

// liveState is the live state of a recording meeting for the apps, with whether its transcription waits.
func (s *Server) liveState(id string) (proto.MeetingLiveState, error) {
	ls, err := s.st.MeetingLiveState(id)
	if err != nil {
		return proto.MeetingLiveState{}, err
	}
	return proto.MeetingLiveState{Slices: ls.NextSeq, Bytes: ls.Bytes, ThroughMs: ls.ThroughMs, LastSliceAt: ls.LastSliceAt,
		Waiting: s.liveWaiting(id)}, nil
}

// liveWaiting: no connected machine can transcribe, or the oldest queued chunk job waited over liveWaitAfter.
func (s *Server) liveWaiting(id string) bool {
	ms, err := s.st.ListMachines()
	if err != nil {
		return false
	}
	capable := false
	for _, m := range ms {
		capable = capable || (m.Online && m.Caps.Transcribe && s.hub.Connected(m.Name))
	}
	if !capable {
		return true
	}
	q := s.queuedChunks(id)
	return len(q) > 0 && s.hub.now().Sub(time.UnixMilli(q[0].CreatedAt)) > liveWaitAfter
}

// publishLive sends meeting_live: the segments added and the live state.
func (s *Server) publishLive(id, projectID string, segs []proto.MeetingSegment) {
	ls, err := s.liveState(id)
	if err != nil {
		return
	}
	if segs == nil {
		segs = []proto.MeetingSegment{}
	}
	p, _ := json.Marshal(proto.MeetingLivePush{ID: id, ProjectID: projectID, Segments: segs, Live: ls})
	s.hub.publish(proto.Envelope{Type: "meeting_live", Payload: p})
}
