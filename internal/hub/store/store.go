// Package store is the hub's SQLite persistence.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	_ "modernc.org/sqlite"
)

const (
	maxEventsPerSession = 2000
	codeTTL             = 10 * time.Minute
)

// ErrInvalidCode: the code does not exist, was already used or has expired.
var ErrInvalidCode = errors.New("invalid, used or expired code")

type Machine struct {
	Name     string            `json:"name"`
	OS       string            `json:"os"`
	Env      string            `json:"env"`
	Version  string            `json:"version"`
	Online   bool              `json:"online"`
	LastSeen int64             `json:"lastSeen"`
	Caps     proto.MachineCaps `json:"caps"`
}

type Device struct {
	Name      string
	CreatedAt int64
}

// Store is safe for concurrent use: a single connection serializes everything.
type Store struct {
	db      *sql.DB
	now     func() time.Time
	genCode func() (string, error)
}

func Open(path string) (*Store, error) {
	dsn := "file:" + escapeDSNPath(path) + "?"
	if path == ":memory:" {
		dsn = "file::memory:?"
	}
	// _txlock=immediate: transactions take the write lock when they start and so
	// honor busy_timeout. With a deferred BEGIN, going from read to write while another
	// process is writing (quorum-hub pair/link-code alongside serve) gives SQLITE_BUSY instantly.
	dsn += "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// A single connection that is never dropped: serializes writes and keeps the ":memory:" DB alive.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	s := &Store{db: db, now: time.Now, genCode: randomCode}
	if err := migrate(s); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// escapeDSNPath escapes what SQLite interprets in a file: URI ('%', '?', '#'),
// so a path with those characters is not cut off or decoded wrongly.
func escapeDSNPath(p string) string {
	return strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(p)
}

func randomCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *Store) Close() error { return s.db.Close() }

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) UpsertMachine(name, os, env, version string, online bool, caps proto.MachineCaps) error {
	cj, _ := json.Marshal(caps)
	_, err := s.db.Exec(`INSERT INTO machines(name,os,env,version,online,last_seen,caps) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(name) DO UPDATE SET os=excluded.os, env=excluded.env, version=excluded.version,
		online=excluded.online, last_seen=excluded.last_seen, caps=excluded.caps`,
		name, os, env, version, b2i(online), s.now().UnixMilli(), string(cj))
	return err
}

// SetMachineCaps updates only the capabilities of an already registered machine.
func (s *Store) SetMachineCaps(name string, caps proto.MachineCaps) error {
	cj, _ := json.Marshal(caps)
	_, err := s.db.Exec(`UPDATE machines SET caps=? WHERE name=?`, string(cj), name)
	return err
}

