package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// SaveCommands stores a session's slash-command list. changed is false when the stored hash
// equals hash (the list is kept as is); the first list for a session is always a change.
func (s *Store) SaveCommands(id, hash string, cmds []proto.SessionCommand) (changed bool, err error) {
	if cmds == nil {
		cmds = []proto.SessionCommand{}
	}
	b, err := json.Marshal(cmds)
	if err != nil {
		return false, err
	}
	var old string
	err = s.db.QueryRow(`SELECT hash FROM session_commands WHERE session_id=?`, id).Scan(&old)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if exists && old == hash {
		return false, nil
	}
	_, err = s.db.Exec(`INSERT INTO session_commands(session_id,hash,commands,at) VALUES(?,?,?,?)
		ON CONFLICT(session_id) DO UPDATE SET hash=excluded.hash, commands=excluded.commands, at=excluded.at`,
		id, hash, string(b), time.Now().UnixMilli())
	return err == nil, err
}

// Commands returns the session's stored list; ok is false when none was ever reported.
func (s *Store) Commands(id string) (sc proto.SessionCommands, ok bool, err error) {
	var raw string
	err = s.db.QueryRow(`SELECT hash,commands FROM session_commands WHERE session_id=?`, id).Scan(&sc.Hash, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return sc, false, nil
	}
	if err != nil {
		return sc, false, err
	}
	sc.Session = id
	if err := json.Unmarshal([]byte(raw), &sc.Commands); err != nil {
		return sc, false, err
	}
	if sc.Commands == nil {
		sc.Commands = []proto.SessionCommand{}
	}
	return sc, true, nil
}
