package store

import (
	"database/sql"
	"errors"
	"time"
)

// Meeting job states. A job is queued until the hub hands it to a machine (running); it ends done,
// failed or cancelled (the meeting was deleted or retried).
const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobDone      = "done"
	JobFailed    = "failed"
	JobCancelled = "cancelled"
)

const schemaMeetingJobs = `
CREATE TABLE IF NOT EXISTS meeting_jobs (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL,
	step TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 1,
	status TEXT NOT NULL DEFAULT 'queued',
	machine TEXT NOT NULL DEFAULT '',
	settings TEXT NOT NULL DEFAULT '{}',
	error TEXT NOT NULL DEFAULT '',
	pct INTEGER NOT NULL DEFAULT 0,
	stage TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER NOT NULL DEFAULT 0,
	heartbeat_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS meeting_jobs_status ON meeting_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS meeting_jobs_meeting ON meeting_jobs(meeting_id);
`

// MeetingJob is one processing step of a meeting. Attempt starts at 1 and grows each time the job is
// re-queued after its machine went silent; results carry it, so a late result of an older attempt is
// discarded. HeartbeatAt is the last time the running job's machine reported progress (or the job started).
type MeetingJob struct {
	ID          string
	MeetingID   string
	Step        string
	Attempt     int
	Status      string
	Machine     string
	Settings    string
	Error       string
	Pct         int
	Stage       string
	CreatedAt   int64
	StartedAt   int64
	HeartbeatAt int64
}

const jobCols = `id,meeting_id,step,attempt,status,machine,settings,error,pct,stage,created_at,started_at,heartbeat_at`

func scanJob(sc interface{ Scan(...any) error }) (MeetingJob, error) {
	var j MeetingJob
	err := sc.Scan(&j.ID, &j.MeetingID, &j.Step, &j.Attempt, &j.Status, &j.Machine, &j.Settings, &j.Error, &j.Pct,
		&j.Stage, &j.CreatedAt, &j.StartedAt, &j.HeartbeatAt)
	return j, err
}

