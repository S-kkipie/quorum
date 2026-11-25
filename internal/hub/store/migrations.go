package store

import (
	"encoding/json"
	"log"

	"github.com/S-kkipie/quorum/internal/proto"
)

const schema = `
CREATE TABLE IF NOT EXISTS machines (
	name TEXT PRIMARY KEY,
	os TEXT NOT NULL DEFAULT '',
	env TEXT NOT NULL DEFAULT '',
	version TEXT NOT NULL DEFAULT '',
	online INTEGER NOT NULL DEFAULT 0,
	last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	machine TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT '',
	cwd TEXT NOT NULL DEFAULT '',
	root TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT '',
	context_pct INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT 0,
	passive INTEGER NOT NULL DEFAULT 0,
	passive_reason TEXT NOT NULL DEFAULT '',
	previous_id TEXT NOT NULL DEFAULT '',
	recap TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
	session TEXT NOT NULL,
	seq INTEGER NOT NULL,
	ts INTEGER NOT NULL DEFAULT 0,
	kind TEXT NOT NULL,
	data TEXT NOT NULL DEFAULT 'null',
	PRIMARY KEY (session, seq)
);
CREATE TABLE IF NOT EXISTS codes (
	kind TEXT NOT NULL,
	code TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (kind, code)
);
CREATE TABLE IF NOT EXISTS tokens (
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	hash TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (kind, name)
);
CREATE INDEX IF NOT EXISTS tokens_hash ON tokens(kind, hash);
CREATE TABLE IF NOT EXISTS terminal_audit (
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL DEFAULT 0,
	device TEXT NOT NULL DEFAULT '',
	machine TEXT NOT NULL DEFAULT '',
	pane TEXT NOT NULL DEFAULT '',
	action TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS away (
	session TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS session_commands (
	session_id TEXT PRIMARY KEY,
	hash TEXT NOT NULL DEFAULT '',
	commands TEXT NOT NULL DEFAULT '[]',
	at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_usage (
	account_key TEXT PRIMARY KEY,
	alias TEXT NOT NULL DEFAULT '',
	five_hour_pct REAL NOT NULL DEFAULT 0,
	five_hour_resets TEXT NOT NULL DEFAULT '',
	seven_day_pct REAL NOT NULL DEFAULT 0,
	seven_day_resets TEXT NOT NULL DEFAULT '',
	at INTEGER NOT NULL DEFAULT 0
);
`

func migrate(s *Store) error {
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}
	if err := migrateAutoVacuum(s); err != nil {
		return err
	}
	if _, err := s.db.Exec(schemaProjects); err != nil {
		return err
	}
	// Older DBs: sessions without previous_id.
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='previous_id'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN previous_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	// Older DBs: machines without caps.
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('machines') WHERE name='caps'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE machines ADD COLUMN caps TEXT NOT NULL DEFAULT '{}'`); err != nil {
			return err
		}
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='closed_at'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN closed_at INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='recap'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN recap TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	// Plan 3: which launch and which herdr pane the session runs in.
	for _, col := range []string{"launch_req", "herdr_pane", "herdr_workspace"} {
		if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name=?`, col).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}
	// Task 10: a session that ever received a user prompt is kept when it closes (pruning can drop the events).
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='prompted'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN prompted INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
		if _, err := s.db.Exec(`UPDATE sessions SET prompted=1 WHERE EXISTS (SELECT 1 FROM events e WHERE e.session=sessions.id AND e.kind=?)
			OR (SELECT COUNT(*) FROM events e WHERE e.session=sessions.id)>=?`, string(proto.KindUser), maxEventsPerSession); err != nil {
			return err
		}
	}
	// Plan 6: account, plugins and token totals reported by the mod.
	for _, c := range [][2]string{{"account", "TEXT NOT NULL DEFAULT ''"}, {"account_key", "TEXT NOT NULL DEFAULT ''"},
		{"config_dir", "TEXT NOT NULL DEFAULT ''"}, {"plugins", "TEXT NOT NULL DEFAULT '[]'"},
		{"context_estimate", "INTEGER NOT NULL DEFAULT 0"}, {"tokens", "TEXT NOT NULL DEFAULT '{}'"},
		{"images_dir", "TEXT NOT NULL DEFAULT ''"}, // Task 10: the session's pasted-images folder
		// Plan 7: pending background work, seen marks and the attention already announced. Existing
		// sessions start with every mark at 0: nothing becomes unread on upgrade.
		{"background", "TEXT NOT NULL DEFAULT '{}'"}, {"seen_seq", "INTEGER NOT NULL DEFAULT 0"},
		{"end_seq", "INTEGER NOT NULL DEFAULT 0"}, {"attention_end_seq", "INTEGER NOT NULL DEFAULT 0"},
		{"needs_you_announced", "INTEGER NOT NULL DEFAULT 0"},
		{"model_cfg", "TEXT NOT NULL DEFAULT '{}'"}, // Plan 8: effort, model options, effort options
		// Plan 10: the session's machine served its history at least once.
		{"history_ok", "INTEGER NOT NULL DEFAULT 0"},
		// the git worktrees of the session's repo, reported by the daemon
		{"worktrees", "TEXT NOT NULL DEFAULT '[]'"},
	} {
		if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name=?`, c[0]).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN ` + c[0] + ` ` + c[1]); err != nil {
				return err
			}
		}
	}
	if _, err := s.db.Exec(schemaPush); err != nil {
		return err
	}
	if err := migrateBriefing(s); err != nil {
		return err
	}
	return migrateEnglishStatuses(s)
}

