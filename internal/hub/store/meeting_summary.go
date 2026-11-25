package store

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

// Meta returns a hub-wide setting ("" when unset).
func (s *Store) Meta(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetMeta stores a hub-wide setting ("" deletes it).
func (s *Store) SetMeta(key, value string) error {
	if value == "" {
		_, err := s.db.Exec(`DELETE FROM meta WHERE key=?`, key)
		return err
	}
	_, err := s.db.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// SetMeetingSpeakers merges names into the meeting's speaker names ({label: name}; "" removes the name).
func (s *Store) SetMeetingSpeakers(id string, names map[string]string) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	var n int
	if err = tx.QueryRow(`SELECT count(*) FROM meetings WHERE id=?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		err = ErrNotFound
		return err
	}
	for label, name := range names {
		if name == "" {
			_, err = tx.Exec(`DELETE FROM meeting_speakers WHERE meeting_id=? AND label=?`, id, label)
		} else {
			_, err = tx.Exec(`INSERT INTO meeting_speakers(meeting_id,label,name) VALUES(?,?,?)
				ON CONFLICT(meeting_id,label) DO UPDATE SET name=excluded.name`, id, label, name)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetMeetingProvider records the summary provider of the meeting's current summary.
func (s *Store) SetMeetingProvider(id, provider string) error {
	return affected(s.db.Exec(`UPDATE meetings SET provider=?, updated_at=? WHERE id=?`, provider, s.now().UnixMilli(), id))
}

// SetMeetingTitleIfEmpty gives an untitled meeting a title (the summary's).
func (s *Store) SetMeetingTitleIfEmpty(id, title string) error {
	_, err := s.db.Exec(`UPDATE meetings SET title=?, updated_at=? WHERE id=? AND title=''`, title, s.now().UnixMilli(), id)
	return err
}

// MeetingActions returns the meeting's actions in order.
func (s *Store) MeetingActions(id string) ([]proto.MeetingAction, error) {
	rows, err := s.db.Query(`SELECT id,text,owner,due,mine,ts_ms,issue_url FROM meeting_actions WHERE meeting_id=? ORDER BY idx, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []proto.MeetingAction
	for rows.Next() {
		var a proto.MeetingAction
		if err := rows.Scan(&a.ID, &a.Text, &a.Owner, &a.Due, &a.Mine, &a.TsMs, &a.IssueURL); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// MeetingAction returns one action of the meeting, or ErrNotFound.
func (s *Store) MeetingAction(meetingID, actionID string) (proto.MeetingAction, error) {
	var a proto.MeetingAction
	err := s.db.QueryRow(`SELECT id,text,owner,due,mine,ts_ms,issue_url FROM meeting_actions WHERE meeting_id=? AND id=?`, meetingID, actionID).
		Scan(&a.ID, &a.Text, &a.Owner, &a.Due, &a.Mine, &a.TsMs, &a.IssueURL)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// ReplaceMeetingActions makes the meeting's actions the ones that have an issue (kept as they are, first)
// followed by acts, each with a new id. An action of acts with the same text as a kept one is dropped, so
// a re-summary does not list an action twice next to its issue.
func (s *Store) ReplaceMeetingActions(id string, acts []proto.MeetingAction) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	if _, err = tx.Exec(`DELETE FROM meeting_actions WHERE meeting_id=? AND issue_url=''`, id); err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT id,text FROM meeting_actions WHERE meeting_id=? ORDER BY idx, id`, id)
	if err != nil {
		return err
	}
	var keptIDs []string
	kept := map[string]bool{}
	for rows.Next() {
		var aid, text string
		if err = rows.Scan(&aid, &text); err != nil {
			rows.Close()
			return err
		}
		keptIDs = append(keptIDs, aid)
		kept[normAction(text)] = true
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for i, aid := range keptIDs {
		if _, err = tx.Exec(`UPDATE meeting_actions SET idx=? WHERE meeting_id=? AND id=?`, i, id, aid); err != nil {
			return err
		}
	}
	idx := len(keptIDs)
	for _, a := range acts {
		if kept[normAction(a.Text)] {
			continue
		}
		if _, err = tx.Exec(`INSERT INTO meeting_actions(meeting_id,id,idx,text,owner,due,mine,ts_ms,issue_url) VALUES(?,?,?,?,?,?,?,?,'')`,
			id, newID(), idx, a.Text, a.Owner, a.Due, a.Mine, a.TsMs); err != nil {
			return err
		}
		idx++
	}
	return tx.Commit()
}

func normAction(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }

// SetMeetingActionsMine stores which actions are the owner's ({action id: mine}).
func (s *Store) SetMeetingActionsMine(id string, mine map[string]bool) error {
	for aid, m := range mine {
		if _, err := s.db.Exec(`UPDATE meeting_actions SET mine=? WHERE meeting_id=? AND id=?`, m, id, aid); err != nil {
			return err
		}
	}
	return nil
}

// SetMeetingActionIssue records the action's issue URL unless it already has one; ok is false then (the
// URL stored first wins).
func (s *Store) SetMeetingActionIssue(meetingID, actionID, url string) (ok bool, err error) {
	res, err := s.db.Exec(`UPDATE meeting_actions SET issue_url=? WHERE meeting_id=? AND id=? AND issue_url=''`, url, meetingID, actionID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
