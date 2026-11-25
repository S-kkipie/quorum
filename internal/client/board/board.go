// Package board is `quorum board`: a terminal list of every session on every machine, grouped by
// attention, where Enter jumps to the session's herdr pane.
package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/client"
	"github.com/S-kkipie/quorum/internal/proto"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Jumper moves the owner to a session: Focus a local herdr pane, or OpenAttach a remote one in a new tab.
type Jumper interface {
	Focus(ctx context.Context, pane string) error
	OpenAttach(ctx context.Context, s proto.SessionInfo) error
}

// Groups in display order, with their labels (the app's labels for the same states).
var groups = []struct{ state, label string }{
	{"needs_you", "Needs you"},
	{"working", "Working"},
	{"background", "Background"},
	{"done", "Done · unread"},
	{"idle", "Idle"},
}

var rank = func() map[string]int {
	m := map[string]int{}
	for i, g := range groups {
		m[g.state] = i
	}
	return m
}()

// displayState mirrors app/src/lib/sessions.ts: idle and unread is "done", the legacy waiting is
// idle, unknown states group as idle.
func displayState(s proto.SessionInfo) string {
	st := string(s.State)
	switch {
	case st == "idle" && s.Unread:
		return "done"
	case st == "waiting":
		return "idle"
	}
	if _, ok := rank[st]; !ok {
		return "idle"
	}
	return st
}

func label(state string) string { return groups[rank[state]].label }

type envMsg proto.Envelope
type liveClosedMsg struct{ err error }
type jumpedMsg struct{ err error }

const jumpTimeout = 10 * time.Second

// Model is the Bubble Tea model of the board.
type Model struct {
	notice  []string     // shown instead of the board (not paired, broken config, revoked)
	local   string       // this machine's name
	jumper  Jumper
	envs    <-chan proto.Envelope
	liveErr func() error // why envs closed

	sessions map[string]proto.SessionInfo
	order    map[string]int // arrival order, kept within a group
	next     int
	projects map[string]string // project id -> name

	rows      []proto.SessionInfo
	cursor    string // selected session id
	moved     bool   // the owner moved the cursor; until then it follows the top row
	filter    string
	filtering bool
	status    string
	busy      bool
	width     int
	height    int
}

// New builds the model; envs is the live feed (nil in tests that feed envelopes by hand).
func New(paired bool, local string, j Jumper, envs <-chan proto.Envelope) Model {
	m := Model{local: local, jumper: j, envs: envs,
		sessions: map[string]proto.SessionInfo{}, order: map[string]int{}, projects: map[string]string{}, width: 80, height: 24}
	if !paired {
		m.notice = noticeFor(client.ErrNotPaired)
	}
	return m
}

// noticeFor is what the board shows instead of the sessions when it cannot use the hub.
func noticeFor(err error) []string {
	switch {
	case errors.Is(err, client.ErrNotPaired):
		return []string{"Not paired.", "Run quorum pair <hub> <code>"}
	case errors.Is(err, client.ErrUnauthorized):
		return []string{"This device was revoked.", "Run quorum pair <hub> <code>"}
	}
	return []string{"quorum: " + err.Error()}
}

func (m Model) wait() tea.Cmd {
	if m.envs == nil {
		return nil
	}
	ch, liveErr := m.envs, m.liveErr
	return func() tea.Msg {
		env, ok := <-ch
		if !ok {
			var err error
			if liveErr != nil {
				err = liveErr()
			}
			return liveClosedMsg{err: err}
		}
		return envMsg(env)
	}
}

// Init starts reading the live feed.
func (m Model) Init() tea.Cmd { return m.wait() }

// Rows are the visible sessions in display order.
func (m Model) Rows() []proto.SessionInfo { return m.rows }

// Selected is the session under the cursor (zero value when there is none).
func (m Model) Selected() proto.SessionInfo {
	if i := m.index(); i >= 0 {
		return m.rows[i]
	}
	return proto.SessionInfo{}
}

func (m Model) index() int {
	for i, s := range m.rows {
		if s.ID == m.cursor {
			return i
		}
	}
	return -1
}

// Update handles keys, live envelopes and jump results.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case envMsg:
		m.apply(proto.Envelope(msg))
		m.refresh()
		return m, m.wait()
	case liveClosedMsg:
		if msg.err != nil {
			m.notice = noticeFor(msg.err)
		}
		return m, nil
	case jumpedMsg:
		m.busy = false
		if msg.err != nil {
			m.status = msg.err.Error()
			return m, nil
		}
		return m, tea.Quit
	case tea.KeyMsg:
		return m.key(msg)
	}
	return m, nil
}