// schemaPush (Plan 11): the phones' FCM tokens, one row per token, owned by a device. Revoking the
// device (here or from `quorum-hub revoke`, another process) deletes its tokens through the trigger;
// the DELETE at the end drops rows left by a device revoked before the trigger existed.
const schemaPush = `
CREATE TABLE IF NOT EXISTS push_tokens (
	device_id TEXT NOT NULL,
	token TEXT PRIMARY KEY,
	platform TEXT NOT NULL DEFAULT '',
	at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_tokens_device ON push_tokens(device_id);
CREATE TRIGGER IF NOT EXISTS push_tokens_revoke AFTER DELETE ON tokens WHEN old.kind='device'
BEGIN
	DELETE FROM push_tokens WHERE device_id=old.name;
END;
DELETE FROM push_tokens WHERE device_id NOT IN (SELECT name FROM tokens WHERE kind='device');
`

// Status values were stored in Spanish before the repository was translated.
var (
	oldTicketStatuses = map[string]string{
		"por_hacer": "todo", "en_curso": "in_progress", "en_review": "in_review", "hecho": "done", "bloqueado": "blocked",
	}
	oldProposalStatuses = map[string]string{
		"pendiente": "pending", "enviando": "sending", "aprobada": "approved", "rechazada": "rejected", "fallida": "failed",
	}
)