func (s *Store) jobs(q string, args ...any) ([]MeetingJob, error) {
	rows, err := s.db.Query(`SELECT `+jobCols+` FROM meeting_jobs `+q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MeetingJob
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// CreateMeetingJob queues a new job (attempt 1) of step for the meeting. settings is the step's JSON.
func (s *Store) CreateMeetingJob(meetingID, step, settings string) (MeetingJob, error) {
	if settings == "" {
		settings = "{}"
	}
	now := s.now().UnixMilli()
	j := MeetingJob{ID: newID(), MeetingID: meetingID, Step: step, Attempt: 1, Status: JobQueued, Settings: settings, CreatedAt: now}
	_, err := s.db.Exec(`INSERT INTO meeting_jobs(id,meeting_id,step,attempt,status,settings,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
		j.ID, j.MeetingID, j.Step, j.Attempt, j.Status, j.Settings, now, now)
	return j, err
}

// MeetingJob returns the job, or ErrNotFound.
func (s *Store) MeetingJob(id string) (MeetingJob, error) {
	j, err := scanJob(s.db.QueryRow(`SELECT `+jobCols+` FROM meeting_jobs WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return j, ErrNotFound
	}
	return j, err
}

// MeetingJobsWithStatus lists the jobs in status, oldest first.
func (s *Store) MeetingJobsWithStatus(status string) ([]MeetingJob, error) {
	return s.jobs(`WHERE status=? ORDER BY created_at, id`, status)
}

// ActiveMeetingJobs lists the meeting's queued and running jobs.
func (s *Store) ActiveMeetingJobs(meetingID string) ([]MeetingJob, error) {
	return s.jobs(`WHERE meeting_id=? AND status IN ('queued','running') ORDER BY created_at, id`, meetingID)
}

// StartMeetingJob moves a queued job to running on machine; false when it was no longer queued.
func (s *Store) StartMeetingJob(id, machine string) (bool, error) {
	now := s.now().UnixMilli()
	return changed(s.db.Exec(`UPDATE meeting_jobs SET status='running', machine=?, pct=0, stage='', started_at=?, heartbeat_at=?, updated_at=?
		WHERE id=? AND status='queued'`, machine, now, now, now, id))
}

// UnstartMeetingJob puts a running attempt back in the queue unchanged (the machine never took it).
func (s *Store) UnstartMeetingJob(id string, attempt int) (bool, error) {
	return changed(s.db.Exec(`UPDATE meeting_jobs SET status='queued', machine='', started_at=0, heartbeat_at=0, updated_at=?
		WHERE id=? AND attempt=? AND status='running'`, s.now().UnixMilli(), id, attempt))
}

// RequeueMeetingJob puts a running attempt back in the queue as attempt+1 (its machine went silent).
func (s *Store) RequeueMeetingJob(id string, attempt int) (bool, error) {
	return changed(s.db.Exec(`UPDATE meeting_jobs SET status='queued', attempt=attempt+1, machine='', pct=0, stage='', started_at=0,
		heartbeat_at=0, updated_at=? WHERE id=? AND attempt=? AND status='running'`, s.now().UnixMilli(), id, attempt))
}

// HeartbeatMeetingJob records the progress of a running attempt on machine; false when the job is not
// that machine's running attempt (a stale or foreign report).
func (s *Store) HeartbeatMeetingJob(id string, attempt int, machine string, pct int, stage string) (bool, error) {
	now := s.now().UnixMilli()
	return changed(s.db.Exec(`UPDATE meeting_jobs SET pct=?, stage=?, heartbeat_at=?, updated_at=?
		WHERE id=? AND attempt=? AND machine=? AND status='running'`, pct, stage, now, now, id, attempt, machine))
}

// FinishMeetingJob ends a running attempt with status (done or failed) and errMsg; false when the job is
// not running that attempt any more, so exactly one result of an attempt is ever applied.
func (s *Store) FinishMeetingJob(id string, attempt int, status, errMsg string) (bool, error) {
	return changed(s.db.Exec(`UPDATE meeting_jobs SET status=?, error=?, updated_at=? WHERE id=? AND attempt=? AND status='running'`,
		status, errMsg, s.now().UnixMilli(), id, attempt))
}

// FailMeetingJob ends a queued or running job as failed.
func (s *Store) FailMeetingJob(id, errMsg string) (bool, error) {
	return changed(s.db.Exec(`UPDATE meeting_jobs SET status='failed', error=?, updated_at=? WHERE id=? AND status IN ('queued','running')`,
		errMsg, s.now().UnixMilli(), id))
}

// CancelMeetingJobs cancels the meeting's queued and running jobs and returns those that were running.
func (s *Store) CancelMeetingJobs(meetingID string) ([]MeetingJob, error) {
	running, err := s.jobs(`WHERE meeting_id=? AND status='running'`, meetingID)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(`UPDATE meeting_jobs SET status='cancelled', updated_at=? WHERE meeting_id=? AND status IN ('queued','running')`,
		s.now().UnixMilli(), meetingID)
	return running, err
}

// ResetMeetingJobHeartbeats gives every running job a fresh heartbeat (at hub start nobody is connected
// yet: each machine gets the normal silence window to come back before its job is re-queued).
func (s *Store) ResetMeetingJobHeartbeats() error {
	_, err := s.db.Exec(`UPDATE meeting_jobs SET heartbeat_at=? WHERE status='running'`, s.now().UnixMilli())
	return err
}

// SetMeetingDuration stores the meeting's audio length in seconds.
func (s *Store) SetMeetingDuration(id string, secs int64) error {
	return affected(s.db.Exec(`UPDATE meetings SET duration_s=?, updated_at=? WHERE id=?`, secs, s.now().UnixMilli(), id))
}

// SetMeetingDetectedLanguage stores the language a worker detected (only when the meeting had none or "auto").
func (s *Store) SetMeetingDetectedLanguage(id, lang string) error {
	_, err := s.db.Exec(`UPDATE meetings SET language=?, updated_at=? WHERE id=? AND language IN ('','auto')`, lang, s.now().UnixMilli(), id)
	return err
}

// DeleteMeetingTokensRef removes the signed tokens of kind issued for ref (a job attempt that never ran).
func (s *Store) DeleteMeetingTokensRef(kind, ref string) error {
	_, err := s.db.Exec(`DELETE FROM meeting_tokens WHERE kind=? AND ref=?`, kind, ref)
	return err
}

// MeetingJobTokenTTL is how long a job attempt's signed URLs work.
const MeetingJobTokenTTL = 2 * time.Hour

func changed(res sql.Result, err error) (bool, error) {
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