func (s *Store) ListMachines() ([]Machine, error) {
	rows, err := s.db.Query(`SELECT name,os,env,version,online,last_seen,caps FROM machines ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Machine
	for rows.Next() {
		var m Machine
		var on int
		var caps string
		if err := rows.Scan(&m.Name, &m.OS, &m.Env, &m.Version, &on, &m.LastSeen, &caps); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(caps), &m.Caps) // empty or corrupt: everything false
		m.Online = on != 0
		out = append(out, m)
	}
	return out, rows.Err()
}

// ErrNotOwner: the session already belongs to another machine.
var ErrNotOwner = errors.New("the session belongs to another machine")

func ownedByOther(tx *sql.Tx, id, machine string) (bool, error) {
	var owner string
	err := tx.QueryRow(`SELECT machine FROM sessions WHERE id=?`, id).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return owner != machine, err
}

// UpsertSession saves the session; returns ErrNotOwner if the id (or PreviousID)
// already exists and belongs to another machine. See SaveSession.
func (s *Store) UpsertSession(si proto.SessionInfo) error {
	_, err := s.SaveSession(si)
	return err
}

func sessionState(tx *sql.Tx, id string) (state string, exists bool, err error) {
	err = tx.QueryRow(`SELECT state FROM sessions WHERE id=?`, id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return state, err == nil, err
}

// SaveSession saves the session and returns the PreviousID that was actually applied ("" if
// none). A PreviousID is ignored when both it and the id are still alive (not
// closed): the rename already happened and the old id came back on its own (e.g.
// `claude --resume A` after a /clear A→B); reapplying it would merge two live sessions.
// When a live session is saved, the previous_id of the rows that pointed to
// it is cleared: that id is no longer replaced.
func (s *Store) SaveSession(si proto.SessionInfo) (applied string, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	var other bool
	if other, err = ownedByOther(tx, si.ID, si.Machine); err != nil {
		return "", err
	} else if other {
		err = ErrNotOwner
		return "", err
	}
	prev := si.PreviousID
	if prev == si.ID {
		prev = ""
	}
	if prev != "" {
		prevState, prevExists, e := sessionState(tx, prev)
		if e != nil {
			err = e
			return "", err
		}
		idState, idExists, e := sessionState(tx, si.ID)
		if e != nil {
			err = e
			return "", err
		}
		live := func(st string) bool { return st != string(proto.StateClosed) }
		if prevExists && live(prevState) && idExists && live(idState) {
			prev = "" // old rename: both live separately
		}
	}
	if prev != "" {
		if other, err = ownedByOther(tx, prev, si.Machine); err != nil {
			return "", err
		} else if other {
			err = ErrNotOwner
			return "", err
		}
		if err = renameSession(tx, prev, si.ID); err != nil {
			return "", err
		}
	}
	var res sql.Result
	pluginsJSON, _ := json.Marshal(append([]string{}, si.Plugins...))
	tokensJSON, _ := json.Marshal(si.Tokens)
	// previous_id persists the latest rename (/clear, /resume) so an app that
	// was disconnected sees it in the snapshot or the REST API; an empty one does not clear it.
	// An empty recap does not clear the stored one either (upsert without a recap yet), except in a
	// rename (/clear): the moved row is the previous conversation's.
	// launch_req and the herdr pane are always replaced: the live process sends them.
	res, err = tx.Exec(`INSERT INTO sessions(id,machine,name,cwd,root,model,role,state,context_pct,started_at,updated_at,previous_id,recap,
		launch_req,herdr_pane,herdr_workspace,account,account_key,config_dir,plugins,context_estimate,tokens,images_dir)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET machine=excluded.machine, name=excluded.name, cwd=excluded.cwd,
		root=excluded.root, model=excluded.model, role=excluded.role, state=excluded.state,
		context_pct=excluded.context_pct, started_at=excluded.started_at, updated_at=excluded.updated_at,
		launch_req=excluded.launch_req, herdr_pane=excluded.herdr_pane, herdr_workspace=excluded.herdr_workspace,
		account=CASE WHEN excluded.account<>'' THEN excluded.account ELSE sessions.account END,
		account_key=CASE WHEN excluded.account_key<>'' THEN excluded.account_key ELSE sessions.account_key END,
		config_dir=CASE WHEN excluded.config_dir<>'' THEN excluded.config_dir ELSE sessions.config_dir END,
		plugins=CASE WHEN excluded.plugins<>'[]' THEN excluded.plugins ELSE sessions.plugins END,
		context_estimate=excluded.context_estimate, tokens=excluded.tokens, images_dir=excluded.images_dir,
		recap=CASE WHEN excluded.recap<>'' OR ? THEN excluded.recap ELSE sessions.recap END,
		previous_id=CASE WHEN excluded.previous_id<>'' THEN excluded.previous_id ELSE sessions.previous_id END
		WHERE sessions.machine=excluded.machine`,
		si.ID, si.Machine, si.Name, si.Cwd, si.Root, si.Model, string(si.Role), string(si.State),
		si.ContextPct, si.StartedAt, si.UpdatedAt, prev, si.Recap, si.LaunchReq, si.HerdrPane, si.HerdrWorkspace,
		si.Account, si.AccountKey, si.ConfigDir, string(pluginsJSON), b2i(si.ContextEstimate), string(tokensJSON), si.ImagesDir, prev != "")
	if err != nil {
		return "", err
	}
	if n, e := res.RowsAffected(); e == nil && n == 0 {
		err = ErrNotOwner // the upsert's WHERE rejected the other owner
		return "", err
	}
	if si.State == proto.StateClosed {
		if _, err = tx.Exec(`UPDATE sessions SET closed_at=? WHERE id=? AND closed_at=0`, time.Now().UnixMilli(), si.ID); err != nil {
			return "", err
		}
	} else {
		if _, err = tx.Exec(`UPDATE sessions SET closed_at=0 WHERE id=?`, si.ID); err != nil {
			return "", err
		}
		if _, err = tx.Exec(`UPDATE sessions SET previous_id='' WHERE previous_id=? AND id<>?`, si.ID, si.ID); err != nil {
			return "", err
		}
	}
	if err = tx.Commit(); err != nil {
		return "", err
	}
	return prev, nil
}

// renameSession moves the session and its events from old to nw. If nw already exists, it merges:
// old's events end up before nw's.
func renameSession(tx *sql.Tx, old, nw string) error {
	var n int
	if err := tx.QueryRow(`SELECT count(*) FROM sessions WHERE id=?`, old).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		if _, err := tx.Exec(`DELETE FROM sessions WHERE id=?`, nw); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE sessions SET id=? WHERE id=?`, nw, old); err != nil {
			return err
		}
		if err := moveSessionLinks(tx, old, nw); err != nil {
			return err
		}
	}
	var oldMax, oldN int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(MAX(seq),0),0), COUNT(*) FROM events WHERE session=?`, old).Scan(&oldMax, &oldN); err != nil {
		return err
	}
	if oldN == 0 {
		return nil
	}
	// The backfilled history (negative seq) of the new id is discarded: the old one's wins.
	if _, err := tx.Exec(`DELETE FROM events WHERE session=? AND seq<0`, nw); err != nil {
		return err
	}
	// Shifts the new id's events past the old one's positive maximum
	// (in two steps to avoid clashing with the PK). None ends up at seq 0.
	if _, err := tx.Exec(`UPDATE events SET seq=-(seq+?) WHERE session=?`, oldMax, nw); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE events SET seq=-seq WHERE session=? AND seq<0`, nw); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE events SET session=? WHERE session=?`, nw, old)
	return err
}

// moveSessionLinks moves the ticket links (and dismissals) from old to nw.
// On conflict the confirmed one wins; if both had a different confirmed one, nw's stays.
func moveSessionLinks(tx *sql.Tx, old, nw string) error {
	var keep string
	if err := tx.QueryRow(`SELECT COALESCE(MIN(ticket_id),'') FROM session_tickets WHERE session_id=? AND confirmed=1`, nw).Scan(&keep); err != nil {
		return err
	}
	for _, q := range []string{
		`INSERT INTO session_tickets(session_id,ticket_id,confirmed) SELECT ?,ticket_id,confirmed FROM session_tickets WHERE session_id=?
			ON CONFLICT(session_id,ticket_id) DO UPDATE SET confirmed=MAX(session_tickets.confirmed,excluded.confirmed)`,
		`INSERT OR IGNORE INTO session_ticket_dismissed(session_id,ticket_id) SELECT ?,ticket_id FROM session_ticket_dismissed WHERE session_id=?`,
	} {
		if _, err := tx.Exec(q, nw, old); err != nil {
			return err
		}
	}
	for _, q := range []string{`DELETE FROM session_tickets WHERE session_id=?`, `DELETE FROM session_ticket_dismissed WHERE session_id=?`} {
		if _, err := tx.Exec(q, old); err != nil {
			return err
		}
	}
	if keep != "" {
		if _, err := tx.Exec(`UPDATE session_tickets SET confirmed=0 WHERE session_id=? AND ticket_id<>?`, nw, keep); err != nil {
			return err
		}
	}
	return nil
}

// sessionCols: columns of a session (alias s). previous_id comes out empty if that id
// exists alive again: the rename no longer applies and the apps must not follow it.
const sessionCols = `s.id,s.machine,s.name,s.cwd,s.root,s.model,s.role,s.state,s.context_pct,s.started_at,s.updated_at,
	CASE WHEN s.previous_id<>'' AND EXISTS(SELECT 1 FROM sessions p WHERE p.id=s.previous_id AND p.state<>'closed') THEN '' ELSE s.previous_id END,s.recap,
	COALESCE((SELECT c.repo_url FROM checkouts c WHERE c.machine=s.machine AND c.root=s.root),''),
	COALESCE((SELECT c.branch FROM checkouts c WHERE c.machine=s.machine AND c.root=s.root),''),
	COALESCE((SELECT c.project_id FROM checkouts c WHERE c.machine=s.machine AND c.root=s.root),''),
	s.launch_req,s.herdr_pane,s.herdr_workspace,
	s.account,s.account_key,s.config_dir,s.plugins,s.context_estimate,s.tokens,s.images_dir`

// scanDest returns the Scan destinations for sessionCols; finish must run after a successful Scan.
func scanDest(si *proto.SessionInfo, role, state, plugins, tokens *string, ctxEst *int) []any {
	return []any{&si.ID, &si.Machine, &si.Name, &si.Cwd, &si.Root, &si.Model, role, state,
		&si.ContextPct, &si.StartedAt, &si.UpdatedAt, &si.PreviousID, &si.Recap, &si.RepoURL, &si.Branch, &si.ProjectID,
		&si.LaunchReq, &si.HerdrPane, &si.HerdrWorkspace,
		&si.Account, &si.AccountKey, &si.ConfigDir, plugins, ctxEst, tokens, &si.ImagesDir}
}

func finishSession(si *proto.SessionInfo, role, state, plugins, tokens string, ctxEst int) {
	si.Role, si.State = proto.Role(role), proto.SessionState(state)
	si.ContextEstimate = ctxEst != 0
	si.Plugins = []string{}
	_ = json.Unmarshal([]byte(plugins), &si.Plugins)
	if si.Plugins == nil {
		si.Plugins = []string{}
	}
	_ = json.Unmarshal([]byte(tokens), &si.Tokens)
	si.RateLimits = []proto.RateLimit{} // usage lives in account_usage, not on the session
}

func (s *Store) ListSessions(includeClosed bool) ([]proto.SessionInfo, error) {
	q := `SELECT ` + sessionCols + ` FROM sessions s`
	if !includeClosed {
		q += ` WHERE s.state<>'closed'`
	}
	q += ` ORDER BY s.updated_at DESC, s.id`
	rows, err := s.db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []proto.SessionInfo
	for rows.Next() {
		var si proto.SessionInfo
		var role, state, plugins, tokens string
		var ctxEst int
		if err := rows.Scan(scanDest(&si, &role, &state, &plugins, &tokens, &ctxEst)...); err != nil {
			return nil, err
		}
		finishSession(&si, role, state, plugins, tokens, ctxEst)
		out = append(out, si)
	}
	return out, rows.Err()
}

// MarkMachineSessionsClosed closes the machine's open sessions and returns their ids.
func (s *Store) MarkMachineSessionsClosed(machine string) ([]string, error) {
	return s.CloseMachineSessionsExcept(machine, nil)
}

// MarkAllMachinesOffline marks all machines offline (hub startup:
// each one comes back online with its hello).
func (s *Store) MarkAllMachinesOffline() error {
	_, err := s.db.Exec(`UPDATE machines SET online=0`)
	return err
}

// AppendEvent stores e with the next Seq of its session and returns that Seq.
// assistant_delta events are not persisted (returns 0).
func (s *Store) AppendEvent(e proto.Event) (seq int64, err error) {
	if e.Kind == proto.KindAssistantDelta {
		return 0, nil
	}
	data := string(e.Data)
	if data == "" {
		data = "null"
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	if err = tx.QueryRow(`SELECT MAX(COALESCE(MAX(seq),0),0)+1 FROM events WHERE session=?`, e.Session).Scan(&seq); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(`INSERT INTO events(session,seq,ts,kind,data) VALUES(?,?,?,?,?)`,
		e.Session, seq, e.TS, string(e.Kind), data); err != nil {
		return 0, err
	}
	if e.Kind == proto.KindUser {
		if _, err = tx.Exec(`UPDATE sessions SET prompted=1 WHERE id=?`, e.Session); err != nil {
			return 0, err
		}
	}
	if _, err = tx.Exec(`DELETE FROM events WHERE session=? AND seq<=?`, e.Session, seq-maxEventsPerSession); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return seq, nil
}

// PrependEvents stores evs before the session's existing events, with ascending
// negative Seq (-n..-1; AppendEvent only assigns positive ones). If the session
// already has negative Seq the history was already backfilled and it does nothing.
func (s *Store) PrependEvents(session string, evs []proto.Event) (inserted bool, err error) {
	if len(evs) == 0 {
		return false, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	var neg int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM events WHERE session=? AND seq<0`, session).Scan(&neg); err != nil {
		return false, err
	}
	if neg > 0 {
		return false, tx.Commit()
	}
	n := int64(len(evs))
	for _, e := range evs {
		if e.Kind == proto.KindUser {
			if _, err = tx.Exec(`UPDATE sessions SET prompted=1 WHERE id=?`, session); err != nil {
				return false, err
			}
			break
		}
	}
	for i, e := range evs {
		data := string(e.Data)
		if data == "" {
			data = "null"
		}
		if _, err = tx.Exec(`INSERT INTO events(session,seq,ts,kind,data) VALUES(?,?,?,?,?)`,
			session, int64(i)-n, e.TS, string(e.Kind), data); err != nil {
			return false, err
		}
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// Events returns up to limit events with Seq < beforeSeq (0 = no cap; backfilled history has negative Seq), newest first.
func (s *Store) Events(session string, beforeSeq int64, limit int) ([]proto.Event, error) {
	q := `SELECT seq,session,ts,kind,data FROM events WHERE session=?`
	args := []any{session}
	if beforeSeq != 0 {
		q += ` AND seq<?`
		args = append(args, beforeSeq)
	}
	q += ` ORDER BY seq DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []proto.Event
	for rows.Next() {
		var e proto.Event
		var kind, data string
		if err := rows.Scan(&e.Seq, &e.Session, &e.TS, &kind, &data); err != nil {
			return nil, err
		}
		e.Kind, e.Data = proto.EventKind(kind), json.RawMessage(data)
		out = append(out, e)
	}
	return out, rows.Err()
}

// CreateCode generates a single-use 6-digit code, valid for 10 minutes.
func (s *Store) CreateCode(kind string) (string, error) {
	now := s.now()
	if _, err := s.db.Exec(`DELETE FROM codes WHERE expires_at<?`, now.UnixMilli()); err != nil {
		return "", err
	}
	for i := 0; i < 5; i++ {
		code, err := s.genCode()
		if err != nil {
			return "", err
		}
		res, err := s.db.Exec(`INSERT INTO codes(kind,code,expires_at,used) VALUES(?,?,?,0)
			ON CONFLICT(kind,code) DO NOTHING`, kind, code, now.Add(codeTTL).UnixMilli())
		if err != nil {
			return "", err
		}
		if n, err := res.RowsAffected(); err != nil {
			return "", err
		} else if n == 1 {
			return code, nil
		}
		// clash with a live or used code: retry with another
	}
	return "", errors.New("could not generate a free code")
}

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func (s *Store) ConsumeCode(kind, code string) error { return s.consumeCode(s.db, kind, code) }

func (s *Store) consumeCode(db execer, kind, code string) error {
	res, err := db.Exec(`UPDATE codes SET used=1 WHERE kind=? AND code=? AND used=0 AND expires_at>=?`,
		kind, code, s.now().UnixMilli())
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrInvalidCode
	}
	return nil
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (s *Store) AddToken(kind, name, token string) error { return s.addToken(s.db, kind, name, token) }

func (s *Store) addToken(db execer, kind, name, token string) error {
	_, err := db.Exec(`INSERT INTO tokens(kind,name,hash,created_at) VALUES(?,?,?,?)
		ON CONFLICT(kind,name) DO UPDATE SET hash=excluded.hash, created_at=excluded.created_at`,
		kind, name, hashToken(token), s.now().UnixMilli())
	return err
}

func (s *Store) CheckToken(kind, token string) (string, bool) {
	var name string
	err := s.db.QueryRow(`SELECT name FROM tokens WHERE kind=? AND hash=?`, kind, hashToken(token)).Scan(&name)
	return name, err == nil
}

// ErrNotFound says the requested token (device or machine) does not exist.
var ErrNotFound = errors.New("not found")

func (s *Store) RevokeToken(kind, name string) error {
	res, err := s.db.Exec(`DELETE FROM tokens WHERE kind=? AND name=?`, kind, name)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrNotFound
	}
	return nil
}

// AddUniqueDeviceToken stores a device's token without overwriting another:
// if the name exists it uses "name (2)", "name (3)"... and returns the final one.
func (s *Store) AddUniqueDeviceToken(name, token string) (string, error) {
	return s.addUniqueDeviceToken(s.db, name, token)
}

func (s *Store) addUniqueDeviceToken(db execer, name, token string) (string, error) {
	for i := 1; i < 10000; i++ {
		cand := name
		if i > 1 {
			cand = fmt.Sprintf("%s (%d)", name, i)
		}
		res, err := db.Exec(`INSERT INTO tokens(kind,name,hash,created_at) VALUES('device',?,?,?)
			ON CONFLICT(kind,name) DO NOTHING`, cand, hashToken(token), s.now().UnixMilli())
		if err != nil {
			return "", err
		}
		if n, err := res.RowsAffected(); err != nil {
			return "", err
		} else if n == 1 {
			return cand, nil
		}
	}
	return "", errors.New("could not assign a unique name")
}

// Pair consumes the code and stores the token in a single transaction: if storing the
// token fails, the code stays unused. For tokKind "device" the name is made
// unique (see AddUniqueDeviceToken); returns the final name.
func (s *Store) Pair(codeKind, code, tokKind, name, token string) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if err := s.consumeCode(tx, codeKind, code); err != nil {
		return "", err
	}
	if tokKind == "device" {
		name, err = s.addUniqueDeviceToken(tx, name, token)
	} else {
		err = s.addToken(tx, tokKind, name, token)
	}
	if err != nil {
		return "", err
	}
	return name, tx.Commit()
}

// LiveSessionIDs returns the set of existing, non-closed sessions.
func (s *Store) LiveSessionIDs() (map[string]bool, error) {
	rows, err := s.db.Query(`SELECT id FROM sessions WHERE state<>'closed'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Store) ListDevices() ([]Device, error) {
	rows, err := s.db.Query(`SELECT name,created_at FROM tokens WHERE kind='device' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.Name, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// CloseSession closes session id, only if it belongs to machine. A session that
// never received a user prompt is deleted instead (removed=true).
func (s *Store) CloseSession(machine, id string) (removed bool, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var one int
	err = tx.QueryRow(`SELECT 1 FROM sessions WHERE id=? AND machine=?`, id, machine).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	removed, err = closeOrRemove(tx, id)
	if err != nil {
		return false, err
	}
	return removed, tx.Commit()
}

// closeOrRemove deletes session id with its rows if it was never prompted and is not
// linked to a ticket, else marks it closed. The hub row is only a cache: a resumed
// conversation whose earlier prompts predate Quorum and that closes without a new prompt
// is removed here, but the daemon's conversation list still shows it and it stays resumable.
func closeOrRemove(tx *sql.Tx, id string) (bool, error) {
	var prompted, linked, userEvents int
	if err := tx.QueryRow(`SELECT prompted FROM sessions WHERE id=?`, id).Scan(&prompted); err != nil {
		return false, err
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM session_tickets WHERE session_id=?`, id).Scan(&linked); err != nil {
		return false, err
	}
	// Fallback for a prompt that arrived before the session row existed.
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM events WHERE session=? AND kind=?)`, id, string(proto.KindUser)).Scan(&userEvents); err != nil {
		return false, err
	}
	if prompted > 0 || linked > 0 || userEvents > 0 {
		_, err := tx.Exec(`UPDATE sessions SET state=?, closed_at=? WHERE id=?`, string(proto.StateClosed), time.Now().UnixMilli(), id)
		return false, err
	}
	for _, q := range []string{
		`DELETE FROM events WHERE session=?`,
		`DELETE FROM away WHERE session=?`,
		`DELETE FROM session_tickets WHERE session_id=?`,
		`DELETE FROM session_ticket_dismissed WHERE session_id=?`,
		`DELETE FROM sessions WHERE id=?`,
	} {
		if _, err := tx.Exec(q, id); err != nil {
			return false, err
		}
	}
	return true, nil
}

// HasReadOf reports whether the session's stored events include a Read tool_start whose
// input file_path is exactly path and whose tool_end (same id, same session) succeeded: a denied
// or failed Read, or one with no tool_end, does not count.
func (s *Store) HasReadOf(sessionID, path string) (bool, error) {
	if sessionID == "" || path == "" {
		return false, nil
	}
	var ok bool
	err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM events s WHERE s.session=? AND s.kind=?
		AND CASE WHEN json_valid(s.data) THEN json_extract(s.data,'$.name')='Read'
			AND json_extract(s.data,'$.input.file_path')=? AND COALESCE(json_extract(s.data,'$.id'),'')<>''
			AND EXISTS(SELECT 1 FROM events e WHERE e.session=s.session AND e.kind=?
				AND CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.id')=json_extract(s.data,'$.id')
					AND json_extract(e.data,'$.ok')=1 ELSE 0 END)
			ELSE 0 END)`,
		sessionID, string(proto.KindToolStart), path, string(proto.KindToolEnd)).Scan(&ok)
	return ok, err
}

