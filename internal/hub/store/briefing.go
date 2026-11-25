package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	changeRetentionMs = int64(60 * 24 * 60 * 60 * 1000)
	visitRolloverMs   = int64(30 * 60 * 1000)
	maxPinnedRunes    = 500
)

const schemaBriefing = `
CREATE TABLE IF NOT EXISTS ticket_changes (
	project_id TEXT NOT NULL,
	external_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	from_val TEXT NOT NULL DEFAULT '',
	to_val TEXT NOT NULL DEFAULT '',
	at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ticket_changes_project ON ticket_changes(project_id, at);
CREATE TABLE IF NOT EXISTS project_visits (
	project_id TEXT PRIMARY KEY,
	seen_at INTEGER NOT NULL DEFAULT 0,
	prev_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pinned_notes (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	text TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pinned_notes_project ON pinned_notes(project_id, created_at);
CREATE TABLE IF NOT EXISTS meeting_notes (
	project_id TEXT NOT NULL,
	external_id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	date TEXT NOT NULL DEFAULT '',
	summary TEXT NOT NULL DEFAULT '',
	decisions TEXT NOT NULL DEFAULT '',
	open_points TEXT NOT NULL DEFAULT '',
	actions TEXT NOT NULL DEFAULT '',
	url TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (project_id, external_id)
);
`

