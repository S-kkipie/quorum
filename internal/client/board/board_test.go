package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/S-kkipie/quorum/internal/client"
	"github.com/S-kkipie/quorum/internal/proto"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"
	"github.com/stretchr/testify/require"
)

type fakeJumper struct {
	focused  []string
	attached []string
	err      error
}

func (f *fakeJumper) Focus(_ context.Context, pane string) error {
	f.focused = append(f.focused, pane)
	return f.err
}

func (f *fakeJumper) OpenAttach(_ context.Context, s proto.SessionInfo) error {
	f.attached = append(f.attached, s.ID)
	return f.err
}

func upsert(s proto.SessionInfo) proto.Envelope {
	p, _ := json.Marshal(s)
	return proto.Envelope{Type: "session_upsert", Machine: s.Machine, Session: s.ID, Payload: p}
}

func newModel(j Jumper) Model {
	m := New(true, "laptop", j, nil)
	m, _ = step(m, tea.WindowSizeMsg{Width: 100, Height: 30})
	return m
}

func step(m Model, msg tea.Msg) (Model, tea.Cmd) {
	nm, cmd := m.Update(msg)
	return nm.(Model), cmd
}

func feed(m Model, envs ...proto.Envelope) Model {
	for _, e := range envs {
		m, _ = step(m, envMsg(e))
	}
	return m
}