// SessionOwner returns the machine that owns session id (ok=false if it does not exist).
func (s *Store) SessionOwner(id string) (machine string, ok bool, err error) {
	err = s.db.QueryRow(`SELECT machine FROM sessions WHERE id=?`, id).Scan(&machine)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return machine, err == nil, err
}

// CloseMachineSessionsExcept closes the machine's non-closed sessions that are not
// in keep and returns the ids it closed. It never deletes: only an explicit daemon session_gone
// removes a session that never received a prompt (CloseSession).
func (s *Store) CloseMachineSessionsExcept(machine string, keep []string) ([]string, error) {
	q := `UPDATE sessions SET state=?, closed_at=? WHERE machine=? AND state<>?`
	args := []any{string(proto.StateClosed), time.Now().UnixMilli(), machine, string(proto.StateClosed)}
	if len(keep) > 0 {
		q += ` AND id NOT IN (?` + strings.Repeat(`,?`, len(keep)-1) + `)`
		for _, id := range keep {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q+` RETURNING id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Session returns session id, or ErrNotFound if it does not exist.
func (s *Store) Session(id string) (proto.SessionInfo, error) {
	var si proto.SessionInfo
	var role, state, plugins, tokens string
	var ctxEst int
	err := s.db.QueryRow(`SELECT `+sessionCols+` FROM sessions s WHERE s.id=?`, id).
		Scan(scanDest(&si, &role, &state, &plugins, &tokens, &ctxEst)...)
	if errors.Is(err, sql.ErrNoRows) {
		return si, ErrNotFound
	}
	if err == nil {
		finishSession(&si, role, state, plugins, tokens, ctxEst)
	}
	return si, err
}

// OpenAsks returns askId -> session of the ask events of non-closed sessions
// that have no later ask_resolved.
func (s *Store) OpenAsks() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT e.session,e.kind,e.data FROM events e JOIN sessions s ON s.id=e.session
		WHERE s.state<>'closed' AND e.kind IN ('ask','ask_resolved') ORDER BY e.session,e.seq`)
	if err != nil {
		return nil, err
	}
	return scanOpenAsks(rows)
}

// SessionOpenAsks returns the open askIds (without a later ask_resolved) of a session.
func (s *Store) SessionOpenAsks(session string) (map[string]string, error) {
	rows, err := s.db.Query(`SELECT session,kind,data FROM events
		WHERE session=? AND kind IN ('ask','ask_resolved') ORDER BY seq`, session)
	if err != nil {
		return nil, err
	}
	return scanOpenAsks(rows)
}

func scanOpenAsks(rows *sql.Rows) (map[string]string, error) {
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var session, kind, data string
		if err := rows.Scan(&session, &kind, &data); err != nil {
			return nil, err
		}
		var a struct {
			AskID string `json:"askId"`
		}
		if json.Unmarshal([]byte(data), &a) != nil || a.AskID == "" {
			continue
		}
		if kind == string(proto.KindAsk) {
			out[a.AskID] = session
		} else {
			delete(out, a.AskID)
		}
	}
	return out, rows.Err()
}

// TerminalAuditRow is a row of the terminal audit.
type TerminalAuditRow struct {
	At                            int64
	Device, Machine, Pane, Action string
}

// AuditTerminal records who opened or closed a terminal pane.
func (s *Store) AuditTerminal(device, machine, pane, action string) error {
	_, err := s.db.Exec(`INSERT INTO terminal_audit(at, device, machine, pane, action) VALUES(?,?,?,?,?)`,
		time.Now().UnixMilli(), device, machine, pane, action)
	return err
}

// ListTerminalAudit returns the audit in insertion order.
func (s *Store) ListTerminalAudit() ([]TerminalAuditRow, error) {
	rows, err := s.db.Query(`SELECT at, device, machine, pane, action FROM terminal_audit ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TerminalAuditRow
	for rows.Next() {
		var r TerminalAuditRow
		if err := rows.Scan(&r.At, &r.Device, &r.Machine, &r.Pane, &r.Action); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
