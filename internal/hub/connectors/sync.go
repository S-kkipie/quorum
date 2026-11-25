package connectors

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// Store is what the syncer needs from the store (implemented by *store.Store).
type Store interface {
	ListProjects() ([]proto.Project, error)
	GetProject(id string) (proto.Project, error)
	ConnectorToken(projectID string) (string, error)
	ListWorkspaces() ([]proto.Workspace, error)
	ReplaceTickets(projectID string, ts []proto.Ticket, now int64) ([]proto.TicketChange, error)
	ReplaceAllTickets(projectID string, ts []proto.Ticket, now int64) ([]proto.TicketChange, []proto.SessionTicket, error)
	ListTickets(projectID string) ([]proto.Ticket, error)
	ReplaceMeetingNotes(projectID string, ns []proto.MeetingNote, now int64) (bool, error)
	SetSyncResult(projectID, syncErr string, at int64) error
}

const (
	defaultIntervalMin = 5
	maxIntervalMin     = 60
)

// Syncer periodically syncs each project's tickets with its connector.
type Syncer struct {
	st      Store
	pub     func(proto.Envelope)
	newConn func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error)
	now     func() time.Time
	// OnChange is called after a sync that changed tickets.
	OnChange func(projectID string)
	// OnSynced is called after each successful sync of a project with the change-log rows it wrote
	// and whether the meeting notes changed. A failed sync does not call it.
	OnSynced func(projectID string, changes []proto.TicketChange, notesChanged bool)
	// OnLinksRemoved is called with the session links a full-list sync deleted with their tickets.
	OnLinksRemoved func(projectID string, links []proto.SessionTicket)
	tick           time.Duration

	mu      sync.Mutex
	wmu     sync.Mutex // serializes ticket writes with Invalidate
	base    context.Context
	running map[string]bool
	gen     map[string]int  // rises with Invalidate: the project's connector changed
	again   map[string]bool // a SyncNow arrived while another sync was running
	conns   map[string]cachedConn
	// emptyWarned: a full-list source answered an empty list while tickets are stored (logged once)
	emptyWarned map[string]bool
}

// cachedConn is a Reusable connector of a project and the configuration it was built from.
type cachedConn struct {
	key  string
	conn Connector
}

func NewSyncer(st Store, pub func(proto.Envelope)) *Syncer {
	return &Syncer{st: st, pub: pub, newConn: New, now: time.Now, tick: 30 * time.Second,
		base: context.Background(), running: map[string]bool{}, gen: map[string]int{}, again: map[string]bool{},
		conns: map[string]cachedConn{}, emptyWarned: map[string]bool{}}
}

func clampInterval(m int) time.Duration {
	if m <= 0 {
		m = defaultIntervalMin
	}
	if m > maxIntervalMin {
		m = maxIntervalMin
	}
	return time.Duration(m) * time.Minute
}

// Start launches the periodic goroutine and returns right away; stops when ctx is cancelled.
func (s *Syncer) Start(ctx context.Context) {
	s.mu.Lock()
	s.base = ctx
	s.mu.Unlock()
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		s.syncDue(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.syncDue(ctx)
			}
		}
	}()
}

func (s *Syncer) syncDue(ctx context.Context) {
	ps, err := s.st.ListProjects()
	if err != nil {
		log.Printf("sync: list projects: %v", err)
		return
	}
	now := s.now()
	for _, p := range ps {
		if p.Connector.Kind == "" || p.Connector.Kind == "none" {
			continue
		}
		if now.Sub(time.UnixMilli(p.SyncedAt)) < clampInterval(p.Connector.IntervalMin) {
			continue
		}
		id := p.ID
		go func() {
			if err := s.sync(ctx, id); err != nil {
				log.Printf("sync: project %s: %v", id, err)
			}
		}()
	}
}

// SyncNow syncs the project now and returns the sync error. If one is already
// running for that project it marks it to repeat when done (nil).
func (s *Syncer) SyncNow(projectID string) error {
	s.mu.Lock()
	ctx := s.base
	s.mu.Unlock()
	return s.syncAgain(ctx, projectID, true)
}

// Invalidate changes the connector's source: it runs fn (which deletes the old source's
// data) excluding the syncs' writes, and whatever a sync already
// running against the old source brings back is discarded.
func (s *Syncer) Invalidate(projectID string, fn func() error) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	s.mu.Lock()
	s.gen[projectID]++
	delete(s.conns, projectID)
	s.mu.Unlock()
	return fn()
}

