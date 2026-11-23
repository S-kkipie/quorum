// Package store es la persistencia SQLite del hub.
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

// ErrInvalidCode: el código no existe, ya se usó o venció.
var ErrInvalidCode = errors.New("código inválido, usado o vencido")

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

// Store es seguro para uso concurrente: una única conexión serializa todo.
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
	// _txlock=immediate: las transacciones toman el candado de escritura al empezar y así
	// respetan busy_timeout. Con BEGIN diferido, pasar de lectura a escritura con otro
	// proceso escribiendo (quorum-hub pair/link-code junto a serve) da SQLITE_BUSY al instante.
	dsn += "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// Una sola conexión que nunca se descarta: serializa escrituras y mantiene viva la BD ":memory:".
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

// escapeDSNPath escapa lo que SQLite interpreta en una URI file: ('%', '?', '#'),
// para que una ruta con esos caracteres no se corte ni se decodifique mal.
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

// SetMachineCaps actualiza solo las capacidades de una máquina ya registrada.
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
		_ = json.Unmarshal([]byte(caps), &m.Caps) // vacío o dañado: todo en false
		m.Online = on != 0
		out = append(out, m)
	}
	return out, rows.Err()
}

// ErrNotOwner: la sesión ya pertenece a otra máquina.
var ErrNotOwner = errors.New("la sesión pertenece a otra máquina")

func ownedByOther(tx *sql.Tx, id, machine string) (bool, error) {
	var owner string
	err := tx.QueryRow(`SELECT machine FROM sessions WHERE id=?`, id).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return owner != machine, err
}

// UpsertSession guarda la sesión; devuelve ErrNotOwner si el id (o PreviousID)
// ya existe y pertenece a otra máquina. Ver SaveSession.
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

// SaveSession guarda la sesión y devuelve el PreviousID que de verdad aplicó ("" si
// ninguno). Un PreviousID se ignora cuando tanto él como el id siguen vivos (no
// cerrados): el renombre ya ocurrió y el id viejo volvió por su cuenta (p. ej.
// `claude --resume A` tras un /clear A→B); reaplicarlo fusionaría dos sesiones vivas.
// Al guardar una sesión viva se borra el previous_id de las filas que apuntaban a
// ella: ese id ya no está reemplazado.
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
			prev = "" // renombre viejo: ambas viven por separado
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
	// previous_id persiste el último renombre (/clear, /resume) para que una app que
	// estuvo desconectada lo vea en el snapshot o el REST; uno vacío no lo borra.
	// Un recap vacío tampoco borra el guardado (upsert sin recap aún), salvo en un
	// renombre (/clear): la fila movida es la de la conversación anterior.
	// launch_req y el panel de herdr se reemplazan siempre: los manda el proceso vivo.
	res, err = tx.Exec(`INSERT INTO sessions(id,machine,name,cwd,root,model,role,state,context_pct,started_at,updated_at,previous_id,recap,
		launch_req,herdr_pane,herdr_workspace)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET machine=excluded.machine, name=excluded.name, cwd=excluded.cwd,
		root=excluded.root, model=excluded.model, role=excluded.role, state=excluded.state,
		context_pct=excluded.context_pct, started_at=excluded.started_at, updated_at=excluded.updated_at,
		launch_req=excluded.launch_req, herdr_pane=excluded.herdr_pane, herdr_workspace=excluded.herdr_workspace,
		recap=CASE WHEN excluded.recap<>'' OR ? THEN excluded.recap ELSE sessions.recap END,
		previous_id=CASE WHEN excluded.previous_id<>'' THEN excluded.previous_id ELSE sessions.previous_id END
		WHERE sessions.machine=excluded.machine`,
		si.ID, si.Machine, si.Name, si.Cwd, si.Root, si.Model, string(si.Role), string(si.State),
		si.ContextPct, si.StartedAt, si.UpdatedAt, prev, si.Recap, si.LaunchReq, si.HerdrPane, si.HerdrWorkspace, prev != "")
	if err != nil {
		return "", err
	}
	if n, e := res.RowsAffected(); e == nil && n == 0 {
		err = ErrNotOwner // el WHERE del upsert rechazó al otro dueño
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

// renameSession mueve la sesión y sus eventos de old a nw. Si nw ya existe, fusiona:
// los eventos de old quedan antes de los de nw.
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
	// El historial rellenado (seq negativos) del id nuevo se descarta: manda el del viejo.
	if _, err := tx.Exec(`DELETE FROM events WHERE session=? AND seq<0`, nw); err != nil {
		return err
	}
	// Desplaza los eventos del nuevo id tras el máximo positivo del viejo
	// (en dos pasos para no chocar con la PK). Ninguno acaba en seq 0.
	if _, err := tx.Exec(`UPDATE events SET seq=-(seq+?) WHERE session=?`, oldMax, nw); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE events SET seq=-seq WHERE session=? AND seq<0`, nw); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE events SET session=? WHERE session=?`, nw, old)
	return err
}

