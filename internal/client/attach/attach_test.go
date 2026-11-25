package attach

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/client"
	"github.com/S-kkipie/quorum/internal/proto"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

// syncBuf is a goroutine-safe output sink for the program.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type input struct {
	Text string   `json:"text"`
	Keys []string `json:"keys"`
}

// fakeHub is an httptest relay: sessions, machines, watch, input and /api/live.
type fakeHub struct {
	mu       sync.Mutex
	online   bool
	watchErr string // a 409 error for watch
	watches  int
	inputs   []input
	paths    []string
	liveDone chan struct{} // closed when the client hangs up the live socket
	frames   chan proto.Envelope
}

func newFakeHub(t *testing.T) (*fakeHub, *httptest.Server) {
	f := &fakeHub{online: true, liveDone: make(chan struct{}), frames: make(chan proto.Envelope, 8)}
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer tok" && r.URL.Query().Get("token") != "tok" {
				w.WriteHeader(401)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /api/sessions", auth(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"id":"sess-1234","machine":"vps-1","name":"api","state":"working","herdrPane":"w1:p2"},
			{"id":"sess-9","machine":"vps-1","name":"nopane","state":"idle"}]`))
	}))
	mux.HandleFunc("GET /api/machines", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		on := f.online
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode([]map[string]any{{"name": "vps-1", "online": on}, {"name": "laptop", "online": true}})
	}))
	mux.HandleFunc("POST /api/machines/{m}/terminals/{pane}/watch", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.paths = append(f.paths, r.PathValue("m")+"|"+r.PathValue("pane"))
		if f.watchErr != "" {
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":"` + f.watchErr + `"}`))
			return
		}
		f.watches++
		w.WriteHeader(204)
	}))
	mux.HandleFunc("POST /api/machines/{m}/terminals/{pane}/input", auth(func(w http.ResponseWriter, r *http.Request) {
		var in input
		require.NoError(t, json.NewDecoder(r.Body).Decode(&in))
		f.mu.Lock()
		f.inputs = append(f.inputs, in)
		f.mu.Unlock()
		w.WriteHeader(204)
	}))
	mux.HandleFunc("GET /api/live", auth(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer close(f.liveDone)
		ctx := c.CloseRead(context.Background())
		for {
			select {
			case env := <-f.frames:
				if wsjson.Write(ctx, c, env) != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return f, ts
}

func (f *fakeHub) watchCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.watches
}

func (f *fakeHub) typed() (string, [][]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var text strings.Builder
	var keys [][]string
	for _, in := range f.inputs {
		text.WriteString(in.Text)
		if len(in.Keys) > 0 {
			keys = append(keys, in.Keys)
		}
	}
	return text.String(), keys
}

func frame(machine, pane, ansi string, closed bool) proto.Envelope {
	p, _ := json.Marshal(proto.TermFrame{Pane: pane, Cols: 80, Rows: 3, ANSI: ansi, Closed: closed})
	return proto.Envelope{Type: "term_frame", Machine: machine, Payload: p}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func start(t *testing.T, ts *httptest.Server, arg string) (*io.PipeWriter, *syncBuf, chan error) {
	t.Helper()
	pr, pw := io.Pipe()
	out := &syncBuf{}
	done := make(chan error, 1)
	cfg := client.Config{Hub: ts.URL, Token: "tok"}
	go func() {
		done <- Run(context.Background(), cfg, arg, tea.WithInput(pr), tea.WithOutput(out), tea.WithoutSignalHandler())
	}()
	t.Cleanup(func() { pw.Close() })
	return pw, out, done
}

func TestAttachDrawsForwardsAndDetaches(t *testing.T) {
	old := renewEvery
	renewEvery = 20 * time.Millisecond
	t.Cleanup(func() { renewEvery = old })
	f, ts := newFakeHub(t)
	// another pane's frame and another machine's frame are ignored
	f.frames <- frame("vps-1", "w9:p9", "not this one", false)
	f.frames <- frame("laptop", "w1:p2", "nor this one", false)
	f.frames <- frame("vps-1", "w1:p2", "\x1b[1mhello\x1b[0m from the pane\r\nsecond line", false)

	pw, out, done := start(t, ts, "sess-12") // a unique id prefix is enough
	eventually(t, "the frame on screen", func() bool { return strings.Contains(out.String(), "from the pane") })
	require.NotContains(t, out.String(), "not this one")
	require.NotContains(t, out.String(), "nor this one")
	require.Contains(t, out.String(), "second line")
	eventually(t, "watch renewals", func() bool { return f.watchCount() >= 3 })
	f.mu.Lock()
	require.Equal(t, "vps-1|w1:p2", f.paths[0])
	f.mu.Unlock()

	_, err := pw.Write([]byte("ls"))
	require.NoError(t, err)
	_, err = pw.Write([]byte("\r"))
	require.NoError(t, err)
	_, err = pw.Write([]byte{0x1b, '[', 'A'}) // up arrow
	require.NoError(t, err)
	eventually(t, "input forwarded", func() bool {
		text, keys := f.typed()
		return text == "ls" && len(keys) == 2
	})
	_, keys := f.typed()
	require.Equal(t, [][]string{{"enter"}, {"up"}}, keys)

	_, err = pw.Write([]byte{0x1d}) // Ctrl-]
	require.NoError(t, err)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("Ctrl-] did not detach")
	}
	select {
	case <-f.liveDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the live socket stayed open")
	}
	n := f.watchCount()
	time.Sleep(100 * time.Millisecond)
	require.Equal(t, n, f.watchCount(), "the watch is still being renewed after detaching")
}

func TestAttachOfflineMachine(t *testing.T) {
	f, ts := newFakeHub(t)
	f.online = false
	_, _, done := start(t, ts, "sess-1234")
	err := <-done
	var off *OfflineError
	require.True(t, errors.As(err, &off))
	require.Equal(t, "vps-1 is offline", err.Error())
	require.Zero(t, f.watchCount())
}

func TestAttachWatchSaysOffline(t *testing.T) {
	f, ts := newFakeHub(t)
	f.watchErr = "machine is offline"
	_, _, done := start(t, ts, "sess-1234")
	require.EqualError(t, <-done, "vps-1 is offline")
}

func TestAttachGoesOfflineMidSession(t *testing.T) {
	f, ts := newFakeHub(t)
	f.frames <- frame("vps-1", "w1:p2", "hello", false)
	_, out, done := start(t, ts, "sess-1234")
	eventually(t, "the frame", func() bool { return strings.Contains(out.String(), "hello") })
	p, _ := json.Marshal(map[string]any{"name": "vps-1", "online": false})
	f.frames <- proto.Envelope{Type: "machine_status", Machine: "vps-1", Payload: p}
	require.EqualError(t, <-done, "vps-1 is offline")
}

func TestAttachPaneClosed(t *testing.T) {
	f, ts := newFakeHub(t)
	f.frames <- frame("vps-1", "w1:p2", "", true)
	_, _, done := start(t, ts, "sess-1234")
	require.EqualError(t, <-done, "the terminal of api on vps-1 closed")
}

func TestAttachResolveErrors(t *testing.T) {
	_, ts := newFakeHub(t)
	_, _, done := start(t, ts, "sess")
	require.EqualError(t, <-done, `"sess" matches more than one session`)
	_, _, done = start(t, ts, "nope")
	require.EqualError(t, <-done, `no live session "nope"`)
	_, _, done = start(t, ts, "sess-9")
	require.EqualError(t, <-done, "Not in a herdr pane on vps-1")
}

func TestKeyMapping(t *testing.T) {
	cases := []struct {
		msg  tea.KeyMsg
		text string
		keys []string
	}{
		{tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("é")}, "é", nil},
		{tea.KeyMsg{Type: tea.KeySpace, Runes: []rune(" ")}, " ", nil},
		{tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("pasted"), Paste: true}, "pasted", nil},
		{tea.KeyMsg{Type: tea.KeyEnter}, "", []string{"enter"}},
		{tea.KeyMsg{Type: tea.KeyEsc}, "", []string{"esc"}},
		{tea.KeyMsg{Type: tea.KeyTab}, "", []string{"tab"}},
		{tea.KeyMsg{Type: tea.KeyCtrlC}, "", []string{"ctrl+c"}},
		{tea.KeyMsg{Type: tea.KeyCtrlD}, "", []string{"ctrl+d"}},
		{tea.KeyMsg{Type: tea.KeyCtrlL}, "", []string{"ctrl+l"}},
		{tea.KeyMsg{Type: tea.KeyDown}, "", []string{"down"}},
		{tea.KeyMsg{Type: tea.KeyLeft}, "", []string{"left"}},
		{tea.KeyMsg{Type: tea.KeyRight}, "", []string{"right"}},
		{tea.KeyMsg{Type: tea.KeyBackspace}, "\x7f", nil},
	}
	for _, c := range cases {
		text, keys, ok := mapKey(c.msg)
		require.True(t, ok, c.msg.String())
		require.Equal(t, c.text, text, c.msg.String())
		require.Equal(t, c.keys, keys, c.msg.String())
	}
	_, _, ok := mapKey(tea.KeyMsg{Type: tea.KeyF5})
	require.False(t, ok)
}

func TestTitleUsesRecap(t *testing.T) {
	require.Equal(t, "fixing the login", title(proto.SessionInfo{Name: "api", Recap: "fixing the login"}))
	require.Equal(t, "api", title(proto.SessionInfo{Name: "api"}))
	require.Equal(t, "Session", title(proto.SessionInfo{}))
}
