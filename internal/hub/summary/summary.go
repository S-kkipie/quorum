// Package summary mantiene el resumen de 1–2 líneas de cada proyecto (lo genera Haiku).
package summary

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	minGap       = 30 * time.Minute
	retryGap     = 5 * time.Minute
	inactiveFor  = 7 * 24 * time.Hour
	maxSummary   = 200
	maxTitles    = 40
	maxTurnEnds  = 5
	maxAnswer    = 300
	maxRecap     = 300
	loopInterval = time.Minute
)

// Summarizer genera el resumen de los proyectos tocados.
type Summarizer struct {
	st    *store.Store
	model Model
	pub   func(proto.Envelope)
	now   func() time.Time

	mu    sync.Mutex
	dirty map[string]bool
	retry map[string]time.Time // no reintentar antes de esta hora tras un error
	hash  map[string]string    // última entrada con que se generó cada proyecto
	gen   sync.Mutex           // una generación a la vez
}

func New(st *store.Store, m Model, pub func(proto.Envelope)) *Summarizer {
	return &Summarizer{st: st, model: m, pub: pub, now: time.Now, dirty: map[string]bool{}, retry: map[string]time.Time{}, hash: map[string]string{}}
}

// Touch marca el proyecto como cambiado; el bucle lo resumirá cuando toque.
func (s *Summarizer) Touch(projectID string) {
	if projectID == "" {
		return
	}
	s.mu.Lock()
	s.dirty[projectID] = true
	s.mu.Unlock()
}

// Forget olvida el estado del proyecto (pendiente, reintento, última entrada): se borró.
func (s *Summarizer) Forget(projectID string) {
	s.mu.Lock()
	delete(s.dirty, projectID)
	delete(s.retry, projectID)
	delete(s.hash, projectID)
	s.mu.Unlock()
}

// Pending indica si el resumidor guarda algún estado del proyecto.
func (s *Summarizer) Pending(projectID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, r := s.retry[projectID]
	_, h := s.hash[projectID]
	return s.dirty[projectID] || r || h
}

// Start lanza el bucle (cada minuto) y vuelve enseguida; para al cancelarse ctx.
// Al arrancar marca como pendientes los proyectos sin resumen.
func (s *Summarizer) Start(ctx context.Context) {
	if ps, err := s.st.ListProjects(); err == nil {
		for _, p := range ps {
			if p.SummaryAt == 0 {
				s.Touch(p.ID)
			}
		}
	}
	go func() {
		t := time.NewTicker(loopInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.RunOnce(ctx)
			}
		}
	}()
}

// RunOnce procesa los proyectos pendientes que ya toca resumir.
func (s *Summarizer) RunOnce(ctx context.Context) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.dirty))
	for id := range s.dirty {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		s.process(ctx, id)
	}
}