// migrateEnglishStatuses rewrites the old Spanish status values to English: tickets.status,
// proposals.status, proposals.body of status proposals and the values of each project's
// connector statusMap setting. It is idempotent: English values are left untouched.
func migrateEnglishStatuses(s *Store) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for old, nw := range oldTicketStatuses {
		if _, err := tx.Exec(`UPDATE tickets SET status=? WHERE status=?`, nw, old); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE proposals SET body=? WHERE kind='status' AND body=?`, nw, old); err != nil {
			return err
		}
	}
	for old, nw := range oldProposalStatuses {
		if _, err := tx.Exec(`UPDATE proposals SET status=? WHERE status=?`, nw, old); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT id, settings FROM projects WHERE settings LIKE '%statusMap%'`)
	if err != nil {
		return err
	}
	type upd struct{ id, settings string }
	var todo []upd
	for rows.Next() {
		var id, settings string
		if err := rows.Scan(&id, &settings); err != nil {
			rows.Close()
			return err
		}
		if ns, changed := migrateStatusMapSetting(settings); changed {
			todo = append(todo, upd{id, ns})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, u := range todo {
		if _, err := tx.Exec(`UPDATE projects SET settings=? WHERE id=?`, u.settings, u.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// migrateStatusMapSetting rewrites the Spanish values inside settings["statusMap"] (itself a JSON
// object stored as a string). Malformed JSON is left as is.
func migrateStatusMapSetting(settings string) (string, bool) {
	var m map[string]string
	if json.Unmarshal([]byte(settings), &m) != nil || m["statusMap"] == "" {
		return settings, false
	}
	var sm map[string]string
	if json.Unmarshal([]byte(m["statusMap"]), &sm) != nil {
		return settings, false
	}
	changed := false
	for k, v := range sm {
		if nw, ok := oldTicketStatuses[v]; ok {
			sm[k] = nw
			changed = true
		}
	}
	if !changed {
		return settings, false
	}
	b, _ := json.Marshal(sm)
	m["statusMap"] = string(b)
	out, _ := json.Marshal(m)
	return string(out), true
}

// schemaProjects (Plan 2): workspaces, projects, checkouts, tickets and proposals.
const schemaProjects = `
CREATE TABLE IF NOT EXISTS workspaces (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL DEFAULT '',
	color TEXT NOT NULL DEFAULT '',
	whoas_profile TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT '',
	repo_url TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT 'none',
	settings TEXT NOT NULL DEFAULT '{}',
	interval_min INTEGER NOT NULL DEFAULT 0,
	summary TEXT NOT NULL DEFAULT '',
	summary_at INTEGER NOT NULL DEFAULT 0,
	progress_done INTEGER NOT NULL DEFAULT 0,
	progress_total INTEGER NOT NULL DEFAULT 0,
	sync_error TEXT NOT NULL DEFAULT '',
	synced_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id);
CREATE TABLE IF NOT EXISTS project_tokens (
	project_id TEXT PRIMARY KEY,
	token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkouts (
	id TEXT PRIMARY KEY,
	project_id TEXT,
	machine TEXT NOT NULL,
	root TEXT NOT NULL,
	repo_url TEXT NOT NULL DEFAULT '',
	branch TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0,
	UNIQUE (machine, root)
);
CREATE INDEX IF NOT EXISTS checkouts_project ON checkouts(project_id);
CREATE TABLE IF NOT EXISTS tickets (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	external_id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT '',
	raw_status TEXT NOT NULL DEFAULT '',
	assignee TEXT NOT NULL DEFAULT '',
	url TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL DEFAULT '',
	comments TEXT NOT NULL DEFAULT '[]',
	updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tickets_project ON tickets(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_external ON tickets(project_id, external_id);
CREATE TABLE IF NOT EXISTS session_tickets (
	session_id TEXT NOT NULL,
	ticket_id TEXT NOT NULL,
	confirmed INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (session_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS session_tickets_ticket ON session_tickets(ticket_id);
CREATE TABLE IF NOT EXISTS session_ticket_dismissed (
	session_id TEXT NOT NULL,
	ticket_id TEXT NOT NULL,
	PRIMARY KEY (session_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS proposals (
	id TEXT PRIMARY KEY,
	ticket_id TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'pending',
	error TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS proposals_ticket ON proposals(ticket_id);
`

// migrateAutoVacuum switches the database to auto_vacuum=INCREMENTAL (Plan 10 retention frees pages
// with incremental_vacuum). SQLite only applies the switch on an existing database after a full
// VACUUM, so it runs once, guarded by a marker row, and is logged.
func migrateAutoVacuum(s *Store) error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`); err != nil {
		return err
	}
	var done int
	if err := s.db.QueryRow(`SELECT count(*) FROM meta WHERE key='auto_vacuum_incremental'`).Scan(&done); err != nil {
		return err
	}
	if done > 0 {
		return nil
	}
	var mode int
	if err := s.db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode); err != nil {
		return err
	}
	if mode != 2 {
		// A brand-new database has nothing to rebuild: stay quiet.
		var used int
		if err := s.db.QueryRow(`SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM events)`).Scan(&used); err != nil {
			return err
		}
		if used > 0 {
			log.Printf("hub: store: enabling incremental auto_vacuum (one-time VACUUM)")
		}
		if _, err := s.db.Exec(`PRAGMA auto_vacuum=INCREMENTAL`); err != nil {
			return err
		}
		if _, err := s.db.Exec(`VACUUM`); err != nil {
			return err
		}
		if used > 0 {
			log.Printf("hub: store: VACUUM done")
		}
	}
	_, err := s.db.Exec(`INSERT INTO meta(key,value) VALUES('auto_vacuum_incremental','1') ON CONFLICT(key) DO NOTHING`)
	return err
}