func key(s string) tea.KeyMsg {
	switch s {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

// run executes cmd (and a batch's children) and feeds every resulting message back into the model.
func run(t *testing.T, m Model, cmd tea.Cmd) (Model, bool) {
	t.Helper()
	quit := false
	for cmd != nil {
		msg := cmd()
		if _, ok := msg.(tea.QuitMsg); ok {
			return m, true
		}
		if msg == nil {
			return m, quit
		}
		m, cmd = step(m, msg)
	}
	return m, quit
}

func ids(m Model) []string {
	var out []string
	for _, s := range m.Rows() {
		out = append(out, s.ID)
	}
	return out
}

func sample() []proto.Envelope {
	return []proto.Envelope{
		upsert(proto.SessionInfo{ID: "idle1", Machine: "laptop", Name: "idle", State: proto.StateIdle}),
		upsert(proto.SessionInfo{ID: "done1", Machine: "vps-1", Name: "finished", State: proto.StateIdle, Unread: true}),
		upsert(proto.SessionInfo{ID: "work1", Machine: "vps-1", Name: "api", State: proto.StateWorking, Root: "/srv/api"}),
		upsert(proto.SessionInfo{ID: "bg1", Machine: "laptop", Name: "loop", State: proto.StateBackground}),
		upsert(proto.SessionInfo{ID: "need1", Machine: "laptop", Name: "web", State: proto.StateNeedsYou, HerdrPane: "w1:p2"}),
		upsert(proto.SessionInfo{ID: "wait1", Machine: "laptop", Name: "legacy", State: proto.StateWaiting}),
		upsert(proto.SessionInfo{ID: "closed1", Machine: "laptop", Name: "gone", State: proto.StateClosed}),
	}
}

func TestOrderingGroupsAndHidesClosed(t *testing.T) {
	m := feed(newModel(&fakeJumper{}), sample()...)
	require.Equal(t, []string{"need1", "work1", "bg1", "done1", "idle1", "wait1"}, ids(m))

	v := m.View()
	for _, h := range []string{"Needs you", "Working", "Background", "Done · unread", "Idle"} {
		require.Contains(t, v, h)
	}
	require.NotContains(t, v, "gone")
	require.Less(t, strings.Index(v, "web"), strings.Index(v, "api"))
}

func TestGoneRemovedRenameAndReconnect(t *testing.T) {
	m := feed(newModel(&fakeJumper{}), sample()...)
	m = feed(m, proto.Envelope{Type: "session_gone", Session: "work1"})
	m = feed(m, proto.Envelope{Type: "session_removed", Session: "bg1"})
	require.NotContains(t, ids(m), "work1")
	require.NotContains(t, ids(m), "bg1")

	// a rename (previousId) replaces the old id in place
	m = feed(m, upsert(proto.SessionInfo{ID: "need2", PreviousID: "need1", Machine: "laptop", Name: "web", State: proto.StateNeedsYou}))
	require.Equal(t, "need2", ids(m)[0])
	require.NotContains(t, ids(m), "need1")

	// a reconnect drops what the new snapshot no longer carries
	m = feed(m, proto.Envelope{Type: client.EnvConnected}, upsert(proto.SessionInfo{ID: "idle1", Machine: "laptop", State: proto.StateIdle}))
	require.Equal(t, []string{"idle1"}, ids(m))
}

func TestRowShowsNameMachineProjectState(t *testing.T) {
	m := feed(newModel(&fakeJumper{}),
		proto.Envelope{Type: "project_upsert", Payload: json.RawMessage(`{"id":"p1","name":"Billing"}`)},
		upsert(proto.SessionInfo{ID: "a", Machine: "vps-1", ProjectID: "p1", State: proto.StateWorking}),
		upsert(proto.SessionInfo{ID: "b", Machine: "laptop", Name: "docs", Root: "/home/u/docs-site/", State: proto.StateIdle}),
	)
	lines := strings.Split(m.View(), "\n")
	var a, b string
	for _, l := range lines {
		if strings.Contains(l, "Billing") {
			a = l
		}
		if strings.Contains(l, "docs-site") {
			b = l
		}
	}
	require.Contains(t, a, "Session") // no name
	require.Contains(t, a, "vps-1")
	require.Contains(t, a, "Working")
	require.Contains(t, b, "docs")
	require.Contains(t, b, "laptop")
	require.Contains(t, b, "Idle")
}

func TestNavigationAndFilter(t *testing.T) {
	m := feed(newModel(&fakeJumper{}), sample()...)
	require.Equal(t, "need1", m.Selected().ID)
	m, _ = step(m, key("j"))
	m, _ = step(m, key("down"))
	require.Equal(t, "bg1", m.Selected().ID)
	m, _ = step(m, key("k"))
	require.Equal(t, "work1", m.Selected().ID)
	m, _ = step(m, key("up"))
	m, _ = step(m, key("up")) // clamps at the top
	require.Equal(t, "need1", m.Selected().ID)

	// "/" filters by substring on name, project and machine
	m, _ = step(m, key("/"))
	for _, r := range "vps" {
		m, _ = step(m, key(string(r)))
	}
	require.Equal(t, []string{"work1", "done1"}, ids(m))
	require.Contains(t, m.View(), "/vps")
	// backspace edits the query
	m, _ = step(m, key("backspace"))
	m, _ = step(m, key("backspace"))
	m, _ = step(m, key("backspace"))
	m, _ = step(m, key("API"))
	require.Equal(t, []string{"work1"}, ids(m)) // case-insensitive, matches the project root basename too
	m, _ = step(m, key("enter"))                // leaves filter mode, keeps the filter
	require.Equal(t, []string{"work1"}, ids(m))
	m, _ = step(m, key("esc")) // clears the filter
	require.Len(t, ids(m), 6)
	_, cmd := step(m, key("esc")) // quits
	require.NotNil(t, cmd)
	require.IsType(t, tea.QuitMsg{}, cmd())
}

func TestQuitWithQ(t *testing.T) {
	m := feed(newModel(&fakeJumper{}), sample()...)
	_, cmd := step(m, key("q"))
	require.NotNil(t, cmd)
	require.IsType(t, tea.QuitMsg{}, cmd())
}

func TestEnterLocalFocusesPane(t *testing.T) {
	j := &fakeJumper{}
	m := feed(newModel(j), sample()...)
	m, cmd := step(m, key("enter"))
	_, quit := run(t, m, cmd)
	require.True(t, quit)
	require.Equal(t, []string{"w1:p2"}, j.focused)
	require.Empty(t, j.attached)
}

func TestEnterRemoteOpensAttachTab(t *testing.T) {
	j := &fakeJumper{}
	m := feed(newModel(j), upsert(proto.SessionInfo{ID: "r1", Machine: "vps-1", Name: "api", State: proto.StateWorking, HerdrPane: "w3:p1"}))
	m, cmd := step(m, key("enter"))
	_, quit := run(t, m, cmd)
	require.True(t, quit)
	require.Equal(t, []string{"r1"}, j.attached)
	require.Empty(t, j.focused)
}

func TestEnterWithoutPaneShowsStatus(t *testing.T) {
	j := &fakeJumper{}
	m := feed(newModel(j), upsert(proto.SessionInfo{ID: "x", Machine: "vps-1", Name: "api", State: proto.StateWorking}))
	m, cmd := step(m, key("enter"))
	m, quit := run(t, m, cmd)
	require.False(t, quit)
	require.Contains(t, m.View(), "Not in a herdr pane on vps-1")
	require.Empty(t, j.focused)
	require.Empty(t, j.attached)
}

func TestEnterHerdrErrorStays(t *testing.T) {
	j := &fakeJumper{err: errors.New("herdr: agent target w1:p2 not found")}
	m := feed(newModel(j), sample()...)
	m, cmd := step(m, key("enter"))
	m, quit := run(t, m, cmd)
	require.False(t, quit)
	require.Contains(t, m.View(), "agent target w1:p2 not found")
}

func TestNotPaired(t *testing.T) {
	m := New(false, "", &fakeJumper{}, nil)
	m, _ = step(m, tea.WindowSizeMsg{Width: 80, Height: 20})
	require.Contains(t, m.View(), "Run quorum pair <hub> <code>")
	_, cmd := step(m, key("q"))
	require.IsType(t, tea.QuitMsg{}, cmd())
}

func TestNarrowViewTruncatesOnRunes(t *testing.T) {
	m := New(true, "laptop", &fakeJumper{}, nil)
	m, _ = step(m, tea.WindowSizeMsg{Width: 40, Height: 20})
	m = feed(m,
		upsert(proto.SessionInfo{ID: "c", Machine: "vps-1", Name: "日本語のとても長いセッションの名前です", Root: "/srv/プロジェクト", State: proto.StateNeedsYou}),
		upsert(proto.SessionInfo{ID: "e", Machine: "laptop", Name: "🚀🔥 deploy rocket 👩‍💻 pipeline with a long name", State: proto.StateIdle, Unread: true}),
		upsert(proto.SessionInfo{ID: "w", Machine: "a-very-long-machine-name", Name: "plain", Root: "/x/a-really-long-project-name", State: proto.StateBackground}),
	)
	v := m.View()
	require.True(t, utf8.ValidString(v))
	for _, l := range strings.Split(v, "\n") {
		require.LessOrEqual(t, runewidth.StringWidth(l), 40, "line %q", l)
	}
	rows := 0
	for _, l := range strings.Split(v, "\n") {
		switch {
		case strings.Contains(l, "日本"):
			require.True(t, strings.HasSuffix(strings.TrimRight(l, " "), "Needs you"), l)
			rows++
		case strings.Contains(l, "🚀"):
			require.True(t, strings.HasSuffix(strings.TrimRight(l, " "), "Done · unread"), l)
			rows++
		case strings.Contains(l, "plain"):
			require.True(t, strings.HasSuffix(strings.TrimRight(l, " "), "Background"), l)
			rows++
		}
	}
	require.Equal(t, 3, rows)
	require.Contains(t, v, "…")
}

func TestRowShowsRecapLikeTheApp(t *testing.T) {
	m := feed(newModel(&fakeJumper{}),
		upsert(proto.SessionInfo{ID: "a", Machine: "vps-1", Name: "api", Recap: "fixing the login", State: proto.StateWorking}))
	require.Contains(t, m.View(), "fixing the login")
	require.NotContains(t, m.View(), "api ")
	// the filter still finds it by its name
	m, _ = step(m, key("/"))
	m, _ = step(m, key("api"))
	require.Equal(t, []string{"a"}, ids(m))
}

func TestNoticeForLoadErrors(t *testing.T) {
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	noDial := func(context.Context, client.Config) (*client.Live, error) {
		t.Fatal("dialled without a config")
		return nil, nil
	}
	for _, tc := range []struct {
		err  error
		want []string
	}{
		{client.ErrNotPaired, []string{"Not paired.", "Run quorum pair <hub> <code>"}},
		{fmt.Errorf("%w (unexpected end of JSON input)", client.ErrBadConfig), []string{"client.json is broken", "unexpected end of JSON input"}},
		{errors.New("open client.json: permission denied"), []string{"permission denied"}},
	} {
		m, closeLive, err := load(context.Background(), func() (client.Config, error) { return client.Config{}, tc.err }, noDial)
		require.NoError(t, err)
		closeLive()
		m, _ = step(m, tea.WindowSizeMsg{Width: 120, Height: 20})
		for _, w := range tc.want {
			require.Contains(t, m.View(), w)
		}
		if !errors.Is(tc.err, client.ErrNotPaired) {
			require.NotContains(t, m.View(), "Not paired.")
		}
		_, cmd := step(m, key("q"))
		require.IsType(t, tea.QuitMsg{}, cmd())
	}
}

func TestRevokedTokenShowsNotice(t *testing.T) {
	m := feed(newModel(&fakeJumper{}), sample()...)
	m, _ = step(m, liveClosedMsg{err: client.ErrUnauthorized})
	v := m.View()
	require.Contains(t, v, "This device was revoked.")
	require.Contains(t, v, "Run quorum pair <hub> <code>")
	require.NotContains(t, v, "web")
	// a plain close (the context ended) leaves the board as it was
	m2 := feed(newModel(&fakeJumper{}), sample()...)
	m2, _ = step(m2, liveClosedMsg{})
	require.Contains(t, m2.View(), "web")
}

func TestRevokedTokenFromTheHub(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer ts.Close()
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, closeLive, err := load(ctx, func() (client.Config, error) {
		return client.Config{Hub: ts.URL, Token: "revoked", Machine: "laptop"}, nil
	}, client.Dial)
	require.NoError(t, err)
	defer closeLive()
	m, _ = step(m, m.Init()())
	require.Contains(t, m.View(), "This device was revoked.")
}
