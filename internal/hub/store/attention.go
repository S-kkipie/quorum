package store

import (
	"database/sql"
	"errors"

	"github.com/S-kkipie/quorum/internal/proto"
)

// unreadExpr (alias s) is SessionInfo.Unread: the session is idle and its last turn_end is newer
// than its seen mark. background, working, needs_you and closed sessions are never unread.
const unreadExpr = `(s.state='idle' AND s.end_seq>s.seen_seq)`

// unreadBare is unreadExpr without the alias (UPDATE ... RETURNING cannot use one).
const unreadBare = `(state='idle' AND end_seq>seen_seq)`

// SetSeen moves the session's seen mark to seq, capped at its latest event and never backwards.
// moved is false when the mark did not change (or the session does not exist).
func (s *Store) SetSeen(id string, seq int64) (moved bool, err error) {
	res, err := s.db.Exec(`UPDATE sessions SET seen_seq=MIN(?, (SELECT COALESCE(MAX(seq),0) FROM events WHERE session=?))
		WHERE id=? AND seen_seq<MIN(?, (SELECT COALESCE(MAX(seq),0) FROM events WHERE session=?))`, seq, id, id, seq, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// DoneDue returns the end_seq of the session's unread done when it was not announced yet (0 when none).
func (s *Store) DoneDue(id string) (endSeq int64, err error) {
	err = s.db.QueryRow(`SELECT CASE WHEN `+unreadExpr+` AND s.end_seq>s.attention_end_seq THEN s.end_seq ELSE 0 END
		FROM sessions s WHERE s.id=?`, id).Scan(&endSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return endSeq, err
}

// ClaimDone atomically marks endSeq as announced when it is still the session's last end, unread and
// not announced; true means the caller publishes the attention (once per end_seq). A newer end is not
// claimed here: it has its own grace.
func (s *Store) ClaimDone(id string, endSeq int64) (bool, error) {
	return claimed(s.db.Query(`UPDATE sessions SET attention_end_seq=end_seq
		WHERE id=? AND end_seq=? AND `+unreadBare+` AND end_seq>attention_end_seq RETURNING id`, id, endSeq))
}

// ClaimNeedsYou records the session's needs_you transitions: true (once) when it is in needs_you and
// that was not announced yet. Leaving needs_you for a live state re-arms it; closed keeps the mark,
// so a session that comes back after a drop with the same pending question is not announced again.
func (s *Store) ClaimNeedsYou(id string) (bool, error) {
	if _, err := s.db.Exec(`UPDATE sessions SET needs_you_announced=0 WHERE id=? AND needs_you_announced=1 AND state NOT IN (?,?)`,
		id, string(proto.StateNeedsYou), string(proto.StateClosed)); err != nil {
		return false, err
	}
	return claimed(s.db.Query(`UPDATE sessions SET needs_you_announced=1 WHERE id=? AND needs_you_announced=0 AND state=? RETURNING id`,
		id, string(proto.StateNeedsYou)))
}

func claimed(rows *sql.Rows, err error) (bool, error) {
	if err != nil {
		return false, err
	}
	defer rows.Close()
	ok := rows.Next()
	return ok, rows.Err()
}
