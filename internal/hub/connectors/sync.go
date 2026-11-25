package connectors

import (
	"context"
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
	ListTickets(projectID string) ([]proto.Ticket, error)
	ReplaceMeetingNotes(projectID string, ns []proto.MeetingNote) (bool, error)
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
	tick     time.Duration

	mu      sync.Mutex
	wmu     sync.Mutex // serializes ticket writes with Invalidate
	base    context.Context
	running map[string]bool
	gen     map[string]int  // rises with Invalidate: the project's connector changed
	again   map[string]bool // a SyncNow arrived while another sync was running
}

func NewSyncer(st Store, pub func(proto.Envelope)) *Syncer {
	return &Syncer{st: st, pub: pub, newConn: New, now: time.Now, tick: 30 * time.Second,
		base: context.Background(), running: map[string]bool{}, gen: map[string]int{}, again: map[string]bool{}}
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
	s.mu.Unlock()
	return fn()
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
	if s.OnSynced != nil {
		s.OnSynced(id, res.changes, res.notesChanged)
	}
	return nil
}

// fetchResult is what a successful fetch stored.
type fetchResult struct {
	changes      []proto.TicketChange
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
	conn, err := s.newConn(p.Connector, token, env)
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
	res.changes, err = s.st.ReplaceTickets(p.ID, out, s.now().UnixMilli())
	if err == nil && haveNotes {
		if changed, nerr := s.st.ReplaceMeetingNotes(p.ID, notes); nerr != nil {
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