// moveSessionLinks traslada los vínculos con tickets (y los descartes) de old a nw.
// Ante conflicto gana el confirmado; si ambos tenían un confirmado distinto, queda el de nw.
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

// sessionCols: columnas de una sesión (alias s). previous_id sale vacío si ese id
// vuelve a existir vivo: el renombre ya no aplica y las apps no deben seguirlo.
const sessionCols = `s.id,s.machine,s.name,s.cwd,s.root,s.model,s.role,s.state,s.context_pct,s.started_at,s.updated_at,
	CASE WHEN s.previous_id<>'' AND EXISTS(SELECT 1 FROM sessions p WHERE p.id=s.previous_id AND p.state<>'closed') THEN '' ELSE s.previous_id END,s.recap,
	COALESCE((SELECT c.repo_url FROM checkouts c WHERE c.machine=s.machine AND c.root=s.root),''),
	COALESCE((SELECT c.branch FROM checkouts c WHERE c.machine=s.machine AND c.root=s.root),''),
	COALESCE((SELECT c.project_id FROM checkouts c WHERE c.machine=s.machine AND c.root=s.root),''),
	s.launch_req,s.herdr_pane,s.herdr_workspace`

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
		var role, state string
		if err := rows.Scan(&si.ID, &si.Machine, &si.Name, &si.Cwd, &si.Root, &si.Model, &role, &state,
			&si.ContextPct, &si.StartedAt, &si.UpdatedAt, &si.PreviousID, &si.Recap, &si.RepoURL, &si.Branch, &si.ProjectID,
			&si.LaunchReq, &si.HerdrPane, &si.HerdrWorkspace); err != nil {
			return nil, err
		}
		si.Role, si.State = proto.Role(role), proto.SessionState(state)
		out = append(out, si)
	}
	return out, rows.Err()
}

// MarkMachineSessionsClosed cierra las sesiones abiertas de la máquina y devuelve sus ids.
func (s *Store) MarkMachineSessionsClosed(machine string) ([]string, error) {
	return s.CloseMachineSessionsExcept(machine, nil)
}

// MarkAllMachinesOffline marca fuera de línea todas las máquinas (arranque del hub:
// cada una vuelve a quedar en línea con su hello).
func (s *Store) MarkAllMachinesOffline() error {
	_, err := s.db.Exec(`UPDATE machines SET online=0`)
	return err
}

// AppendEvent guarda e con el siguiente Seq de su sesión y devuelve ese Seq.
// Los assistant_delta no se persisten (devuelve 0).
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
	if _, err = tx.Exec(`DELETE FROM events WHERE session=? AND seq<=?`, e.Session, seq-maxEventsPerSession); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return seq, nil
}

// PrependEvents guarda evs antes de los eventos existentes de la sesión, con Seq
// negativos ascendentes (-n..-1; AppendEvent solo asigna positivos). Si la sesión
// ya tiene Seq negativos el historial ya se rellenó y no hace nada.
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

