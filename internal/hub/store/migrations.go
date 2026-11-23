package store

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
`

func migrate(s *Store) error {
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}
	if _, err := s.db.Exec(schemaProjects); err != nil {
		return err
	}
	// BDs anteriores: sessions sin previous_id.
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='previous_id'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN previous_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	// BDs anteriores: machines sin caps.
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
	// Plan 3: con qué lanzamiento y en qué panel de herdr corre la sesión.
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
	return nil
}

// schemaProjects (Plan 2): trabajos, proyectos, checkouts, tickets y propuestas.
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
	status TEXT NOT NULL DEFAULT 'pendiente',
	error TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS proposals_ticket ON proposals(ticket_id);
`
