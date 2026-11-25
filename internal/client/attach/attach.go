// Package attach is `quorum attach <session>`: it mirrors a session's herdr pane through the hub's
// terminal relay, the same calls the web Terminal screen makes (watch lease renewed every 5 s,
// term_frame envelopes over /api/live, input as text and herdr key names).
package attach

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/client"
	"github.com/S-kkipie/quorum/internal/proto"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// renewEvery: the daemon's lease lasts 15 s and the app renews it every 5 s; a variable for tests.
var renewEvery = 5 * time.Second

// OfflineError: the session's machine is not connected to the hub.
type OfflineError struct{ Machine string }

func (e *OfflineError) Error() string { return e.Machine + " is offline" }

// Relay is one pane behind the hub.
type Relay struct {
	Cfg     client.Config
	Machine string
	Pane    string
}

func (r Relay) path(action string) string {
	return "/api/machines/" + url.PathEscape(r.Machine) + "/terminals/" + url.PathEscape(r.Pane) + "/" + action
}

// Watch starts or renews the watch lease.
func (r Relay) Watch(ctx context.Context) error { return r.post(ctx, "watch", nil) }

// Input sends text and/or herdr key names to the pane.
func (r Relay) Input(ctx context.Context, text string, keys []string) error {
	b, _ := json.Marshal(map[string]any{"text": text, "keys": keys})
	return r.post(ctx, "input", b)
}

func (r Relay) post(ctx context.Context, action string, body []byte) error {
	if body == nil {
		body = []byte("{}")
	}
	resp, err := client.Do(ctx, r.Cfg, "POST", r.path(action), body)
	if err != nil {
		if strings.Contains(err.Error(), "machine is offline") {
			return &OfflineError{r.Machine}
		}
		return err
	}
	resp.Body.Close()
	return nil
}

// Resolve finds a live session by id or unique id prefix.
func Resolve(ctx context.Context, cfg client.Config, arg string) (proto.SessionInfo, error) {
	ss, err := client.Sessions(ctx, cfg)
	if err != nil {
		return proto.SessionInfo{}, err
	}
	var found []proto.SessionInfo
	for _, s := range ss {
		if s.State == proto.StateClosed {
			continue
		}
		if s.ID == arg {
			return s, nil
		}
		if strings.HasPrefix(s.ID, arg) {
			found = append(found, s)
		}
	}
	switch len(found) {
	case 0:
		return proto.SessionInfo{}, fmt.Errorf("no live session %q", arg)
	case 1:
		return found[0], nil
	}
	return proto.SessionInfo{}, fmt.Errorf("%q matches more than one session", arg)
}

func online(ctx context.Context, cfg client.Config, machine string) (bool, error) {
	var ms []struct {
		Name   string `json:"name"`
		Online bool   `json:"online"`
	}
	if err := client.GetJSON(ctx, cfg, "/api/machines", &ms); err != nil {
		return false, err
	}
	for _, m := range ms {
		if m.Name == machine {
			return m.Online, nil
		}
	}
	return false, nil
}

// Run attaches to the session until Ctrl-] (nil), the machine goes offline (*OfflineError) or the
// pane closes. opts are extra program options (tests pass their input and output).
func Run(ctx context.Context, cfg client.Config, arg string, opts ...tea.ProgramOption) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // stops the lease renewals, the input sender and the live socket
	s, err := Resolve(ctx, cfg, arg)
	if err != nil {
		return err
	}
	if s.HerdrPane == "" {
		return errors.New("Not in a herdr pane on " + s.Machine)
	}
	if on, err := online(ctx, cfg, s.Machine); err != nil {
		return err
	} else if !on {
		return &OfflineError{s.Machine}
	}
	relay := Relay{Cfg: cfg, Machine: s.Machine, Pane: s.HerdrPane}
	live, err := client.Dial(ctx, cfg)
	if err != nil {
		return err
	}
	defer live.Close()
	if err := relay.Watch(ctx); err != nil {
		return err
	}

	in := make(chan item, 256)
	m := newModel(s, live.Envelopes(), in)
	p := tea.NewProgram(m, append([]tea.ProgramOption{tea.WithAltScreen(), tea.WithContext(ctx)}, opts...)...)
	report := func(err error) {
		if err != nil && ctx.Err() == nil {
			p.Send(errMsg{err})
		}
	}
	go renew(ctx, relay, renewEvery, report)
	go send(ctx, relay, in, report)
	final, err := p.Run()
	if errors.Is(err, tea.ErrProgramKilled) && ctx.Err() != nil {
		return nil // the tab closed (SIGHUP) or the caller stopped
	}
	if err != nil {
		return err
	}
	return final.(model).result
}

func renew(ctx context.Context, r Relay, every time.Duration, report func(error)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			report(r.Watch(ctx))
		}
	}
}