// connKey identifies what a connector was built from: kind, settings, token and environment.
func connKey(cfg proto.ConnectorConfig, token string, env []string) string {
	b, _ := json.Marshal(struct {
		Kind     string
		Settings map[string]string
		Token    string
		Env      []string
	}{cfg.Kind, cfg.Settings, token, env})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// conn returns the project's connector: the cached one when it is Reusable and built from the same
// configuration and token, a new one otherwise.
func (s *Syncer) conn(p proto.Project, token string, env []string) (Connector, error) {
	key := connKey(p.Connector, token, env)
	s.mu.Lock()
	c, ok := s.conns[p.ID]
	s.mu.Unlock()
	if ok && c.key == key {
		return c.conn, nil
	}
	conn, err := s.newConn(p.Connector, token, env)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if r, ok := conn.(Reusable); ok && r.Reusable() {
		s.conns[p.ID] = cachedConn{key: key, conn: conn}
	} else {
		delete(s.conns, p.ID)
	}
	s.mu.Unlock()
	return conn, nil
}

func (s *Syncer) current(id string, g int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen[id] == g
}

func (s *Syncer) sync(ctx context.Context, id string) error { return s.syncAgain(ctx, id, false) }

func (s *Syncer) syncAgain(ctx context.Context, id string, queue bool) error {
	s.mu.Lock()
	if s.running[id] {
		if queue {
			s.again[id] = true
		}
		s.mu.Unlock()
		return nil
	}
	s.running[id] = true
	s.mu.Unlock()
	var err error
	for {
		err = s.syncOnce(ctx, id)
		s.mu.Lock()
		rerun := s.again[id] && ctx.Err() == nil
		delete(s.again, id)
		if !rerun {
			delete(s.running, id)
			s.mu.Unlock()
			return err
		}
		s.mu.Unlock()
	}
}

func (s *Syncer) syncOnce(ctx context.Context, id string) error {
	s.mu.Lock()
	g := s.gen[id]
	s.mu.Unlock()

	p, err := s.st.GetProject(id)
	if err != nil || p.Connector.Kind == "" || p.Connector.Kind == "none" {
		s.mu.Lock()
		delete(s.conns, id)
		s.mu.Unlock()
	}
	if err != nil {
		return err
	}
	if p.Connector.Kind == "" || p.Connector.Kind == "none" {
		return ErrNoConnector
	}
	start := s.now().UnixMilli() // before querying: what changes during the fetch will be seen on the next one
	res, err := s.fetch(ctx, p, g)
	if errors.Is(err, errStale) {
		return nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return err
		}
		s.wmu.Lock()
		if s.current(id, g) {
			if e := s.st.SetSyncResult(id, err.Error(), s.now().UnixMilli()); e != nil {
				log.Printf("sync: save result of %s: %v", id, e)
			}
		}
		s.wmu.Unlock()
		s.publishProject(id)
		return err
	}
	s.wmu.Lock()
	if !s.current(id, g) {
		s.wmu.Unlock()
		return nil
	}
	err = s.st.SetSyncResult(id, "", start)
	s.wmu.Unlock()
	if err != nil {
		return err
	}
	s.publishProject(id)
	s.publishTickets(id)
	if len(res.removed) > 0 && s.OnLinksRemoved != nil {
		s.OnLinksRemoved(id, res.removed)
	}
	if s.OnSynced != nil {
		s.OnSynced(id, res.changes, res.notesChanged)
	}
	return nil
}

// fetchResult is what a successful fetch stored.
type fetchResult struct {
	changes      []proto.TicketChange
	removed      []proto.SessionTicket // links deleted with their tickets (full-list sources)
	notesChanged bool
}

// errStale: the connector changed during the query; what was fetched is discarded.
var errStale = errors.New("the connector changed during the sync")

