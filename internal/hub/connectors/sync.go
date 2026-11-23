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

// Store es lo que el sincronizador necesita del almacén (lo implementa *store.Store).
type Store interface {
	ListProjects() ([]proto.Project, error)
	GetProject(id string) (proto.Project, error)
	ConnectorToken(projectID string) (string, error)
	ListWorkspaces() ([]proto.Workspace, error)
	ReplaceTickets(projectID string, ts []proto.Ticket) error
	ListTickets(projectID string) ([]proto.Ticket, error)
	SetSyncResult(projectID, syncErr string, at int64) error
}

const (
	defaultIntervalMin = 5
	maxIntervalMin     = 60
)

// Syncer sincroniza periódicamente los tickets de cada proyecto con su conector.
type Syncer struct {
	st      Store
	pub     func(proto.Envelope)
	newConn func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error)
	now     func() time.Time
	// OnChange se llama tras una sincronización que cambió tickets.
	OnChange func(projectID string)
	tick     time.Duration

	mu      sync.Mutex
	wmu     sync.Mutex // serializa las escrituras de tickets con Invalidate
	base    context.Context
	running map[string]bool
	gen     map[string]int  // sube con Invalidate: el conector del proyecto cambió
	again   map[string]bool // llegó un SyncNow mientras otra sincronización corría
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

// Start lanza la goroutine periódica y vuelve enseguida; para al cancelarse ctx.
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
		log.Printf("sync: listar proyectos: %v", err)
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
				log.Printf("sync: proyecto %s: %v", id, err)
			}
		}()
	}
}

// SyncNow sincroniza ya el proyecto y devuelve el error de la sincronización. Si ya hay
// una en curso para ese proyecto la deja marcada para repetirse al terminar (nil).
func (s *Syncer) SyncNow(projectID string) error {
	s.mu.Lock()
	ctx := s.base
	s.mu.Unlock()
	return s.syncAgain(ctx, projectID, true)
}

// Invalidate cambia el origen del conector: ejecuta fn (que borra los datos del origen
// viejo) excluyendo las escrituras de las sincronizaciones, y lo que traiga una que ya
// estuviera en curso contra el origen viejo se descarta.
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
	start := s.now().UnixMilli() // antes de consultar: lo que cambie durante el fetch se verá en la siguiente
	err = s.fetch(ctx, p, g)
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
				log.Printf("sync: guardar resultado de %s: %v", id, e)
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
	return nil
}

// errStale: el conector cambió durante la consulta; se descarta lo traído.
var errStale = errors.New("el conector cambió durante la sincronización")

// fetch obtiene los tickets, los normaliza y los guarda; el error deja los tickets como estaban.
func (s *Syncer) fetch(ctx context.Context, p proto.Project, g int) (err error) {
	var token string
	defer func() {
		if err != nil && err != errStale {
			err = errors.New(redact(err.Error(), token))
		}
	}()
	token, err = s.st.ConnectorToken(p.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	env := BuildEnv(s.st, p.WorkspaceID)
	conn, err := s.newConn(p.Connector, token, env)
	if err != nil {
		return err
	}
	var since int64
	if p.SyncError == "" {
		since = p.SyncedAt
	}
	ts, err := conn.List(ctx, since)
	if err != nil {
		return err
	}
	custom := map[string]string{}
	if raw := p.Connector.Settings["statusMap"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &custom); err != nil {
			return fmt.Errorf("statusMap inválido: %v", err)
		}
	}
	out := make([]proto.Ticket, 0, len(ts))
	for _, t := range ts {
		if t.ExternalID == "" {
			return errors.New("el conector devolvió un ticket sin externalId")
		}
		if t.RawStatus == "" {
			t.RawStatus = t.Status
		}
		t.Status = StatusMap(t.RawStatus, custom)
		out = append(out, t)
	}
	s.wmu.Lock()
	if !s.current(p.ID, g) {
		s.wmu.Unlock()
		return errStale
	}
	before, _ := s.st.ListTickets(p.ID)
	err = s.st.ReplaceTickets(p.ID, out)
	s.wmu.Unlock()
	if err != nil {
		return err
	}
	if s.OnChange != nil {
		if after, err := s.st.ListTickets(p.ID); err == nil && ticketsChanged(before, after) {
			s.OnChange(p.ID)
		}
	}
	return nil
}

func (s *Syncer) publishProject(id string) {
	p, err := s.st.GetProject(id)
	if err != nil {
		return
	}
	pl, _ := json.Marshal(p) // Project no lleva token
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

// BuildEnv es el entorno con que se lanzan los conectores (lecturas y escrituras):
// el del proceso más WHOAS_PROFILE del trabajo.
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

// Redact oculta el token en msg.
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