func (s *Summarizer) process(ctx context.Context, id string) {
	s.gen.Lock()
	defer s.gen.Unlock()
	p, err := s.st.GetProject(id)
	if errors.Is(err, store.ErrNotFound) {
		s.Forget(id) // proyecto borrado
		return
	}
	if err != nil {
		log.Printf("summary: proyecto %s: %v", id, err)
		return
	}
	now := s.now()
	if p.SummaryAt != 0 && now.Sub(time.UnixMilli(p.SummaryAt)) < minGap {
		return
	}
	s.mu.Lock()
	if t, ok := s.retry[id]; ok && now.Before(t) {
		s.mu.Unlock()
		return
	}
	delete(s.dirty, id) // lo que cambie durante la generación vuelve a marcarlo
	s.mu.Unlock()

	text, h, same, err := s.generate(ctx, p, now)
	if err != nil {
		log.Printf("summary: proyecto %s: %v", id, err)
		s.mu.Lock()
		s.dirty[id] = true
		s.retry[id] = now.Add(retryGap)
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	delete(s.retry, id)
	s.mu.Unlock()
	if text == "" {
		return
	}
	if text == p.Summary && p.SummaryAt != 0 && strings.HasPrefix(text, "Sin actividad desde") {
		return // texto fijo sin cambios: ni se guarda ni se publica
	}
	if err := s.st.SetProjectSummary(id, text, now.UnixMilli()); err != nil {
		log.Printf("summary: guardar %s: %v", id, err)
		return
	}
	if h != "" {
		s.mu.Lock()
		s.hash[id] = h
		s.mu.Unlock()
	}
	if same {
		return // solo se renovó el plazo: nada visible cambió
	}
	if np, err := s.st.GetProject(id); err == nil {
		pl, _ := json.Marshal(np)
		s.pub(proto.Envelope{Type: "project_upsert", Payload: pl})
	}
}

// generate devuelve el texto nuevo ("" = nada que guardar).
func (s *Summarizer) generate(ctx context.Context, p proto.Project, now time.Time) (string, string, bool, error) {
	act, err := s.st.ProjectActivity(p.ID)
	if err != nil {
		return "", "", false, err
	}
	live := s.liveSessions(p.ID)
	// Con una sesión abierta el proyecto no está inactivo, aunque los tickets sean viejos.
	if len(live) == 0 && act >= store.MinActivityMs && now.Sub(time.UnixMilli(act)) > inactiveFor {
		return "Sin actividad desde " + time.UnixMilli(act).Format("02/01/2006"), "", false, nil
	}
	tickets, err := s.st.ListTickets(p.ID)
	if err != nil {
		return "", "", false, err
	}
	if act == 0 && len(tickets) == 0 && len(live) == 0 {
		return "", "", false, nil
	}
	tes, err := s.st.ProjectTurnEnds(p.ID, maxTurnEnds)
	if err != nil {
		return "", "", false, err
	}
	sum := sha256.Sum256([]byte(buildPrompt(p, tickets, live, tes, false)))
	h := hex.EncodeToString(sum[:])
	s.mu.Lock()
	same := s.hash[p.ID] == h
	s.mu.Unlock()
	if same && p.Summary != "" {
		return p.Summary, h, true, nil // nada cambió: se renueva el plazo sin llamar al modelo
	}
	out, err := s.model.Complete(ctx, buildPrompt(p, tickets, live, tes, true))
	if err != nil {
		return "", "", false, err
	}
	out = Clean(out)
	if out == "" {
		return "", "", false, fmt.Errorf("el modelo devolvió un resumen vacío")
	}
	return out, h, false, nil
}

func (s *Summarizer) liveSessions(projectID string) []proto.SessionInfo {
	ss, err := s.st.ListSessions(false)
	if err != nil {
		return nil
	}
	var out []proto.SessionInfo
	for _, si := range ss {
		if si.ProjectID == projectID && si.Role != proto.RoleService {
			out = append(out, si)
		}
	}
	return out
}

func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// Clean deja el texto en una línea, sin comillas envolventes y a 200 caracteres como máximo.
func Clean(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	s = strings.Trim(s, "\"'“”«» ")
	return strings.TrimSpace(cut(s, maxSummary))
}

func buildPrompt(p proto.Project, ts []proto.Ticket, live []proto.SessionInfo, tes []proto.Event, withState bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Proyecto: %s\n", p.Name)
	left := maxTitles
	by := map[string][]string{}
	for _, t := range ts {
		by[t.Status] = append(by[t.Status], t.Title)
	}
	b.WriteString("\nTickets por estado:\n")
	if len(ts) == 0 {
		b.WriteString("(sin tickets)\n")
	}
	for _, st := range store.TicketStatuses {
		titles := by[st]
		if len(titles) == 0 {
			continue
		}
		fmt.Fprintf(&b, "- %s (%d):\n", st, len(titles))
		for _, t := range titles {
			if left == 0 {
				b.WriteString("  ...\n")
				break
			}
			left--
			fmt.Fprintf(&b, "  * %s\n", cut(oneLine(t), 120))
		}
	}
	b.WriteString("\nSesiones vivas:\n")
	if len(live) == 0 {
		b.WriteString("(ninguna)\n")
	}
	for _, si := range live {
		if withState {
			fmt.Fprintf(&b, "- [%s] %s\n", si.State, cut(oneLine(si.Recap), maxRecap))
		} else {
			fmt.Fprintf(&b, "- %s\n", cut(oneLine(si.Recap), maxRecap))
		}
	}
	b.WriteString("\nÚltimas respuestas de las sesiones:\n")
	n := 0
	for _, e := range tes {
		var te proto.TurnEnd
		if json.Unmarshal(e.Data, &te) != nil || strings.TrimSpace(te.Answer) == "" {
			continue
		}
		n++
		fmt.Fprintf(&b, "- %s\n", cut(oneLine(te.Answer), maxAnswer))
	}
	if n == 0 {
		b.WriteString("(ninguna)\n")
	}
	b.WriteString("\nEn 1 o 2 frases (máx. 200 caracteres): en qué va el proyecto y qué lo frena. Responde solo con el resumen, sin comillas ni preámbulo.")
	return strings.ReplaceAll(b.String(), "\x00", "")
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