// fetch gets the tickets (and the meeting notes of a NoteLister), normalizes and stores them; on error the
// tickets and notes stay as they were. A notes failure is logged and keeps the previous notes; the tickets
// are still saved.
func (s *Syncer) fetch(ctx context.Context, p proto.Project, g int) (res fetchResult, err error) {
	var token string
	defer func() {
		if err != nil && err != errStale {
			err = errors.New(redact(err.Error(), token))
		}
	}()
	token, err = s.st.ConnectorToken(p.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return res, err
	}
	env := BuildEnv(s.st, p.WorkspaceID)
	conn, err := s.conn(p, token, env)
	if err != nil {
		return res, err
	}
	var since int64
	if p.SyncError == "" {
		since = p.SyncedAt
	}
	ts, err := conn.List(ctx, since)
	if err != nil {
		return res, err
	}
	custom := map[string]string{}
	if raw := p.Connector.Settings["statusMap"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &custom); err != nil {
			return res, fmt.Errorf("invalid statusMap: %v", err)
		}
	}
	out := make([]proto.Ticket, 0, len(ts))
	for _, t := range ts {
		if t.ExternalID == "" {
			return res, errors.New("the connector returned a ticket without externalId")
		}
		if t.RawStatus == "" {
			t.RawStatus = t.Status
		}
		t.Status = StatusMap(t.RawStatus, custom)
		out = append(out, t)
	}
	var notes []proto.MeetingNote
	haveNotes := false
	if nl, ok := conn.(NoteLister); ok {
		ns, nerr := nl.ListNotes(ctx)
		switch {
		case nerr != nil && ctx.Err() != nil:
			return res, ctx.Err()
		case nerr != nil:
			log.Printf("sync: project %s: meeting notes: %s", p.ID, redact(nerr.Error(), token))
		default:
			notes, haveNotes = ns, true
		}
	}
	s.wmu.Lock()
	if !s.current(p.ID, g) {
		s.wmu.Unlock()
		return res, errStale
	}
	before, _ := s.st.ListTickets(p.ID)
	now := s.now().UnixMilli()
	full := false
	if fl, ok := conn.(FullLister); ok && fl.FullList() {
		full = true
		if len(out) == 0 && len(before) > 0 {
			// never prune a project down to zero: an empty list is more likely a glitch at the source
			full = false
			s.mu.Lock()
			warn := !s.emptyWarned[p.ID]
			s.emptyWarned[p.ID] = true
			s.mu.Unlock()
			if warn {
				log.Printf("sync: project %s: the source listed no tickets; keeping the %d stored ones", p.ID, len(before))
			}
		} else if len(out) > 0 {
			s.mu.Lock()
			delete(s.emptyWarned, p.ID)
			s.mu.Unlock()
		}
	}
	if full {
		res.changes, res.removed, err = s.st.ReplaceAllTickets(p.ID, out, now)
	} else {
		res.changes, err = s.st.ReplaceTickets(p.ID, out, now)
	}
	if err == nil && haveNotes {
		if changed, nerr := s.st.ReplaceMeetingNotes(p.ID, notes, now); nerr != nil {
			log.Printf("sync: project %s: save meeting notes: %s", p.ID, redact(nerr.Error(), token))
		} else {
			res.notesChanged = changed
		}
	}
	s.wmu.Unlock()
	if err != nil {
		return fetchResult{}, err
	}
	if s.OnChange != nil {
		if after, err := s.st.ListTickets(p.ID); err == nil && ticketsChanged(before, after) {
			s.OnChange(p.ID)
		}
	}
	return res, nil
}

func (s *Syncer) publishProject(id string) {
	p, err := s.st.GetProject(id)
	if err != nil {
		return
	}
	pl, _ := json.Marshal(p) // Project carries no token
	s.pub(proto.Envelope{Type: "project_upsert", Payload: pl})
}

func (s *Syncer) publishTickets(id string) {
	ts, err := s.st.ListTickets(id)
	if err != nil {
		return
	}
	pl, _ := json.Marshal(struct {
		ProjectID string         `json:"projectId"`
		Tickets   []proto.Ticket `json:"tickets"`
	}{id, ts})
	s.pub(proto.Envelope{Type: "tickets", Payload: pl})
}

// BuildEnv is the environment the connectors are launched with (reads and writes):
// the process's plus the workspace's WHOAS_PROFILE.
func BuildEnv(st interface {
	ListWorkspaces() ([]proto.Workspace, error)
}, workspaceID string) []string {
	env := os.Environ()
	if ws, err := st.ListWorkspaces(); err == nil {
		for _, w := range ws {
			if w.ID == workspaceID && w.WhoasProfile != "" {
				env = append(env, "WHOAS_PROFILE="+w.WhoasProfile)
			}
		}
	}
	return env
}

// Redact hides the token in msg.
func Redact(msg, token string) string { return redact(msg, token) }

type tkey struct {
	status, title string
	upd           int64
}

func ticketsChanged(a, b []proto.Ticket) bool {
	if len(a) != len(b) {
		return true
	}
	m := make(map[string]tkey, len(a))
	for _, t := range a {
		m[t.ExternalID] = tkey{t.Status, t.Title, t.UpdatedAt}
	}
	for _, t := range b {
		if m[t.ExternalID] != (tkey{t.Status, t.Title, t.UpdatedAt}) {
			return true
		}
	}
	return false
}
