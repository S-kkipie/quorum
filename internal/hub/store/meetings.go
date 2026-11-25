package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	// MeetingAudioKeep: the audio of a meeting is deleted this long after the meeting became ready.
	MeetingAudioKeep = 30 * 24 * time.Hour
	// meetingUploadKeep: an upload with no chunk for this long is abandoned (retention drops it).
	meetingUploadKeep = 24 * time.Hour
)

var (
	// ErrUploadIncomplete: complete was called before every byte of the upload arrived.
	ErrUploadIncomplete = errors.New("the upload is not complete")
	// ErrNoProject: the meeting names a project that does not exist.
	ErrNoProject = errors.New("no such project")
	// ErrBadStatus: not a meeting status.
	ErrBadStatus = errors.New("invalid meeting status")
)

// MeetingStatuses are the states of a meeting, in pipeline order.
var MeetingStatuses = []string{"uploaded", "queued", "transcribing", "summarising", "ready", "failed"}

const schemaMeetings = `
CREATE TABLE IF NOT EXISTS meetings (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	started_at INTEGER NOT NULL DEFAULT 0,
	duration_s INTEGER NOT NULL DEFAULT 0,
	language TEXT NOT NULL DEFAULT '',
	speakers INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'uploaded',
	progress INTEGER NOT NULL DEFAULT 0,
	error TEXT NOT NULL DEFAULT '',
	provider TEXT NOT NULL DEFAULT '',
	ready_at INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS meetings_project ON meetings(project_id, started_at);
CREATE TABLE IF NOT EXISTS meeting_audio (
	meeting_id TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	bytes INTEGER NOT NULL DEFAULT 0,
	mime TEXT NOT NULL DEFAULT '',
	channels_meta TEXT NOT NULL DEFAULT '',
	expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meeting_segments (
	meeting_id TEXT NOT NULL,
	idx INTEGER NOT NULL,
	start_ms INTEGER NOT NULL DEFAULT 0,
	end_ms INTEGER NOT NULL DEFAULT 0,
	speaker TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (meeting_id, idx)
);
CREATE TABLE IF NOT EXISTS meeting_summary (
	meeting_id TEXT PRIMARY KEY,
	json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS meeting_actions (
	meeting_id TEXT NOT NULL,
	id TEXT NOT NULL,
	idx INTEGER NOT NULL DEFAULT 0,
	text TEXT NOT NULL DEFAULT '',
	owner TEXT NOT NULL DEFAULT '',
	due TEXT NOT NULL DEFAULT '',
	mine INTEGER NOT NULL DEFAULT 0,
	ts_ms INTEGER NOT NULL DEFAULT 0,
	issue_url TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (meeting_id, id)
);
CREATE TABLE IF NOT EXISTS meeting_speakers (
	meeting_id TEXT NOT NULL,
	label TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (meeting_id, label)
);
CREATE TABLE IF NOT EXISTS meeting_uploads (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL,
	path TEXT NOT NULL DEFAULT '',
	received INTEGER NOT NULL DEFAULT 0,
	size INTEGER NOT NULL DEFAULT 0,
	name TEXT NOT NULL DEFAULT '',
	mime TEXT NOT NULL DEFAULT '',
	channels TEXT NOT NULL DEFAULT '',
	project_id TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	language TEXT NOT NULL DEFAULT '',
	started_at INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS meeting_uploads_expires ON meeting_uploads(expires_at);
CREATE TABLE IF NOT EXISTS meeting_tokens (
	id TEXT PRIMARY KEY,
	hash TEXT NOT NULL,
	kind TEXT NOT NULL,
	meeting_id TEXT NOT NULL,
	ref TEXT NOT NULL DEFAULT '',
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meeting_tokens_meeting ON meeting_tokens(meeting_id);
`