type item struct {
	text string
	keys []string
}

// send forwards the input in order, one request at a time, joining text typed while one is in flight.
func send(ctx context.Context, r Relay, in <-chan item, report func(error)) {
	var pending *item
	for {
		var it item
		if pending != nil {
			it, pending = *pending, nil
		} else {
			select {
			case <-ctx.Done():
				return
			case it = <-in:
			}
		}
	join:
		for it.text != "" {
			select {
			case n := <-in:
				if n.text == "" {
					pending = &n
					break join
				}
				it.text += n.text
			default:
				break join
			}
		}
		report(r.Input(ctx, it.text, it.keys))
	}
}

// mapKey turns a key press into what the relay accepts: text, or one of the herdr key names the
// hub allows. ok is false for keys the relay cannot send.
func mapKey(k tea.KeyMsg) (text string, keys []string, ok bool) {
	switch k.Type {
	case tea.KeyRunes:
		t := string(k.Runes)
		if k.Alt {
			t = "\x1b" + t
		}
		return t, nil, true
	case tea.KeySpace:
		return " ", nil, true
	case tea.KeyBackspace:
		return "\x7f", nil, true
	}
	name := map[tea.KeyType]string{
		tea.KeyEnter: "enter", tea.KeyEsc: "esc", tea.KeyTab: "tab",
		tea.KeyCtrlC: "ctrl+c", tea.KeyCtrlD: "ctrl+d", tea.KeyCtrlL: "ctrl+l",
		tea.KeyUp: "up", tea.KeyDown: "down", tea.KeyLeft: "left", tea.KeyRight: "right",
	}[k.Type]
	if name == "" {
		return "", nil, false
	}
	return "", []string{name}, true
}

type envMsg proto.Envelope
type errMsg struct{ err error }

type model struct {
	s      proto.SessionInfo
	envs   <-chan proto.Envelope
	in     chan<- item
	frame  proto.TermFrame
	have   bool
	status string
	result error
	width  int
	height int
}

func newModel(s proto.SessionInfo, envs <-chan proto.Envelope, in chan<- item) model {
	return model{s: s, envs: envs, in: in, width: 80, height: 24}
}

func (m model) wait() tea.Cmd {
	ch := m.envs
	return func() tea.Msg {
		env, ok := <-ch
		if !ok {
			return nil
		}
		return envMsg(env)
	}
}

func (m model) Init() tea.Cmd { return m.wait() }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case errMsg:
		var off *OfflineError
		if errors.As(msg.err, &off) {
			m.result = off
			return m, tea.Quit
		}
		m.status = msg.err.Error()
	case envMsg:
		return m.envelope(proto.Envelope(msg))
	case tea.KeyMsg:
		if msg.Type == tea.KeyCtrlCloseBracket {
			return m, tea.Quit
		}
		if text, keys, ok := mapKey(msg); ok {
			select {
			case m.in <- item{text, keys}:
			default:
				m.status = "input dropped: the relay is not keeping up"
			}
		}
	}
	return m, nil
}

func (m model) envelope(env proto.Envelope) (tea.Model, tea.Cmd) {
	switch env.Type {
	case "machine_status":
		var ms struct {
			Name   string `json:"name"`
			Online bool   `json:"online"`
		}
		if json.Unmarshal(env.Payload, &ms) == nil && ms.Name == m.s.Machine && !ms.Online {
			m.result = &OfflineError{m.s.Machine}
			return m, tea.Quit
		}
	case "term_frame":
		var f proto.TermFrame
		if env.Machine != m.s.Machine || json.Unmarshal(env.Payload, &f) != nil || f.Pane != m.s.HerdrPane {
			break
		}
		if f.Closed {
			m.result = fmt.Errorf("the terminal of %s on %s closed", title(m.s), m.s.Machine)
			return m, tea.Quit
		}
		m.frame, m.have, m.status = f, true, ""
	}
	return m, m.wait()
}

// title is what the app and the notifications call the session.
func title(s proto.SessionInfo) string { return client.SessionName(s) }

var footStyle = lipgloss.NewStyle().Faint(true)

// View is the pane's latest frame (its bottom rows when the terminal is shorter) and a footer.
func (m model) View() string {
	foot := title(m.s) + " · " + m.s.Machine + "  Ctrl-] detach"
	if m.status != "" {
		foot = m.status
	}
	if !m.have {
		return "Connecting to the terminal…\n" + footStyle.Render(foot)
	}
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(m.frame.ANSI, "\r\n", "\n"), "\n"), "\n")
	if h := m.height - 1; h > 0 && len(lines) > h {
		lines = lines[len(lines)-h:]
	}
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\x1b[0m\n") // no colour bleeds into the next line or the footer
	}
	b.WriteString(footStyle.Render(foot))
	return b.String()
}
