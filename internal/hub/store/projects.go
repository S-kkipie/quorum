package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// ErrNotEmpty: the workspace still has projects.
var ErrNotEmpty = errors.New("the workspace has projects")

// TicketStatuses is the canonical set of a ticket's normalized statuses.
var TicketStatuses = []string{"todo", "in_progress", "in_review", "done", "blocked"}

// ValidStatus says whether s is a normalized ticket status.
func ValidStatus(s string) bool {
	for _, v := range TicketStatuses {
		if v == s {
			return true
		}
	}
	return false
}

func validProposalKind(k string) bool { return k == "comment" || k == "status" }

// ValidProposalStatus says whether s is a proposal status.
func ValidProposalStatus(s string) bool { return validProposalStatus(s) }

func validProposalStatus(s string) bool {
	switch s {
	case "pending", "sending", "approved", "rejected", "failed":
		return true
	}
	return false
}

func (s *Store) workspaceExists(id string) error {
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM workspaces WHERE id=?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// NormalizeRepoURL reduces a repo URL to lowercase host/owner/repo
// (without scheme, user or .git); git@host:o/r ≡ https://host/o/r.
func NormalizeRepoURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	if i := strings.Index(u, "://"); i >= 0 {
		if pu, err := url.Parse(u); err == nil {
			u = pu.Hostname() + "/" + strings.TrimPrefix(pu.Path, "/")
		} else {
			u = u[i+3:]
			if at := strings.Index(u, "@"); at >= 0 && at < strings.Index(u+"/", "/") {
				u = u[at+1:]
			}
		}
	} else if at := strings.Index(u, "@"); at >= 0 && !strings.Contains(u[:at], "/") {
		// scp-like: user@host:path
		u = u[at+1:]
		u = strings.Replace(u, ":", "/", 1)
	} else if c := strings.Index(u, ":"); c >= 0 && !strings.Contains(u[:c], "/") {
		u = u[:c] + "/" + u[c+1:]
	}
	u = strings.ToLower(u)
	u = strings.TrimRight(u, "/")
	u = strings.TrimSuffix(u, ".git")
	return strings.TrimRight(u, "/")
}

// StripRepoUserinfo leaves a repo URL without credentials: removes the query and fragment
// (?access_token=...) and, in URLs with a scheme, everything up to the LAST '@' (a password
// may contain '/'): https://u:p/x@host/o/r -> https://host/o/r. The scp forms
// (git@host:o/r) carry no secret and stay as they are.
func StripRepoUserinfo(u string) string {
	u = strings.TrimSpace(u)
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	i := strings.Index(u, "://")
	if i < 0 {
		return u
	}
	rest := u[i+3:]
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		rest = rest[at+1:]
	}
	return u[:i+3] + rest
}

// ---- Workspaces ----

func (s *Store) CreateWorkspace(w proto.Workspace) (proto.Workspace, error) {
	w.ID = newID()
	_, err := s.db.Exec(`INSERT INTO workspaces(id,name,color,whoas_profile) VALUES(?,?,?,?)`, w.ID, w.Name, w.Color, w.WhoasProfile)
	return w, err
}