// migrateMeetings (Plan 14): the meetings tables and the source of meeting_notes (connector rows come
// from a ticket source's sync; quorum rows are the projection of Quorum's own meetings).
func migrateMeetings(s *Store) error {
	if _, err := s.db.Exec(schemaMeetings + schemaMeetingJobs); err != nil {
		return err
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('meeting_notes') WHERE name='source'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE meeting_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'connector'`); err != nil {
			return err
		}
	}
	// the number of people the owner gave (0 = unknown), added after the first meetings schema
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('meetings') WHERE name='speakers'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE meetings ADD COLUMN speakers INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	return nil
}

// MeetingNoteID is the meeting_notes external id of the projection of a Quorum meeting.
func MeetingNoteID(meetingID string) string { return "meeting:" + meetingID }

// MeetingUpload is a resumable upload in progress (Done once complete created its meeting).
type MeetingUpload struct {
	ID        string
	MeetingID string
	Path      string
	Offset    int64
	Size      int64
	Name      string
	Mime      string
	Channels  string
	ProjectID string
	Title     string
	Language  string
	StartedAt int64
	Done      bool
	ExpiresAt int64
}

const uploadCols = `id,meeting_id,path,received,size,name,mime,channels,project_id,title,language,started_at,done,expires_at`

func scanUpload(sc interface{ Scan(...any) error }) (MeetingUpload, error) {
	var u MeetingUpload
	var done int
	err := sc.Scan(&u.ID, &u.MeetingID, &u.Path, &u.Offset, &u.Size, &u.Name, &u.Mime, &u.Channels, &u.ProjectID, &u.Title, &u.Language, &u.StartedAt, &done, &u.ExpiresAt)
	u.Done = done != 0
	return u, err
}

func (s *Store) projectExists(q interface {
	QueryRow(string, ...any) *sql.Row
}, id string) error {
	if id == "" {
		return nil
	}
	var n int
	if err := q.QueryRow(`SELECT count(*) FROM projects WHERE id=?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNoProject
	}
	return nil
}

