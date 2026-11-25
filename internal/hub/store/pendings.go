package store

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

// maxAgentPendings is the number of open agent-created pendings a project may hold.
const maxAgentPendings = 50

// ErrPendingCap means the project already has the maximum of open agent pendings.
var ErrPendingCap = errors.New("pending cap")

const schemaPendings = `
CREATE TABLE IF NOT EXISTS pendings (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	text TEXT NOT NULL DEFAULT '',
	norm TEXT NOT NULL DEFAULT '',
	detail TEXT NOT NULL DEFAULT '',
	note TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL DEFAULT 'manual',
	source_ref TEXT NOT NULL DEFAULT '',
	client_key TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'open',
	created_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT 0,
	done_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pendings_project ON pendings(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS pendings_norm ON pendings(project_id, norm);
CREATE UNIQUE INDEX IF NOT EXISTS pendings_client_key ON pendings(project_id, client_key) WHERE client_key<>'';
`

// migratePendings (Plan 15): the project's pending items.
func migratePendings(s *Store) error {
	_, err := s.db.Exec(schemaPendings)
	return err
}

const pendingCols = `id, project_id, text, detail, note, source, source_ref, status, created_at, updated_at, done_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanPending(r rowScanner) (p proto.Pending, err error) {
	err = r.Scan(&p.ID, &p.ProjectID, &p.Text, &p.Detail, &p.Note, &p.Source, &p.SourceRef, &p.Status, &p.CreatedAt, &p.UpdatedAt, &p.DoneAt)
	return
}

// normPending lowercases and collapses whitespace, for the duplicate check.
func normPending(text string) string {
	return strings.Join(strings.Fields(strings.ToLower(text)), " ")
}

// AddPending inserts p (ProjectID, Text, Detail, Source and SourceRef are used). Checks, in order: a
// clientKey already used in the project returns that item (any status); the same normalised text among the
// open items returns that item; agent items beyond the open cap return ErrPendingCap; otherwise a new item.
// created reports whether a row was inserted.
func (s *Store) AddPending(p proto.Pending, clientKey string, now int64) (proto.Pending, bool, error) {
	if clientKey != "" {
		got, err := scanPending(s.db.QueryRow(`SELECT `+pendingCols+` FROM pendings WHERE project_id=? AND client_key=?`, p.ProjectID, clientKey))
		if err == nil {
			return got, false, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return proto.Pending{}, false, err
		}
	}
	norm := normPending(p.Text)
	got, err := scanPending(s.db.QueryRow(`SELECT `+pendingCols+` FROM pendings WHERE project_id=? AND norm=? AND status='open' ORDER BY created_at, rowid LIMIT 1`, p.ProjectID, norm))
	if err == nil {
		return got, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return proto.Pending{}, false, err
	}
	if p.Source == "agent" {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM pendings WHERE project_id=? AND source='agent' AND status='open'`, p.ProjectID).Scan(&n); err != nil {
			return proto.Pending{}, false, err
		}
		if n >= maxAgentPendings {
			return proto.Pending{}, false, ErrPendingCap
		}
	}
	p.ID = newID()
	p.Status = "open"
	p.CreatedAt, p.UpdatedAt, p.DoneAt = now, now, 0
	_, err = s.db.Exec(`INSERT INTO pendings (id, project_id, text, norm, detail, note, source, source_ref, client_key, status, created_at, updated_at, done_at)
		VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,0)`,
		p.ID, p.ProjectID, p.Text, norm, p.Detail, p.Note, p.Source, p.SourceRef, clientKey, now, now)
	if err != nil {
		return proto.Pending{}, false, err
	}
	return p, true, nil
}

// Pendings lists the project's pendings, oldest first; open ones only unless all.
func (s *Store) Pendings(projectID string, all bool) ([]proto.Pending, error) {
	q := `SELECT ` + pendingCols + ` FROM pendings WHERE project_id=?`
	if !all {
		q += ` AND status='open'`
	}
	rows, err := s.db.Query(q+` ORDER BY created_at, rowid`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Pending{}
	for rows.Next() {
		p, err := scanPending(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Pending returns one item; sql.ErrNoRows when missing.
func (s *Store) Pending(id string) (proto.Pending, error) {
	return scanPending(s.db.QueryRow(`SELECT `+pendingCols+` FROM pendings WHERE id=?`, id))
}

// PendingPatch holds the fields to change; nil fields stay as they are.
type PendingPatch struct{ Text, Detail, Note, Status *string }

// UpdatePending applies f. Status done or dropped sets DoneAt to now; open resets it to 0.
func (s *Store) UpdatePending(id string, f PendingPatch, now int64) (proto.Pending, error) {
	p, err := s.Pending(id)
	if err != nil {
		return proto.Pending{}, err
	}
	if f.Text != nil {
		p.Text = *f.Text
	}
	if f.Detail != nil {
		p.Detail = *f.Detail
	}
	if f.Note != nil {
		p.Note = *f.Note
	}
	if f.Status != nil && *f.Status != p.Status {
		p.Status = *f.Status
		if p.Status == "open" {
			p.DoneAt = 0
		} else {
			p.DoneAt = now
		}
	}
	p.UpdatedAt = now
	_, err = s.db.Exec(`UPDATE pendings SET text=?, norm=?, detail=?, note=?, status=?, updated_at=?, done_at=? WHERE id=?`,
		p.Text, normPending(p.Text), p.Detail, p.Note, p.Status, p.UpdatedAt, p.DoneAt, id)
	return p, err
}

// DeletePending removes the item and returns its project; sql.ErrNoRows when missing.
func (s *Store) DeletePending(id string) (string, error) {
	p, err := s.Pending(id)
	if err != nil {
		return "", err
	}
	_, err = s.db.Exec(`DELETE FROM pendings WHERE id=?`, id)
	return p.ProjectID, err
}

// MeetingPendingExists finds a pending of any status created from the meeting with the same normalised text.
func (s *Store) MeetingPendingExists(meetingID, text string) (string, bool, error) {
	var id string
	err := s.db.QueryRow(`SELECT id FROM pendings WHERE source='meeting' AND source_ref=? AND norm=? LIMIT 1`, meetingID, normPending(text)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return id, err == nil, err
}
