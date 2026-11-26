package store

import (
	"database/sql"
	"errors"

	"github.com/S-kkipie/quorum/internal/proto"
)

// LiveState is the stored state of a live (recording) meeting: the next slice expected, the bytes assembled
// in its audio file, the time the transcript covers and when the last slice arrived (unix ms).
type LiveState struct {
	MeetingID   string
	NextSeq     int
	Bytes       int64
	ThroughMs   int64
	LastSliceAt int64
	CreatedAt   int64
}

// CreateLiveMeeting creates a meeting in status live with an empty audio file at audioPath(id) (audio/webm)
// and its live state, in one transaction. Only ProjectID, Title, Language and StartedAt of u are used. A
// ProjectID that does not exist gives ErrNoProject.
func (s *Store) CreateLiveMeeting(u MeetingUpload, audioPath func(id string) string) (m proto.Meeting, err error) {
	if err = s.projectExists(s.db, u.ProjectID); err != nil {
		return m, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return m, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	id := newID()
	now := s.now().UnixMilli()
	started := u.StartedAt
	if started == 0 {
		started = now
	}
	if _, err = tx.Exec(`INSERT INTO meetings(id,project_id,title,started_at,language,status,created_at,updated_at) VALUES(?,?,?,?,?,'live',?,?)`,
		id, u.ProjectID, u.Title, started, u.Language, now, now); err != nil {
		return m, err
	}
	if _, err = tx.Exec(`INSERT INTO meeting_audio(meeting_id,path,bytes,mime,channels_meta,expires_at) VALUES(?,?,0,'audio/webm','',0)`,
		id, audioPath(id)); err != nil {
		return m, err
	}
	if _, err = tx.Exec(`INSERT INTO meeting_live(meeting_id) VALUES(?)`, id); err != nil {
		return m, err
	}
	if err = tx.Commit(); err != nil {
		return m, err
	}
	return s.Meeting(id)
}

const liveCols = `l.meeting_id,l.next_seq,l.bytes,l.through_ms,l.last_slice_at,m.created_at`
const liveFrom = ` FROM meeting_live l JOIN meetings m ON m.id=l.meeting_id`

func scanLive(sc interface{ Scan(...any) error }) (LiveState, error) {
	var l LiveState
	err := sc.Scan(&l.MeetingID, &l.NextSeq, &l.Bytes, &l.ThroughMs, &l.LastSliceAt, &l.CreatedAt)
	return l, err
}

// MeetingLiveState returns the live state of the meeting, or ErrNotFound when it is not live.
func (s *Store) MeetingLiveState(id string) (LiveState, error) {
	l, err := scanLive(s.db.QueryRow(`SELECT `+liveCols+liveFrom+` WHERE l.meeting_id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrNotFound
	}
	return l, err
}

// LiveMeetings lists the live meetings, oldest first.
func (s *Store) LiveMeetings() ([]LiveState, error) {
	rows, err := s.db.Query(`SELECT ` + liveCols + liveFrom + ` ORDER BY m.created_at, l.meeting_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LiveState
	for rows.Next() {
		l, err := scanLive(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// AdvanceLive records that slices below nextSeq are assembled into bytes bytes of audio, at unix ms at; the
// meeting's audio size follows.
func (s *Store) AdvanceLive(id string, nextSeq int, bytes, at int64) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	if err = affected(tx.Exec(`UPDATE meeting_live SET next_seq=?, bytes=?, last_slice_at=? WHERE meeting_id=?`, nextSeq, bytes, at, id)); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE meeting_audio SET bytes=? WHERE meeting_id=?`, bytes, id); err != nil {
		return err
	}
	return tx.Commit()
}

// SetLiveThrough stores the time the live transcript covers; it never moves back.
func (s *Store) SetLiveThrough(id string, ms int64) error {
	return affected(s.db.Exec(`UPDATE meeting_live SET through_ms=MAX(through_ms,?) WHERE meeting_id=?`, ms, id))
}

// AppendMeetingSegments adds segs after the meeting's last segment (idx continues).
func (s *Store) AppendMeetingSegments(id string, segs []proto.MeetingSegment) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	var next int
	if err = tx.QueryRow(`SELECT COALESCE(MAX(idx)+1,0) FROM meeting_segments WHERE meeting_id=?`, id).Scan(&next); err != nil {
		return err
	}
	for i, sg := range segs {
		if _, err = tx.Exec(`INSERT INTO meeting_segments(meeting_id,idx,start_ms,end_ms,speaker,text) VALUES(?,?,?,?,?,?)`,
			id, next+i, sg.StartMs, sg.EndMs, sg.Speaker, sg.Text); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// EndLive removes the meeting's live state (it is no longer recording).
func (s *Store) EndLive(id string) error {
	_, err := s.db.Exec(`DELETE FROM meeting_live WHERE meeting_id=?`, id)
	return err
}

// ApplyLiveChunk stores a chunk's result in one transaction: only the segments that end after the live
// transcript's through_ms are kept and inserted (idx continues), and through_ms becomes the larger of itself
// and throughMs. It returns the segments appended, or ErrNotFound when the meeting is not live.
func (s *Store) ApplyLiveChunk(id string, segs []proto.MeetingSegment, throughMs int64) (appended []proto.MeetingSegment, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	var through int64
	if err = tx.QueryRow(`SELECT through_ms FROM meeting_live WHERE meeting_id=?`, id).Scan(&through); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrNotFound
		}
		return nil, err
	}
	var next int
	if err = tx.QueryRow(`SELECT COALESCE(MAX(idx)+1,0) FROM meeting_segments WHERE meeting_id=?`, id).Scan(&next); err != nil {
		return nil, err
	}
	for _, sg := range segs {
		if sg.EndMs <= through {
			continue
		}
		if _, err = tx.Exec(`INSERT INTO meeting_segments(meeting_id,idx,start_ms,end_ms,speaker,text) VALUES(?,?,?,?,?,?)`,
			id, next+len(appended), sg.StartMs, sg.EndMs, sg.Speaker, sg.Text); err != nil {
			return nil, err
		}
		appended = append(appended, sg)
	}
	if _, err = tx.Exec(`UPDATE meeting_live SET through_ms=MAX(through_ms,?) WHERE meeting_id=?`, throughMs, id); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return appended, nil
}