// CreateMeetingUpload records a new upload at offset 0, assigning its id and its future meeting id
// (u.Path may be set later by SetMeetingUploadPath). A ProjectID that does not exist gives ErrNoProject.
func (s *Store) CreateMeetingUpload(u MeetingUpload) (MeetingUpload, error) {
	if err := s.projectExists(s.db, u.ProjectID); err != nil {
		return u, err
	}
	u.ID, u.MeetingID, u.Offset, u.Done = newID(), newID(), 0, false
	u.ExpiresAt = s.now().Add(meetingUploadKeep).UnixMilli()
	_, err := s.db.Exec(`INSERT INTO meeting_uploads(`+uploadCols+`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
		u.ID, u.MeetingID, u.Path, u.Offset, u.Size, u.Name, u.Mime, u.Channels, u.ProjectID, u.Title, u.Language, u.StartedAt, u.ExpiresAt)
	return u, err
}

// SetMeetingUploadPath sets where the upload's bytes are written.
func (s *Store) SetMeetingUploadPath(id, path string) error {
	return affected(s.db.Exec(`UPDATE meeting_uploads SET path=? WHERE id=?`, path, id))
}

// MeetingUploadByID returns the upload, or ErrNotFound.
func (s *Store) MeetingUploadByID(id string) (MeetingUpload, error) {
	u, err := scanUpload(s.db.QueryRow(`SELECT `+uploadCols+` FROM meeting_uploads WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

// SetMeetingUploadOffset stores how many bytes of the upload are on disk and extends its expiry.
func (s *Store) SetMeetingUploadOffset(id string, offset int64) error {
	return affected(s.db.Exec(`UPDATE meeting_uploads SET received=?, expires_at=? WHERE id=? AND done=0`,
		offset, s.now().Add(meetingUploadKeep).UnixMilli(), id))
}

// CompleteMeetingUpload creates the upload's meeting (status uploaded) with its audio at audioPath, in one
// transaction, and marks the upload done. A retried complete of a done upload returns the same meeting;
// an upload that is missing bytes gives ErrUploadIncomplete. A project deleted since the upload began
// leaves the meeting unassigned.
func (s *Store) CompleteMeetingUpload(id, audioPath string) (m proto.Meeting, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return m, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	u, err := scanUpload(tx.QueryRow(`SELECT `+uploadCols+` FROM meeting_uploads WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
		return m, err
	}
	if err != nil {
		return m, err
	}
	if u.Done {
		tx.Rollback()
		return s.Meeting(u.MeetingID)
	}
	if u.Offset != u.Size {
		err = ErrUploadIncomplete
		return m, err
	}
	if s.projectExists(tx, u.ProjectID) != nil {
		u.ProjectID = ""
	}
	now := s.now().UnixMilli()
	started := u.StartedAt
	if started == 0 {
		started = now
	}
	if _, err = tx.Exec(`INSERT INTO meetings(id,project_id,title,started_at,language,status,created_at,updated_at) VALUES(?,?,?,?,?,'uploaded',?,?)`,
		u.MeetingID, u.ProjectID, u.Title, started, u.Language, now, now); err != nil {
		return m, err
	}
	if _, err = tx.Exec(`INSERT INTO meeting_audio(meeting_id,path,bytes,mime,channels_meta,expires_at) VALUES(?,?,?,?,?,0)`,
		u.MeetingID, audioPath, u.Size, u.Mime, u.Channels); err != nil {
		return m, err
	}
	if _, err = tx.Exec(`UPDATE meeting_uploads SET done=1, path=?, expires_at=? WHERE id=?`, audioPath, s.now().Add(meetingUploadKeep).UnixMilli(), id); err != nil {
		return m, err
	}
	if err = tx.Commit(); err != nil {
		return m, err
	}
	return s.Meeting(u.MeetingID)
}

// ExpiredMeetingUploads returns the uploads whose expiry is before now (abandoned ones and the done
// markers kept for retried completes).
func (s *Store) ExpiredMeetingUploads(now int64) ([]MeetingUpload, error) {
	rows, err := s.db.Query(`SELECT `+uploadCols+` FROM meeting_uploads WHERE expires_at<?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MeetingUpload
	for rows.Next() {
		u, err := scanUpload(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// DeleteMeetingUpload forgets the upload.
func (s *Store) DeleteMeetingUpload(id string) error {
	_, err := s.db.Exec(`DELETE FROM meeting_uploads WHERE id=?`, id)
	return err
}

const meetingCols = `m.id,m.project_id,m.title,m.started_at,m.duration_s,m.language,m.status,m.progress,m.error,m.provider,
	m.created_at,m.updated_at,a.meeting_id IS NOT NULL,COALESCE(a.bytes,0),COALESCE(a.channels_meta,''),m.speakers`
const meetingFrom = ` FROM meetings m LEFT JOIN meeting_audio a ON a.meeting_id=m.id`

func scanMeeting(sc interface{ Scan(...any) error }) (proto.Meeting, error) {
	var m proto.Meeting
	err := sc.Scan(&m.ID, &m.ProjectID, &m.Title, &m.StartedAt, &m.DurationS, &m.Language, &m.Status, &m.Progress, &m.Error,
		&m.Provider, &m.CreatedAt, &m.UpdatedAt, &m.HasAudio, &m.AudioBytes, &m.Channels, &m.SpeakerCount)
	return m, err
}

// Meeting returns the meeting without its summary, segments, actions and speakers, or ErrNotFound.
func (s *Store) Meeting(id string) (proto.Meeting, error) {
	m, err := scanMeeting(s.db.QueryRow(`SELECT `+meetingCols+meetingFrom+` WHERE m.id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

// MeetingFilter selects meetings: of one project, only the unassigned ones, or all (zero value).
type MeetingFilter struct {
	ProjectID  string
	Unassigned bool
}

// Meetings lists meetings, most recent first.
func (s *Store) Meetings(f MeetingFilter) ([]proto.Meeting, error) {
	q, args := `SELECT `+meetingCols+meetingFrom, []any{}
	switch {
	case f.Unassigned:
		q += ` WHERE m.project_id=''`
	case f.ProjectID != "":
		q += ` WHERE m.project_id=?`
		args = append(args, f.ProjectID)
	}
	rows, err := s.db.Query(q+` ORDER BY m.started_at DESC, m.created_at DESC, m.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Meeting{}
	for rows.Next() {
		m, err := scanMeeting(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MeetingDetail returns the meeting with its summary (nil until there is one), segments in order,
// actions in order and speaker names.
func (s *Store) MeetingDetail(id string) (proto.Meeting, error) {
	m, err := s.Meeting(id)
	if err != nil {
		return m, err
	}
	var sj string
	switch err := s.db.QueryRow(`SELECT json FROM meeting_summary WHERE meeting_id=?`, id).Scan(&sj); {
	case err == nil:
		var sum proto.MeetingSummary
		if json.Unmarshal([]byte(sj), &sum) == nil {
			m.Summary = &sum
		}
	case !errors.Is(err, sql.ErrNoRows):
		return m, err
	}
	if m.Segments, err = s.MeetingSegments(id); err != nil {
		return m, err
	}
	if m.Actions, err = s.MeetingActions(id); err != nil {
		return m, err
	}
	m.Speakers, err = s.MeetingSpeakers(id)
	return m, err
}

// MeetingSegments returns the meeting's transcript in order.
func (s *Store) MeetingSegments(id string) ([]proto.MeetingSegment, error) {
	rows, err := s.db.Query(`SELECT start_ms,end_ms,speaker,text FROM meeting_segments WHERE meeting_id=? ORDER BY idx`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []proto.MeetingSegment
	for rows.Next() {
		var sg proto.MeetingSegment
		if err := rows.Scan(&sg.StartMs, &sg.EndMs, &sg.Speaker, &sg.Text); err != nil {
			return nil, err
		}
		out = append(out, sg)
	}
	return out, rows.Err()
}

// MeetingSpeakers returns the names the owner gave the meeting's speaker labels (nil when none).
func (s *Store) MeetingSpeakers(id string) (map[string]string, error) {
	rows, err := s.db.Query(`SELECT label,name FROM meeting_speakers WHERE meeting_id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out map[string]string
	for rows.Next() {
		var l, n string
		if err := rows.Scan(&l, &n); err != nil {
			return nil, err
		}
		if out == nil {
			out = map[string]string{}
		}
		out[l] = n
	}
	return out, rows.Err()
}

// ReplaceMeetingSegments makes the meeting's transcript equal to segs.
func (s *Store) ReplaceMeetingSegments(id string, segs []proto.MeetingSegment) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	if _, err = tx.Exec(`DELETE FROM meeting_segments WHERE meeting_id=?`, id); err != nil {
		return err
	}
	for i, sg := range segs {
		if _, err = tx.Exec(`INSERT INTO meeting_segments(meeting_id,idx,start_ms,end_ms,speaker,text) VALUES(?,?,?,?,?,?)`,
			id, i, sg.StartMs, sg.EndMs, sg.Speaker, sg.Text); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetMeetingSummary stores the meeting's summary.
func (s *Store) SetMeetingSummary(id string, sum proto.MeetingSummary) error {
	b, err := json.Marshal(sum)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO meeting_summary(meeting_id,json) VALUES(?,?) ON CONFLICT(meeting_id) DO UPDATE SET json=excluded.json`, id, string(b))
	return err
}

// SetMeetingStatus moves the meeting to status with its error and progress. The first time it becomes
// ready, its audio is set to expire MeetingAudioKeep later.
func (s *Store) SetMeetingStatus(id, status, errMsg string, progress int) (err error) {
	valid := false
	for _, st := range MeetingStatuses {
		valid = valid || st == status
	}
	if !valid {
		return ErrBadStatus
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	now := s.now()
	if err = affected(tx.Exec(`UPDATE meetings SET status=?, error=?, progress=?, updated_at=? WHERE id=?`, status, errMsg, progress, now.UnixMilli(), id)); err != nil {
		return err
	}
	if status == "ready" {
		if _, err = tx.Exec(`UPDATE meetings SET ready_at=? WHERE id=? AND ready_at=0`, now.UnixMilli(), id); err != nil {
			return err
		}
		if _, err = tx.Exec(`UPDATE meeting_audio SET expires_at=? WHERE meeting_id=? AND expires_at=0`, now.Add(MeetingAudioKeep).UnixMilli(), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// MeetingPatch holds the editable fields of a meeting; nil leaves a field as is ("" ProjectID unassigns).
type MeetingPatch struct {
	Title     *string
	ProjectID *string
	Language  *string
	// Speakers is the number of people (0 = unknown); diarization clusters to it.
	Speakers *int
}

// PatchMeeting applies p and returns the meeting and its project before the patch. Moving the meeting to
// another project moves its briefing projection there; unassigning it drops the projection.
func (s *Store) PatchMeeting(id string, p MeetingPatch) (m proto.Meeting, oldProject string, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return m, "", err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	err = tx.QueryRow(`SELECT project_id FROM meetings WHERE id=?`, id).Scan(&oldProject)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		return m, "", err
	}
	now := s.now().UnixMilli()
	if p.Title != nil {
		if _, err = tx.Exec(`UPDATE meetings SET title=?, updated_at=? WHERE id=?`, *p.Title, now, id); err != nil {
			return m, "", err
		}
	}
	if p.Language != nil {
		if _, err = tx.Exec(`UPDATE meetings SET language=?, updated_at=? WHERE id=?`, *p.Language, now, id); err != nil {
			return m, "", err
		}
	}
	if p.Speakers != nil {
		if _, err = tx.Exec(`UPDATE meetings SET speakers=?, updated_at=? WHERE id=?`, *p.Speakers, now, id); err != nil {
			return m, "", err
		}
	}
	if p.ProjectID != nil && *p.ProjectID != oldProject {
		if err = s.projectExists(tx, *p.ProjectID); err != nil {
			return m, "", err
		}
		if _, err = tx.Exec(`UPDATE meetings SET project_id=?, updated_at=? WHERE id=?`, *p.ProjectID, now, id); err != nil {
			return m, "", err
		}
		if *p.ProjectID == "" {
			_, err = tx.Exec(`DELETE FROM meeting_notes WHERE source='quorum' AND external_id=?`, MeetingNoteID(id))
		} else {
			_, err = tx.Exec(`UPDATE meeting_notes SET project_id=? WHERE source='quorum' AND external_id=?`, *p.ProjectID, MeetingNoteID(id))
		}
		if err != nil {
			return m, "", err
		}
	}
	if err = tx.Commit(); err != nil {
		return m, "", err
	}
	m, err = s.Meeting(id)
	return m, oldProject, err
}

// SetMeetingProjection writes the meeting's row in its project's meeting_notes (source quorum, keyed by
// MeetingNoteID) with first_seen_at = firstSeen on insert; nil, or an unassigned meeting, removes it.
func (s *Store) SetMeetingProjection(meetingID string, note *proto.MeetingNote, firstSeen int64) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	var project string
	err = tx.QueryRow(`SELECT project_id FROM meetings WHERE id=?`, meetingID).Scan(&project)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		return err
	}
	ext := MeetingNoteID(meetingID)
	if _, err = tx.Exec(`DELETE FROM meeting_notes WHERE source='quorum' AND external_id=? AND project_id<>?`, ext, project); err != nil {
		return err
	}
	if note == nil || project == "" {
		if _, err = tx.Exec(`DELETE FROM meeting_notes WHERE source='quorum' AND external_id=?`, ext); err != nil {
			return err
		}
		return tx.Commit()
	}
	m := *note
	// a connector row that happens to carry the same id is replaced by the meeting
	if _, err = tx.Exec(`INSERT INTO meeting_notes(project_id,`+noteCols+`,first_seen_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,'quorum')
		ON CONFLICT(project_id,external_id) DO UPDATE SET title=excluded.title,date=excluded.date,summary=excluded.summary,
		decisions=excluded.decisions,open_points=excluded.open_points,actions=excluded.actions,url=excluded.url,
		updated_at=excluded.updated_at,source='quorum',
		first_seen_at=CASE WHEN meeting_notes.source='quorum' THEN meeting_notes.first_seen_at ELSE excluded.first_seen_at END`,
		project, ext, m.Title, m.Date, m.Summary, m.Decisions, m.OpenPoints, m.Actions, m.URL, m.UpdatedAt, firstSeen); err != nil {
		return err
	}
	return tx.Commit()
}

// DeletedMeeting is what DeleteMeeting removed that lives outside the database.
type DeletedMeeting struct {
	ProjectID string
	AudioPath string
}

// DeleteMeeting removes the meeting and everything that belongs to it (audio row, transcript, summary,
// actions, speakers, upload markers, signed tokens, jobs and its briefing projection). The caller removes the
// audio file.
func (s *Store) DeleteMeeting(id string) (out DeletedMeeting, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return out, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	err = tx.QueryRow(`SELECT project_id FROM meetings WHERE id=?`, id).Scan(&out.ProjectID)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if err = tx.QueryRow(`SELECT path FROM meeting_audio WHERE meeting_id=?`, id).Scan(&out.AudioPath); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	err = nil
	for _, q := range []string{
		`DELETE FROM meeting_audio WHERE meeting_id=?`,
		`DELETE FROM meeting_segments WHERE meeting_id=?`,
		`DELETE FROM meeting_summary WHERE meeting_id=?`,
		`DELETE FROM meeting_actions WHERE meeting_id=?`,
		`DELETE FROM meeting_speakers WHERE meeting_id=?`,
		`DELETE FROM meeting_uploads WHERE meeting_id=?`,
		`DELETE FROM meeting_tokens WHERE meeting_id=?`,
		`DELETE FROM meeting_jobs WHERE meeting_id=?`,
		`DELETE FROM meetings WHERE id=?`,
	} {
		if _, err = tx.Exec(q, id); err != nil {
			return out, err
		}
	}
	if _, err = tx.Exec(`DELETE FROM meeting_notes WHERE source='quorum' AND external_id=?`, MeetingNoteID(id)); err != nil {
		return out, err
	}
	return out, tx.Commit()
}

// MeetingAudio returns the meeting's audio file, or ok false when it has none (deleted or expired).
func (s *Store) MeetingAudio(id string) (path, mime string, bytes int64, ok bool, err error) {
	err = s.db.QueryRow(`SELECT path,mime,bytes FROM meeting_audio WHERE meeting_id=?`, id).Scan(&path, &mime, &bytes)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", 0, false, nil
	}
	return path, mime, bytes, err == nil, err
}

// MeetingAudioBytes is the total size of the stored meeting audio.
func (s *Store) MeetingAudioBytes() (int64, error) {
	var n int64
	err := s.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM meeting_audio`).Scan(&n)
	return n, err
}

// MeetingAudioFile is an audio file whose retention ended.
type MeetingAudioFile struct {
	MeetingID string
	Path      string
}

// ExpiredMeetingAudio returns the audio files that expired before now (only ready meetings expire).
func (s *Store) ExpiredMeetingAudio(now int64) ([]MeetingAudioFile, error) {
	rows, err := s.db.Query(`SELECT meeting_id,path FROM meeting_audio WHERE expires_at>0 AND expires_at<=? ORDER BY meeting_id`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MeetingAudioFile
	for rows.Next() {
		var f MeetingAudioFile
		if err := rows.Scan(&f.MeetingID, &f.Path); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// DropMeetingAudio forgets the meeting's audio (its transcript and summary stay).
func (s *Store) DropMeetingAudio(id string) error {
	if _, err := s.db.Exec(`DELETE FROM meeting_audio WHERE meeting_id=?`, id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM meeting_tokens WHERE meeting_id=? AND kind='audio'`, id)
	return err
}

// MeetingTokenInfo is what a signed meeting token grants.
type MeetingTokenInfo struct {
	MeetingID string
	Ref       string // e.g. the job id of a worker's token
}

// CreateMeetingToken returns a new signed token of kind for the meeting, valid for ttl. The token is
// "<id>.<secret>" with a random 32-byte secret; only the secret's SHA-256 is stored.
func (s *Store) CreateMeetingToken(kind, meetingID, ref string, ttl time.Duration) (string, error) {
	var sec [32]byte
	if _, err := rand.Read(sec[:]); err != nil {
		return "", err
	}
	id := newID()
	secret := base64.RawURLEncoding.EncodeToString(sec[:])
	h := sha256.Sum256([]byte(secret))
	_, err := s.db.Exec(`INSERT INTO meeting_tokens(id,hash,kind,meeting_id,ref,expires_at) VALUES(?,?,?,?,?,?)`,
		id, base64.RawURLEncoding.EncodeToString(h[:]), kind, meetingID, ref, s.now().Add(ttl).UnixMilli())
	if err != nil {
		return "", err
	}
	return id + "." + secret, nil
}

// MeetingToken checks a signed token of kind: ok is false when it is malformed, unknown, of another
// kind, or expired. The secret is compared in constant time.
func (s *Store) MeetingToken(kind, tok string) (MeetingTokenInfo, bool, error) {
	var info MeetingTokenInfo
	id, secret, found := strings.Cut(tok, ".")
	if !found || id == "" || secret == "" || len(tok) > 200 {
		return info, false, nil
	}
	var hash, k string
	var exp int64
	err := s.db.QueryRow(`SELECT hash,kind,meeting_id,ref,expires_at FROM meeting_tokens WHERE id=?`, id).Scan(&hash, &k, &info.MeetingID, &info.Ref, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return MeetingTokenInfo{}, false, nil
	}
	if err != nil {
		return MeetingTokenInfo{}, false, err
	}
	h := sha256.Sum256([]byte(secret))
	got := base64.RawURLEncoding.EncodeToString(h[:])
	if subtle.ConstantTimeCompare([]byte(got), []byte(hash)) != 1 || k != kind || s.now().UnixMilli() >= exp {
		return MeetingTokenInfo{}, false, nil
	}
	return info, true, nil
}

// PruneMeetingTokens deletes the tokens that expired by now.
func (s *Store) PruneMeetingTokens(now int64) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM meeting_tokens WHERE expires_at<=?`, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// SetClockForTest replaces the store's clock (tests of other packages).
func (s *Store) SetClockForTest(now func() time.Time) { s.now = now }