func (m Model) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.Type == tea.KeyCtrlC {
		return m, tea.Quit
	}
	if m.notice != nil {
		if k.Type == tea.KeyEsc || k.String() == "q" {
			return m, tea.Quit
		}
		return m, nil
	}
	if m.filtering {
		switch k.Type {
		case tea.KeyEnter:
			m.filtering = false
		case tea.KeyEsc:
			m.filtering, m.filter = false, ""
		case tea.KeyBackspace:
			if r := []rune(m.filter); len(r) > 0 {
				m.filter = string(r[:len(r)-1])
			}
		case tea.KeyRunes, tea.KeySpace:
			m.filter += string(k.Runes)
		case tea.KeyUp, tea.KeyDown:
			m.move(k.Type == tea.KeyDown)
			return m, nil
		default:
			return m, nil
		}
		m.refresh()
		return m, nil
	}
	m.status = ""
	switch k.String() {
	case "up", "k":
		m.move(false)
	case "down", "j":
		m.move(true)
	case "/":
		m.filtering = true
	case "esc":
		if m.filter != "" {
			m.filter = ""
			m.refresh()
			return m, nil
		}
		return m, tea.Quit
	case "q":
		return m, tea.Quit
	case "enter":
		return m.enter()
	}
	return m, nil
}

func (m *Model) move(down bool) {
	i := m.index()
	if down && i < len(m.rows)-1 {
		i++
	} else if !down && i > 0 {
		i--
	}
	if i >= 0 && i < len(m.rows) {
		m.cursor = m.rows[i].ID
		m.moved = true
	}
}

func (m Model) enter() (tea.Model, tea.Cmd) {
	s := m.Selected()
	if s.ID == "" || m.busy {
		return m, nil
	}
	if s.HerdrPane == "" {
		m.status = "Not in a herdr pane on " + s.Machine
		return m, nil
	}
	m.busy = true
	j := m.jumper
	local := s.Machine == m.local
	return m, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), jumpTimeout)
		defer cancel()
		if local {
			return jumpedMsg{j.Focus(ctx, s.HerdrPane)}
		}
		return jumpedMsg{j.OpenAttach(ctx, s)}
	}
}

func (m *Model) apply(env proto.Envelope) {
	switch env.Type {
	case client.EnvConnected:
		// a new connection: its snapshot replaces whatever the previous one reported
		m.sessions = map[string]proto.SessionInfo{}
	case "session_upsert":
		var s proto.SessionInfo
		if json.Unmarshal(env.Payload, &s) != nil || s.ID == "" {
			return
		}
		if _, seen := m.order[s.ID]; !seen {
			m.order[s.ID] = m.next
			m.next++
		}
		if p := s.PreviousID; p != "" && p != s.ID {
			old, ok := m.sessions[p]
			alive := ok && old.State != proto.StateClosed
			cur, ok2 := m.sessions[s.ID]
			// a previousId alive next to a live new id is an old rename: both stay (as the app does)
			if !(alive && ok2 && cur.State != proto.StateClosed) {
				if n, ok := m.order[p]; ok {
					m.order[s.ID] = n
				}
				delete(m.sessions, p)
				if m.cursor == p {
					m.cursor = s.ID
				}
			}
		}
		m.sessions[s.ID] = s
	case "session_gone", "session_removed":
		delete(m.sessions, env.Session)
	case "project_upsert":
		var p proto.Project
		if json.Unmarshal(env.Payload, &p) == nil && p.ID != "" {
			m.projects[p.ID] = p.Name
		}
	}
}