func (s *Store) ListWorkspaces() ([]proto.Workspace, error) {
	rows, err := s.db.Query(`SELECT id,name,color,whoas_profile FROM workspaces ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Workspace{}
	for rows.Next() {
		var w proto.Workspace
		if err := rows.Scan(&w.ID, &w.Name, &w.Color, &w.WhoasProfile); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) UpdateWorkspace(w proto.Workspace) error {
	res, err := s.db.Exec(`UPDATE workspaces SET name=?,color=?,whoas_profile=? WHERE id=?`, w.Name, w.Color, w.WhoasProfile, w.ID)
	return affected(res, err)
}

func (s *Store) DeleteWorkspace(id string) (err error) {
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
	if err = tx.QueryRow(`SELECT count(*) FROM projects WHERE workspace_id=?`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrNotEmpty
	}
	res, err := tx.Exec(`DELETE FROM workspaces WHERE id=?`, id)
	if err = affected(res, err); err != nil {
		return err
	}
	return tx.Commit()
}

func affected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Projects ----

const projectCols = `p.id,p.workspace_id,p.name,p.repo_url,p.kind,p.settings,p.interval_min,p.summary,p.summary_at,p.progress_done,p.progress_total,p.sync_error,p.synced_at,EXISTS(SELECT 1 FROM project_tokens t WHERE t.project_id=p.id)`

type scanner interface{ Scan(...any) error }

func scanProject(r scanner) (proto.Project, error) {
	var p proto.Project
	var settings string
	err := r.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.RepoURL, &p.Connector.Kind, &settings, &p.Connector.IntervalMin,
		&p.Summary, &p.SummaryAt, &p.Progress.Done, &p.Progress.Total, &p.SyncError, &p.SyncedAt, &p.Connector.HasToken)
	if err != nil {
		return p, err
	}
	p.Connector.Settings = map[string]string{}
	if err := json.Unmarshal([]byte(settings), &p.Connector.Settings); err != nil || p.Connector.Settings == nil {
		p.Connector.Settings = map[string]string{}
	}
	return p, nil
}

func settingsJSON(m map[string]string) string {
	if m == nil {
		return "{}"
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func (s *Store) CreateProject(p proto.Project) (proto.Project, error) {
	if err := s.workspaceExists(p.WorkspaceID); err != nil {
		return p, err
	}
	if p.Connector.Kind == "" {
		p.Connector.Kind = "none"
	}
	p.RepoURL = StripRepoUserinfo(p.RepoURL)
	p.ID = newID()
	p.Connector.HasToken = false
	_, err := s.db.Exec(`INSERT INTO projects(id,workspace_id,name,repo_url,kind,settings,interval_min) VALUES(?,?,?,?,?,?,?)`,
		p.ID, p.WorkspaceID, p.Name, p.RepoURL, p.Connector.Kind, settingsJSON(p.Connector.Settings), p.Connector.IntervalMin)
	if p.Connector.Settings == nil {
		p.Connector.Settings = map[string]string{}
	}
	return p, err
}

func (s *Store) ListProjects() ([]proto.Project, error) {
	rows, err := s.db.Query(`SELECT ` + projectCols + ` FROM projects p ORDER BY p.name, p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(id string) (proto.Project, error) {
	p, err := scanProject(s.db.QueryRow(`SELECT `+projectCols+` FROM projects p WHERE p.id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// UpdateProject updates name, workspace, repo and connector (not token, summary or sync).
func (s *Store) UpdateProject(p proto.Project) error {
	if err := s.workspaceExists(p.WorkspaceID); err != nil {
		return err
	}
	if p.Connector.Kind == "" {
		p.Connector.Kind = "none"
	}
	p.RepoURL = StripRepoUserinfo(p.RepoURL)
	res, err := s.db.Exec(`UPDATE projects SET workspace_id=?,name=?,repo_url=?,kind=?,settings=?,interval_min=? WHERE id=?`,
		p.WorkspaceID, p.Name, p.RepoURL, p.Connector.Kind, settingsJSON(p.Connector.Settings), p.Connector.IntervalMin, p.ID)
	return affected(res, err)
}

// ConnectorResetMsg is the error open proposals are left with when the connector changes.
const ConnectorResetMsg = "the connector changed"

// ConnectorReset is what ResetConnector deleted (to notify the apps).
type ConnectorReset struct {
	Links     []proto.SessionTicket // deleted links (to publish them as Removed)
	Proposals []string              // pending/sending proposals that became failed
}

// UpdateProjectResetConnector updates the project like UpdateProject and, in the same
// transaction, deletes its tickets, its links (and dismissals), marks its open
// proposals as failed and resets synced_at and sync_error: the connector points to another source.
func (s *Store) UpdateProjectResetConnector(p proto.Project) (out ConnectorReset, err error) {
	if err = s.workspaceExists(p.WorkspaceID); err != nil {
		return out, err
	}
	if p.Connector.Kind == "" {
		p.Connector.Kind = "none"
	}
	p.RepoURL = StripRepoUserinfo(p.RepoURL)
	tx, err := s.db.Begin()
	if err != nil {
		return out, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	res, err := tx.Exec(`UPDATE projects SET workspace_id=?,name=?,repo_url=?,kind=?,settings=?,interval_min=?,synced_at=0,sync_error='' WHERE id=?`,
		p.WorkspaceID, p.Name, p.RepoURL, p.Connector.Kind, settingsJSON(p.Connector.Settings), p.Connector.IntervalMin, p.ID)
	if err = affected(res, err); err != nil {
		return out, err
	}
	const tk = `(SELECT id FROM tickets WHERE project_id=?)`
	rows, err := tx.Query(`SELECT session_id,ticket_id FROM session_tickets WHERE ticket_id IN `+tk, p.ID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		l := proto.SessionTicket{Removed: true}
		if err = rows.Scan(&l.SessionID, &l.TicketID); err != nil {
			rows.Close()
			return out, err
		}
		out.Links = append(out.Links, l)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return out, err
	}
	rows, err = tx.Query(`SELECT id FROM proposals WHERE status IN ('pending','sending') AND ticket_id IN `+tk, p.ID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return out, err
		}
		out.Proposals = append(out.Proposals, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return out, err
	}
	if _, err = tx.Exec(`UPDATE proposals SET status='failed',error=? WHERE status IN ('pending','sending') AND ticket_id IN `+tk, ConnectorResetMsg, p.ID); err != nil {
		return out, err
	}
	for _, q := range []string{
		`DELETE FROM session_tickets WHERE ticket_id IN ` + tk,
		`DELETE FROM session_ticket_dismissed WHERE ticket_id IN ` + tk,
		`DELETE FROM tickets WHERE project_id=?`,
	} {
		if _, err = tx.Exec(q, p.ID); err != nil {
			return out, err
		}
	}
	if err = recomputeProgress(tx, p.ID, s.now().UnixMilli()); err != nil {
		return out, err
	}
	return out, tx.Commit()
}

func (s *Store) DeleteProject(id string) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	const tk = `(SELECT id FROM tickets WHERE project_id=?)`
	for _, q := range []string{
		`DELETE FROM session_tickets WHERE ticket_id IN ` + tk,
		`DELETE FROM session_ticket_dismissed WHERE ticket_id IN ` + tk,
		`DELETE FROM proposals WHERE ticket_id IN ` + tk,
		`DELETE FROM tickets WHERE project_id=?`,
		`UPDATE checkouts SET project_id=NULL WHERE project_id=?`,
		`DELETE FROM project_tokens WHERE project_id=?`,
	} {
		if _, err = tx.Exec(q, id); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`DELETE FROM projects WHERE id=?`, id)
	if err = affected(res, err); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetConnectorToken(projectID, token string) error {
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM projects WHERE id=?`, projectID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	if token == "" {
		_, err := s.db.Exec(`DELETE FROM project_tokens WHERE project_id=?`, projectID)
		return err
	}
	_, err := s.db.Exec(`INSERT INTO project_tokens(project_id,token) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET token=excluded.token`, projectID, token)
	return err
}

// ConnectorToken returns the connector's token; only for use by the connectors.
func (s *Store) ConnectorToken(projectID string) (string, error) {
	var t string
	err := s.db.QueryRow(`SELECT token FROM project_tokens WHERE project_id=?`, projectID).Scan(&t)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return t, err
}

func (s *Store) SetProjectSummary(projectID, summary string, at int64) error {
	res, err := s.db.Exec(`UPDATE projects SET summary=?,summary_at=? WHERE id=?`, summary, at, projectID)
	return affected(res, err)
}

func (s *Store) SetSyncResult(projectID, syncErr string, at int64) error {
	res, err := s.db.Exec(`UPDATE projects SET sync_error=?,synced_at=? WHERE id=?`, syncErr, at, projectID)
	return affected(res, err)
}

// ---- Checkouts ----

// UpsertCheckout inserts or updates by (machine, root); keeps the existing ID.
func (s *Store) UpsertCheckout(c proto.Checkout) (proto.Checkout, error) {
	c.RepoURL = StripRepoUserinfo(c.RepoURL)
	if c.UpdatedAt == 0 {
		c.UpdatedAt = s.now().UnixMilli()
	}
	var pid any
	if c.ProjectID != "" {
		pid = c.ProjectID
	}
	_, err := s.db.Exec(`INSERT INTO checkouts(id,project_id,machine,root,repo_url,branch,updated_at) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(machine,root) DO UPDATE SET project_id=COALESCE(excluded.project_id,project_id),repo_url=excluded.repo_url,branch=excluded.branch,updated_at=excluded.updated_at`,
		newID(), pid, c.Machine, c.Root, c.RepoURL, c.Branch, c.UpdatedAt)
	if err != nil {
		return c, err
	}
	return s.CheckoutForRoot(c.Machine, c.Root)
}

// SetCheckoutProject assigns the checkout to a project; an empty projectID unlinks it.
func (s *Store) SetCheckoutProject(checkoutID, projectID string) error {
	var pid any
	if projectID != "" {
		pid = projectID
	}
	res, err := s.db.Exec(`UPDATE checkouts SET project_id=? WHERE id=?`, pid, checkoutID)
	return affected(res, err)
}

const checkoutCols = `id,COALESCE(project_id,''),machine,root,repo_url,branch,updated_at`

func scanCheckout(r scanner) (c proto.Checkout, err error) {
	err = r.Scan(&c.ID, &c.ProjectID, &c.Machine, &c.Root, &c.RepoURL, &c.Branch, &c.UpdatedAt)
	return
}

func (s *Store) ListCheckouts(projectID string) ([]proto.Checkout, error) {
	rows, err := s.db.Query(`SELECT `+checkoutCols+` FROM checkouts WHERE project_id=? ORDER BY machine, root`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Checkout{}
	for rows.Next() {
		c, err := scanCheckout(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CheckoutForRoot(machine, root string) (proto.Checkout, error) {
	c, err := scanCheckout(s.db.QueryRow(`SELECT `+checkoutCols+` FROM checkouts WHERE machine=? AND root=?`, machine, root))
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// ---- Tickets ----

// ReplaceTickets upserts by (project_id, external_id) in one transaction.
// Does not delete the missing ones; with Comments == nil keeps the stored comments ([] deletes them). Recomputes the project's progress.
func (s *Store) ReplaceTickets(projectID string, ts []proto.Ticket) (err error) {
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
	if err = tx.QueryRow(`SELECT count(*) FROM projects WHERE id=?`, projectID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	for _, t := range ts {
		if t.ExternalID == "" {
			err = fmt.Errorf("ticket without ExternalID (%q)", t.Title)
			return err
		}
		if !ValidStatus(t.Status) {
			err = fmt.Errorf("invalid ticket status %q (ticket %s)", t.Status, t.ExternalID)
			return err
		}
		cj := []byte("[]")
		if t.Comments != nil {
			if cj, err = json.Marshal(t.Comments); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(`INSERT INTO tickets(id,project_id,external_id,title,status,raw_status,assignee,url,body,comments,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(project_id,external_id) DO UPDATE SET title=excluded.title,status=excluded.status,raw_status=excluded.raw_status,
			assignee=excluded.assignee,url=excluded.url,body=excluded.body,comments=CASE WHEN ? THEN excluded.comments ELSE tickets.comments END,updated_at=excluded.updated_at`,
			newID(), projectID, t.ExternalID, t.Title, t.Status, t.RawStatus, t.Assignee, t.URL, t.Body, string(cj), t.UpdatedAt, t.Comments != nil); err != nil {
			return err
		}
	}
	if err = recomputeProgress(tx, projectID, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListTickets(projectID string) ([]proto.Ticket, error) {
	rows, err := s.db.Query(`SELECT id,project_id,external_id,title,status,raw_status,assignee,url,body,comments,updated_at FROM tickets WHERE project_id=? ORDER BY updated_at DESC, external_id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Ticket{}
	for rows.Next() {
		var t proto.Ticket
		var cj string
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.ExternalID, &t.Title, &t.Status, &t.RawStatus, &t.Assignee, &t.URL, &t.Body, &cj, &t.UpdatedAt); err != nil {
			return nil, err
		}
		t.Comments = []proto.TicketComment{}
		if err := json.Unmarshal([]byte(cj), &t.Comments); err != nil || t.Comments == nil {
			t.Comments = []proto.TicketComment{}
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Ticket returns a ticket by id (ErrNotFound if it does not exist).
func (s *Store) Ticket(id string) (proto.Ticket, error) {
	var t proto.Ticket
	var cj string
	err := s.db.QueryRow(`SELECT id,project_id,external_id,title,status,raw_status,assignee,url,body,comments,updated_at FROM tickets WHERE id=?`, id).
		Scan(&t.ID, &t.ProjectID, &t.ExternalID, &t.Title, &t.Status, &t.RawStatus, &t.Assignee, &t.URL, &t.Body, &cj, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	if err != nil {
		return t, err
	}
	t.Comments = []proto.TicketComment{}
	if json.Unmarshal([]byte(cj), &t.Comments) != nil || t.Comments == nil {
		t.Comments = []proto.TicketComment{}
	}
	return t, nil
}

// ConfirmedSessions returns the ids of the sessions with the ticket confirmed.
func (s *Store) ConfirmedSessions(ticketID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT session_id FROM session_tickets WHERE ticket_id=? AND confirmed=1 ORDER BY session_id`, ticketID)
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

// ---- Session <-> ticket ----

func (s *Store) LinkSessionTicket(l proto.SessionTicket) error {
	_, err := s.db.Exec(`INSERT INTO session_tickets(session_id,ticket_id,confirmed) VALUES(?,?,?)
		ON CONFLICT(session_id,ticket_id) DO UPDATE SET confirmed=excluded.confirmed`, l.SessionID, l.TicketID, b2i(l.Confirmed))
	return err
}

func (s *Store) UnlinkSessionTicket(sessionID, ticketID string) error {
	_, err := s.db.Exec(`DELETE FROM session_tickets WHERE session_id=? AND ticket_id=?`, sessionID, ticketID)
	return err
}

func (s *Store) SessionTickets(sessionID string) ([]proto.SessionTicket, error) {
	rows, err := s.db.Query(`SELECT session_id,ticket_id,confirmed FROM session_tickets WHERE session_id=? ORDER BY ticket_id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.SessionTicket{}
	for rows.Next() {
		var l proto.SessionTicket
		if err := rows.Scan(&l.SessionID, &l.TicketID, &l.Confirmed); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// SuggestSessionTicket creates a suggested (unconfirmed) link unless one already exists
// (never downgrades a confirmed one) or the owner unlinked it. Returns whether it created it.
func (s *Store) SuggestSessionTicket(sessionID, ticketID string) (bool, error) {
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM session_ticket_dismissed WHERE session_id=? AND ticket_id=?`, sessionID, ticketID).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	res, err := s.db.Exec(`INSERT OR IGNORE INTO session_tickets(session_id,ticket_id,confirmed) VALUES(?,?,0)`, sessionID, ticketID)
	if err != nil {
		return false, err
	}
	c, _ := res.RowsAffected()
	return c > 0, nil
}

// ConfirmSessionTicket confirms the link; there is only one confirmed per session: the
// previous confirmed one becomes suggested. Returns the ticket ids whose state changed
// (the previous confirmed one, if there was one).
func (s *Store) ConfirmSessionTicket(sessionID, ticketID string) (demoted []string, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	rows, err := tx.Query(`SELECT ticket_id FROM session_tickets WHERE session_id=? AND confirmed=1 AND ticket_id<>?`, sessionID, ticketID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		demoted = append(demoted, id)
	}
	rows.Close()
	if _, err = tx.Exec(`UPDATE session_tickets SET confirmed=0 WHERE session_id=? AND ticket_id<>?`, sessionID, ticketID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`DELETE FROM session_ticket_dismissed WHERE session_id=? AND ticket_id=?`, sessionID, ticketID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`INSERT INTO session_tickets(session_id,ticket_id,confirmed) VALUES(?,?,1)
		ON CONFLICT(session_id,ticket_id) DO UPDATE SET confirmed=1`, sessionID, ticketID); err != nil {
		return nil, err
	}
	return demoted, tx.Commit()
}

// DismissSessionTicket unlinks and remembers that it must not be suggested again.
func (s *Store) DismissSessionTicket(sessionID, ticketID string) error {
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO session_ticket_dismissed(session_id,ticket_id) VALUES(?,?)`, sessionID, ticketID); err != nil {
		return err
	}
	return s.UnlinkSessionTicket(sessionID, ticketID)
}

// ---- Proposals ----

func (s *Store) CreateProposal(p proto.Proposal) (proto.Proposal, error) {
	if !validProposalKind(p.Kind) {
		return p, fmt.Errorf("invalid proposal kind %q", p.Kind)
	}
	p.ID = newID()
	p.Status = "pending"
	p.Error = ""
	p.CreatedAt = s.now().UnixMilli()
	_, err := s.db.Exec(`INSERT INTO proposals(id,ticket_id,kind,body,status,error,created_at) VALUES(?,?,?,?,?,?,?)`,
		p.ID, p.TicketID, p.Kind, p.Body, p.Status, p.Error, p.CreatedAt)
	return p, err
}

// ListProposals returns a ticket's proposals (all if ticketID is empty), newest first.
func (s *Store) ListProposals(ticketID string) ([]proto.Proposal, error) {
	return s.QueryProposals(ProposalFilter{TicketID: ticketID})
}

// ProposalFilter narrows QueryProposals; empty fields (or Limit <= 0) do not filter.
type ProposalFilter struct {
	TicketID string
	Status   string
	Limit    int
}

// QueryProposals returns the proposals matching f, newest first.
func (s *Store) QueryProposals(f ProposalFilter) ([]proto.Proposal, error) {
	q := `SELECT id,ticket_id,kind,body,status,error,created_at FROM proposals`
	var where []string
	args := []any{}
	if f.TicketID != "" {
		where = append(where, `ticket_id=?`)
		args = append(args, f.TicketID)
	}
	if f.Status != "" {
		where = append(where, `status=?`)
		args = append(args, f.Status)
	}
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, ` AND `)
	}
	q += ` ORDER BY created_at DESC, id`
	if f.Limit > 0 {
		q += ` LIMIT ?`
		args = append(args, f.Limit)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Proposal{}
	for rows.Next() {
		var p proto.Proposal
		if err := rows.Scan(&p.ID, &p.TicketID, &p.Kind, &p.Body, &p.Status, &p.Error, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetProposal returns a proposal by id.
func (s *Store) GetProposal(id string) (proto.Proposal, error) {
	var p proto.Proposal
	err := s.db.QueryRow(`SELECT id,ticket_id,kind,body,status,error,created_at FROM proposals WHERE id=?`, id).
		Scan(&p.ID, &p.TicketID, &p.Kind, &p.Body, &p.Status, &p.Error, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// UpdateProposalBody replaces a pending proposal's body and resets its date.
func (s *Store) UpdateProposalBody(id, body string) error {
	res, err := s.db.Exec(`UPDATE proposals SET body=?,created_at=? WHERE id=? AND status='pending'`, body, s.now().UnixMilli(), id)
	return affected(res, err)
}

// TransitionProposal moves the proposal from from to to atomically; ErrNotFound if it was not in from.
func (s *Store) TransitionProposal(id, from, to string) error {
	if !validProposalStatus(from) || !validProposalStatus(to) {
		return fmt.Errorf("invalid proposal status")
	}
	res, err := s.db.Exec(`UPDATE proposals SET status=? WHERE id=? AND status=?`, to, id, from)
	return affected(res, err)
}

// ClaimProposalSend moves pending -> sending atomically and, if body is not empty,
// stores the edited body in the same statement. ErrNotFound if it was no longer pending.
func (s *Store) ClaimProposalSend(id, body string) error {
	res, err := s.db.Exec(`UPDATE proposals SET status='sending',body=CASE WHEN ?='' THEN body ELSE ? END WHERE id=? AND status='pending'`, body, body, id)
	return affected(res, err)
}

// FailInterruptedProposals marks as failed the proposals left in "sending" (hub restart).
func (s *Store) FailInterruptedProposals() error {
	_, err := s.db.Exec(`UPDATE proposals SET status='failed',error='interrupted; check the ticket source' WHERE status='sending'`)
	return err
}

func (s *Store) SetProposalStatus(id, status, errMsg string) error {
	if !validProposalStatus(status) {
		return fmt.Errorf("invalid proposal status %q", status)
	}
	res, err := s.db.Exec(`UPDATE proposals SET status=?,error=? WHERE id=?`, status, errMsg, id)
	return affected(res, err)
}

// AllCheckouts returns all checkouts (with or without a project).
func (s *Store) AllCheckouts() ([]proto.Checkout, error) {
	rows, err := s.db.Query(`SELECT ` + checkoutCols + ` FROM checkouts ORDER BY machine, root`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.Checkout{}
	for rows.Next() {
		c, err := scanCheckout(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ProgressWindow is the window of tickets that counts toward progress.
const ProgressWindow = 30 * 24 * time.Hour

type execer2 interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// recomputeProgress sets Progress = done / total among the tickets updated in the
// last 30 days (without a real date, < MinActivityMs, counts as recent); if none qualifies, among all.
func recomputeProgress(x execer2, projectID string, nowMs int64) error {
	cut := nowMs - ProgressWindow.Milliseconds()
	// Window: updated within 30 days or without a date (treated as recent); if empty, all.
	const win = `(SELECT count(*) FROM tickets WHERE project_id=projects.id AND (updated_at<100000000000 OR updated_at>=?))`
	_, err := x.Exec(`UPDATE projects SET
		progress_total=CASE WHEN `+win+`=0 THEN (SELECT count(*) FROM tickets WHERE project_id=projects.id)
			ELSE `+win+` END,
		progress_done=CASE WHEN `+win+`=0 THEN (SELECT count(*) FROM tickets WHERE project_id=projects.id AND status='done')
			ELSE (SELECT count(*) FROM tickets WHERE project_id=projects.id AND status='done' AND (updated_at<100000000000 OR updated_at>=?)) END
		WHERE id=?`, cut, cut, cut, cut, projectID)
	return err
}

// RecomputeProgress recomputes the project's progress with nowMs as "now".
func (s *Store) RecomputeProgress(projectID string, nowMs int64) error {
	return recomputeProgress(s.db, projectID, nowMs)
}

// ProjectTurnEnds returns the last n turn_end events of the project's sessions
// (by their machine's checkout and root), most recent first.
func (s *Store) ProjectTurnEnds(projectID string, n int) ([]proto.Event, error) {
	rows, err := s.db.Query(`SELECT e.session,e.seq,e.ts,e.kind,e.data FROM events e
		JOIN sessions s ON s.id=e.session
		JOIN checkouts c ON c.machine=s.machine AND c.root=s.root
		WHERE c.project_id=? AND e.kind='turn_end' ORDER BY e.ts DESC, e.seq DESC LIMIT ?`, projectID, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []proto.Event
	for rows.Next() {
		var e proto.Event
		var kind, data string
		if err := rows.Scan(&e.Session, &e.Seq, &e.TS, &kind, &data); err != nil {
			return nil, err
		}
		e.Kind, e.Data = proto.EventKind(kind), json.RawMessage(data)
		out = append(out, e)
	}
	return out, rows.Err()
}

// MinActivityMs: below this (before 1973) a timestamp is not a real date in
// ms (e.g. a connector sending 1, 2… or seconds) and the activity is taken as unknown.
const MinActivityMs = 100_000_000_000

// ProjectActivity returns the project's last known activity in ms: the maximum
// of its tickets' updated_at, the last turn_end and the updated_at of its live
// sessions. Values that do not look like real ms are ignored; 0 = unknown.
func (s *Store) ProjectActivity(projectID string) (int64, error) {
	var best int64
	qs := []string{
		`SELECT MAX(updated_at) FROM tickets WHERE project_id=? AND updated_at>=?`,
		`SELECT MAX(e.ts) FROM events e JOIN sessions s ON s.id=e.session
		JOIN checkouts c ON c.machine=s.machine AND c.root=s.root
		WHERE c.project_id=? AND e.kind='turn_end' AND e.ts>=?`,
		`SELECT MAX(s.updated_at) FROM sessions s JOIN checkouts c ON c.machine=s.machine AND c.root=s.root
		WHERE c.project_id=? AND s.state<>'closed' AND s.updated_at>=?`,
	}
	for _, q := range qs {
		var v sql.NullInt64
		if err := s.db.QueryRow(q, projectID, MinActivityMs).Scan(&v); err != nil {
			return 0, err
		}
		if v.Int64 > best {
			best = v.Int64
		}
	}
	return best, nil
}

// TicketLinks returns the sessions associated (suggested or confirmed) with each ticket
// of the project, by ticket id.
func (s *Store) TicketLinks(projectID string) (map[string][]proto.SessionTicket, error) {
	rows, err := s.db.Query(`SELECT st.session_id,st.ticket_id,st.confirmed FROM session_tickets st
		JOIN tickets t ON t.id=st.ticket_id WHERE t.project_id=? ORDER BY st.ticket_id, st.session_id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]proto.SessionTicket{}
	for rows.Next() {
		var l proto.SessionTicket
		if err := rows.Scan(&l.SessionID, &l.TicketID, &l.Confirmed); err != nil {
			return nil, err
		}
		out[l.TicketID] = append(out[l.TicketID], l)
	}
	return out, rows.Err()
}

// TicketSessions returns the sessions associated with a ticket.
func (s *Store) TicketSessions(ticketID string) ([]proto.SessionTicket, error) {
	rows, err := s.db.Query(`SELECT session_id,ticket_id,confirmed FROM session_tickets WHERE ticket_id=? ORDER BY session_id`, ticketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.SessionTicket{}
	for rows.Next() {
		var l proto.SessionTicket
		if err := rows.Scan(&l.SessionID, &l.TicketID, &l.Confirmed); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}
