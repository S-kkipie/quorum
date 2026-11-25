package store

import (
	"database/sql"
	"errors"
)

// Upload is a file a device attached to a message of a session, saved on the session's machine.
type Upload struct {
	SessionID string `json:"sessionId"`
	Path      string `json:"path"`
	Name      string `json:"name"`
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`
	At        int64  `json:"at"`
}

// AddUpload records a file uploaded for a session (the same path again replaces the row).
func (s *Store) AddUpload(u Upload) error {
	if u.At == 0 {
		u.At = s.now().UnixMilli()
	}
	_, err := s.db.Exec(`INSERT INTO session_uploads(session_id,path,name,mime,size,at) VALUES(?,?,?,?,?,?)
		ON CONFLICT(session_id,path) DO UPDATE SET name=excluded.name, mime=excluded.mime, size=excluded.size, at=excluded.at`,
		u.SessionID, u.Path, u.Name, u.Mime, u.Size, u.At)
	return err
}

// UploadOf returns the upload recorded for the session at exactly path (ok=false if none).
func (s *Store) UploadOf(sessionID, path string) (Upload, bool, error) {
	u := Upload{SessionID: sessionID, Path: path}
	if sessionID == "" || path == "" {
		return u, false, nil
	}
	err := s.db.QueryRow(`SELECT name,mime,size,at FROM session_uploads WHERE session_id=? AND path=?`, sessionID, path).
		Scan(&u.Name, &u.Mime, &u.Size, &u.At)
	if errors.Is(err, sql.ErrNoRows) {
		return u, false, nil
	}
	return u, err == nil, err
}

// PruneUploads forgets the uploads recorded before cutoff (the machines delete those files after 30 days).
func (s *Store) PruneUploads(cutoff int64) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM session_uploads WHERE at<?`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