// Events devuelve hasta limit eventos con Seq < beforeSeq (0 = sin tope; el historial rellenado tiene Seq negativos), más nuevos primero.
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

// CreateCode genera un código de 6 dígitos de un solo uso, válido 10 minutos.
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
		// choque con un código vivo o usado: reintenta con otro
	}
	return "", errors.New("no se pudo generar un código libre")
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

// ErrNotFound indica que no existe el token (dispositivo o máquina) pedido.
var ErrNotFound = errors.New("no encontrado")

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

// AddUniqueDeviceToken guarda el token de un dispositivo sin pisar a otro:
// si el nombre existe usa "nombre (2)", "nombre (3)"... y devuelve el final.
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
	return "", errors.New("no se pudo asignar un nombre único")
}

// Pair consume el código y guarda el token en una sola transacción: si guardar el
// token falla, el código sigue sin usar. Para tokKind "device" el nombre se hace
// único (ver AddUniqueDeviceToken); devuelve el nombre final.
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

// LiveSessionIDs devuelve el conjunto de sesiones existentes y no cerradas.
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

// CloseSession marca como cerrada la sesión id, solo si pertenece a machine.
func (s *Store) CloseSession(machine, id string) error {
	_, err := s.db.Exec(`UPDATE sessions SET state=?, closed_at=? WHERE id=? AND machine=?`, string(proto.StateClosed), time.Now().UnixMilli(), id, machine)
	return err
}

// SessionOwner devuelve la máquina dueña de la sesión id (ok=false si no existe).
func (s *Store) SessionOwner(id string) (machine string, ok bool, err error) {
	err = s.db.QueryRow(`SELECT machine FROM sessions WHERE id=?`, id).Scan(&machine)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return machine, err == nil, err
}

// CloseMachineSessionsExcept cierra las sesiones no cerradas de la máquina que no
// estén en keep y devuelve los ids que cerró.
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

// Session devuelve la sesión id, o ErrNotFound si no existe.
func (s *Store) Session(id string) (proto.SessionInfo, error) {
	var si proto.SessionInfo
	var role, state string
	err := s.db.QueryRow(`SELECT `+sessionCols+` FROM sessions s WHERE s.id=?`, id).
		Scan(&si.ID, &si.Machine, &si.Name, &si.Cwd, &si.Root, &si.Model, &role, &state,
			&si.ContextPct, &si.StartedAt, &si.UpdatedAt, &si.PreviousID, &si.Recap, &si.RepoURL, &si.Branch, &si.ProjectID,
			&si.LaunchReq, &si.HerdrPane, &si.HerdrWorkspace)
	if errors.Is(err, sql.ErrNoRows) {
		return si, ErrNotFound
	}
	si.Role, si.State = proto.Role(role), proto.SessionState(state)
	return si, err
}

// OpenAsks devuelve askId -> sesión de los eventos ask de sesiones no cerradas
// que no tienen un ask_resolved posterior.
func (s *Store) OpenAsks() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT e.session,e.kind,e.data FROM events e JOIN sessions s ON s.id=e.session
		WHERE s.state<>'closed' AND e.kind IN ('ask','ask_resolved') ORDER BY e.session,e.seq`)
	if err != nil {
		return nil, err
	}
	return scanOpenAsks(rows)
}

// SessionOpenAsks devuelve los askId abiertos (sin ask_resolved posterior) de una sesión.
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

// TerminalAuditRow es una fila de la auditoría de terminales.
type TerminalAuditRow struct {
	At                            int64
	Device, Machine, Pane, Action string
}

// AuditTerminal anota quién abrió o cerró un panel de terminal.
func (s *Store) AuditTerminal(device, machine, pane, action string) error {
	_, err := s.db.Exec(`INSERT INTO terminal_audit(at, device, machine, pane, action) VALUES(?,?,?,?,?)`,
		time.Now().UnixMilli(), device, machine, pane, action)
	return err
}

// ListTerminalAudit devuelve la auditoría en orden de inserción.
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