// migrateBriefing (Plan 13): the change log, visits, pinned and meeting notes tables, the optional
// ticket fields and the cached "where you left off" text of a project.
func migrateBriefing(s *Store) error {
	if _, err := s.db.Exec(schemaBriefing); err != nil {
		return err
	}
	for _, c := range [][3]string{
		{"tickets", "planned_start", "INTEGER NOT NULL DEFAULT 0"},
		{"tickets", "planned_end", "INTEGER NOT NULL DEFAULT 0"},
		{"tickets", "note_title", "TEXT NOT NULL DEFAULT ''"},
		{"projects", "where_left_off", "TEXT NOT NULL DEFAULT ''"},
		{"projects", "where_left_off_at", "INTEGER NOT NULL DEFAULT 0"},
	} {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('`+c[0]+`') WHERE name=?`, c[1]).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if _, err := s.db.Exec(`ALTER TABLE ` + c[0] + ` ADD COLUMN ` + c[1] + ` ` + c[2]); err != nil {
				return err
			}
		}
	}
	return nil
}

// TicketChanges returns the change-log rows of the project with at > since, oldest first.
func (s *Store) TicketChanges(projectID string, since int64) ([]proto.TicketChange, error) {
	rows, err := s.db.Query(`SELECT external_id,kind,from_val,to_val,at FROM ticket_changes WHERE project_id=? AND at>? ORDER BY at, rowid`, projectID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.TicketChange{}
	for rows.Next() {
		var c proto.TicketChange
		if err := rows.Scan(&c.ExternalID, &c.Kind, &c.From, &c.To, &c.At); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ReplaceMeetingNotes makes the stored notes of the project equal to ns (upsert by external id, delete the
// rest) and reports whether anything really changed.
func (s *Store) ReplaceMeetingNotes(projectID string, ns []proto.MeetingNote) (changed bool, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
			changed = false
		}
	}()
	var n int
	if err = tx.QueryRow(`SELECT count(*) FROM projects WHERE id=?`, projectID).Scan(&n); err != nil {
		return false, err
	}
	if n == 0 {
		return false, ErrNotFound
	}
	stored := map[string]proto.MeetingNote{}
	rows, err := tx.Query(`SELECT `+noteCols+` FROM meeting_notes WHERE project_id=?`, projectID)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var m proto.MeetingNote
		if err = rows.Scan(&m.ExternalID, &m.Title, &m.Date, &m.Summary, &m.Decisions, &m.OpenPoints, &m.Actions, &m.URL, &m.UpdatedAt); err != nil {
			rows.Close()
			return false, err
		}
		stored[m.ExternalID] = m
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()
	seen := map[string]bool{}
	for _, m := range ns {
		if m.ExternalID == "" {
			err = fmt.Errorf("meeting note without ExternalID (%q)", m.Title)
			return false, err
		}
		seen[m.ExternalID] = true
		if old, ok := stored[m.ExternalID]; ok && old == m {
			continue
		}
		if _, err = tx.Exec(`INSERT INTO meeting_notes(project_id,`+noteCols+`) VALUES(?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(project_id,external_id) DO UPDATE SET title=excluded.title,date=excluded.date,summary=excluded.summary,
			decisions=excluded.decisions,open_points=excluded.open_points,actions=excluded.actions,url=excluded.url,updated_at=excluded.updated_at`,
			projectID, m.ExternalID, m.Title, m.Date, m.Summary, m.Decisions, m.OpenPoints, m.Actions, m.URL, m.UpdatedAt); err != nil {
			return false, err
		}
		changed = true
	}
	for id := range stored {
		if seen[id] {
			continue
		}
		if _, err = tx.Exec(`DELETE FROM meeting_notes WHERE project_id=? AND external_id=?`, projectID, id); err != nil {
			return false, err
		}
		changed = true
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return changed, nil
}

const noteCols = `external_id,title,date,summary,decisions,open_points,actions,url,updated_at`

// MeetingNotes returns the project's notes dated on or after sinceDate (YYYY-MM-DD; "" for all), newest first.
func (s *Store) MeetingNotes(projectID string, sinceDate string) ([]proto.MeetingNote, error) {
	rows, err := s.db.Query(`SELECT `+noteCols+` FROM meeting_notes WHERE project_id=? AND date>=? ORDER BY date DESC, external_id`, projectID, sinceDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.MeetingNote{}
	for rows.Next() {
		var m proto.MeetingNote
		if err := rows.Scan(&m.ExternalID, &m.Title, &m.Date, &m.Summary, &m.Decisions, &m.OpenPoints, &m.Actions, &m.URL, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Visit records a visit at now. The first visit sets seen_at. A later one moves seen_at to prev_seen_at only when
// the stored seen_at is more than 30 minutes old (rolled = true); otherwise nothing changes, so "new since" stays
// stable while the owner works. It returns the values after the call.
func (s *Store) Visit(projectID string, now int64) (seenAt, prevSeenAt int64, rolled bool, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, false, err
	}
	defer tx.Rollback()
	var n int
	if err = tx.QueryRow(`SELECT count(*) FROM projects WHERE id=?`, projectID).Scan(&n); err != nil {
		return 0, 0, false, err
	}
	if n == 0 {
		return 0, 0, false, ErrNotFound
	}
	err = tx.QueryRow(`SELECT seen_at,prev_seen_at FROM project_visits WHERE project_id=?`, projectID).Scan(&seenAt, &prevSeenAt)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		seenAt, prevSeenAt, rolled = now, 0, true
		_, err = tx.Exec(`INSERT INTO project_visits(project_id,seen_at,prev_seen_at) VALUES(?,?,0)`, projectID, now)
	case err != nil:
		return 0, 0, false, err
	case now-seenAt > visitRolloverMs:
		prevSeenAt, seenAt, rolled = seenAt, now, true
		_, err = tx.Exec(`UPDATE project_visits SET seen_at=?,prev_seen_at=? WHERE project_id=?`, seenAt, prevSeenAt, projectID)
	}
	if err != nil {
		return 0, 0, false, err
	}
	if err = tx.Commit(); err != nil {
		return 0, 0, false, err
	}
	return seenAt, prevSeenAt, rolled, nil
}

// Visits returns the stored visit marks (0, 0 when the project was never visited).
func (s *Store) Visits(projectID string) (seenAt, prevSeenAt int64, err error) {
	err = s.db.QueryRow(`SELECT seen_at,prev_seen_at FROM project_visits WHERE project_id=?`, projectID).Scan(&seenAt, &prevSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	return
}

// AddPinned pins a note to the project. The text is trimmed and must be 1 to 500 runes.
func (s *Store) AddPinned(projectID, text string, now int64) (proto.PinnedNote, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return proto.PinnedNote{}, errors.New("pinned note is empty")
	}
	if utf8.RuneCountInString(text) > maxPinnedRunes {
		return proto.PinnedNote{}, fmt.Errorf("pinned note is over %d characters", maxPinnedRunes)
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM projects WHERE id=?`, projectID).Scan(&n); err != nil {
		return proto.PinnedNote{}, err
	}
	if n == 0 {
		return proto.PinnedNote{}, ErrNotFound
	}
	p := proto.PinnedNote{ID: newID(), Text: text, At: now}
	if _, err := s.db.Exec(`INSERT INTO pinned_notes(id,project_id,text,created_at) VALUES(?,?,?,?)`, p.ID, projectID, p.Text, p.At); err != nil {
		return proto.PinnedNote{}, err
	}
	return p, nil
}

func (s *Store) DeletePinned(projectID, id string) error {
	res, err := s.db.Exec(`DELETE FROM pinned_notes WHERE project_id=? AND id=?`, projectID, id)
	return affected(res, err)
}

// Pinned returns the project's pinned notes, oldest first.
func (s *Store) Pinned(projectID string) ([]proto.PinnedNote, error) {
	rows, err := s.db.Query(`SELECT id,text,created_at FROM pinned_notes WHERE project_id=? ORDER BY created_at, rowid`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.PinnedNote{}
	for rows.Next() {
		var p proto.PinnedNote
		if err := rows.Scan(&p.ID, &p.Text, &p.At); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetWhereLeftOff caches the generated "where you left off" text of the project ("" clears it).
func (s *Store) SetWhereLeftOff(projectID, text string, at int64) error {
	res, err := s.db.Exec(`UPDATE projects SET where_left_off=?,where_left_off_at=? WHERE id=?`, text, at, projectID)
	return affected(res, err)
}

func (s *Store) WhereLeftOff(projectID string) (text string, at int64, err error) {
	err = s.db.QueryRow(`SELECT where_left_off,where_left_off_at FROM projects WHERE id=?`, projectID).Scan(&text, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, ErrNotFound
	}
	return
}