// project is the project name, else the basename of the session's root or cwd.
func (m Model) project(s proto.SessionInfo) string {
	if n := m.projects[s.ProjectID]; n != "" {
		return n
	}
	dir := strings.TrimRight(strings.ReplaceAll(firstNonEmpty(s.Root, s.Cwd), `\`, "/"), "/")
	if dir == "" {
		return ""
	}
	return path.Base(dir)
}

// name is what the app and the notifications call the session.
func name(s proto.SessionInfo) string { return client.SessionName(s) }

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func (m Model) matches(s proto.SessionInfo) bool {
	if m.filter == "" {
		return true
	}
	q := strings.ToLower(m.filter)
	for _, f := range []string{name(s), s.Name, m.project(s), s.Machine} {
		if strings.Contains(strings.ToLower(f), q) {
			return true
		}
	}
	return false
}

// refresh recomputes the visible rows and keeps the cursor on a visible session.
func (m *Model) refresh() {
	rows := make([]proto.SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.State == proto.StateClosed || !m.matches(s) {
			continue
		}
		rows = append(rows, s)
	}
	// insertion sort keeps this dependency-free and stable; lists are small
	less := func(a, b proto.SessionInfo) bool {
		ra, rb := rank[displayState(a)], rank[displayState(b)]
		if ra != rb {
			return ra < rb
		}
		return m.order[a.ID] < m.order[b.ID]
	}
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && less(rows[j], rows[j-1]); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
	m.rows = rows
	if !m.moved || m.index() < 0 {
		m.cursor = ""
		if len(rows) > 0 {
			m.cursor = rows[0].ID
		}
	}
}

var (
	headerStyle = lipgloss.NewStyle().Bold(true)
	selStyle    = lipgloss.NewStyle().Reverse(true)
	dimStyle    = lipgloss.NewStyle().Faint(true)
)

// View draws the groups, the rows that fit and the status line.
func (m Model) View() string {
	w := m.width
	if w <= 0 {
		w = 80
	}
	if m.notice != nil {
		var b strings.Builder
		for _, l := range m.notice {
			b.WriteString(fit(l, w) + "\n")
		}
		return b.String() + "\n" + dimStyle.Render(fit("q quit", w))
	}
	var lines []string
	sel := -1
	last := ""
	for _, s := range m.rows {
		st := displayState(s)
		if st != last {
			if last != "" {
				lines = append(lines, "")
			}
			n := 0
			for _, x := range m.rows {
				if displayState(x) == st {
					n++
				}
			}
			lines = append(lines, headerStyle.Render(fit(fmt.Sprintf("%s (%d)", label(st), n), w)))
			last = st
		}
		if s.ID == m.cursor {
			sel = len(lines)
		}
		lines = append(lines, m.row(s, s.ID == m.cursor, w))
	}
	if len(m.rows) == 0 {
		if m.filter != "" {
			lines = append(lines, dimStyle.Render(fit("No session matches.", w)))
		} else {
			lines = append(lines, dimStyle.Render(fit("No sessions.", w)))
		}
	}
	lines = scroll(lines, sel, m.height-1)
	return strings.Join(lines, "\n") + "\n" + m.statusLine(w)
}

func (m Model) statusLine(w int) string {
	switch {
	case m.filtering:
		return fit("/"+m.filter, w)
	case m.status != "":
		return fit(m.status, w)
	case m.filter != "":
		return dimStyle.Render(fit("/"+m.filter+"  esc clear", w))
	}
	return dimStyle.Render(fit("↑↓ move  / filter  enter jump  q quit", w))
}

// scroll keeps at most h lines, with the selected line visible.
func scroll(lines []string, sel, h int) []string {
	if h <= 0 || len(lines) <= h {
		return lines
	}
	start := 0
	if sel >= h {
		start = sel - h + 1
	}
	return lines[start : start+h]
}

// stateCol is the width of the longest state label ("Done · unread").
var stateCol = func() int {
	n := 0
	for _, g := range groups {
		n = max(n, width(g.label))
	}
	return n
}()

// row: "> name  machine  project  State", cut to w columns with the state always visible.
func (m Model) row(s proto.SessionInfo, selected bool, w int) string {
	prefix := "  "
	if selected {
		prefix = "> "
	}
	state := label(displayState(s))
	if w > 30 { // a fixed, right-aligned state column when there is room for it
		state = strings.Repeat(" ", stateCol-width(state)) + state
	}
	avail := w - width(prefix) - width(state) - 1
	var body string
	switch {
	case avail < 1:
		body = ""
	case avail < 12:
		body = pad(cut(name(s), avail), avail)
	default:
		// name 45 %, machine 20 %, project the rest, separated by two spaces
		inner := avail - 4
		nw := inner * 45 / 100
		mw := inner * 20 / 100
		pw := inner - nw - mw
		body = pad(cut(name(s), nw), nw) + "  " + pad(cut(s.Machine, mw), mw) + "  " + pad(cut(m.project(s), pw), pw)
	}
	line := fit(prefix+body+" "+state, w)
	if selected {
		return selStyle.Render(line)
	}
	return line
}

// Run shows the board until the owner quits or jumps. Without a usable client.json, or once the
// hub rejects the token, it says how to pair instead.
func Run(ctx context.Context, opts ...tea.ProgramOption) error {
	m, closeLive, err := load(ctx, client.Load, client.Dial)
	if err != nil {
		return err
	}
	defer closeLive()
	_, err = tea.NewProgram(m, append([]tea.ProgramOption{tea.WithAltScreen(), tea.WithContext(ctx)}, opts...)...).Run()
	if errors.Is(err, tea.ErrProgramKilled) && ctx.Err() != nil {
		return nil
	}
	return err
}

// load builds the model from client.json and the live feed; a Load error becomes the notice.
func load(ctx context.Context, loadCfg func() (client.Config, error), dial func(context.Context, client.Config) (*client.Live, error)) (Model, func(), error) {
	cfg, lerr := loadCfg()
	local := cfg.Machine
	if local == "" {
		local = client.DaemonMachine()
	}
	if lerr != nil {
		m := New(true, local, NewHerdr(), nil)
		m.notice = noticeFor(lerr)
		return m, func() {}, nil
	}
	live, err := dial(ctx, cfg)
	if err != nil {
		return Model{}, nil, err
	}
	m := New(true, local, NewHerdr(), live.Envelopes())
	m.liveErr = live.Err
	return m, live.Close, nil
}
