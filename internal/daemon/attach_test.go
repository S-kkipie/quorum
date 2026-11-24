package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// openAttach opens the stream with a 5 s deadline: no test read can hang.
func openAttach(t *testing.T, ctx context.Context, url, token string) (*http.Response, *bufio.Reader) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", url+"/v1/sessions/s1/attach", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { resp.Body.Close() })
	return resp, bufio.NewReader(resp.Body)
}

// readToEOF reads until EOF; fails (instead of hanging) if the stream does not end within 3 s.
func readToEOF(t *testing.T, r io.Reader) {
	t.Helper()
	done := make(chan error, 1)
	go func() { _, err := io.ReadAll(r); done <- err }()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("the stream did not finish")
	}
}

func TestAttachStreamsCommandsAndReleasesOnCancel(t *testing.T) {
	reg, srv := newTestAPI(t)
	ctx, cancel := context.WithCancel(context.Background())
	resp, rd := openAttach(t, ctx, srv.URL, "tok")
	require.Equal(t, 200, resp.StatusCode)
	require.True(t, reg.Send("s1", proto.Command{Type: "prompt", Text: "a"}))
	require.True(t, reg.Send("s1", proto.Command{Type: "abort"}))
	var c proto.Command
	l, err := rd.ReadString('\n')
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal([]byte(l), &c))
	require.Equal(t, "a", c.Text)
	l, _ = rd.ReadString('\n')
	require.NoError(t, json.Unmarshal([]byte(l), &c))
	require.Equal(t, "abort", c.Type)
	cancel()
	require.Eventually(t, func() bool { return !reg.Send("s1", proto.Command{Type: "abort"}) }, 2*time.Second, 10*time.Millisecond)
}

func TestAttachAuth(t *testing.T) {
	_, srv := newTestAPI(t)
	resp, _ := openAttach(t, context.Background(), srv.URL, "bad")
	require.Equal(t, 401, resp.StatusCode)
}

func TestAttachSecondReplacesFirst(t *testing.T) {
	reg, srv := newTestAPI(t)
	_, rd1 := openAttach(t, context.Background(), srv.URL, "tok")
	_, rd2 := openAttach(t, context.Background(), srv.URL, "tok")
	readToEOF(t, rd1)
	require.True(t, reg.Send("s1", proto.Command{Type: "close"}))
	l, err := rd2.ReadString('\n')
	require.NoError(t, err)
	require.Contains(t, l, `"close"`)
}

func TestAttachGoneEndsStream(t *testing.T) {
	reg, srv := newTestAPI(t)
	_, rd := openAttach(t, context.Background(), srv.URL, "tok")
	reg.Gone("s1")
	readToEOF(t, rd)
}

func TestAttachPing(t *testing.T) {
	old := pingInterval
	pingInterval = 30 * time.Millisecond
	t.Cleanup(func() { pingInterval = old })
	_, srv := newTestAPI(t)
	_, rd := openAttach(t, context.Background(), srv.URL, "tok")
	l, err := rd.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, `{"type":"ping"}`, strings.TrimSpace(l))
}

func TestRunAttachCopiesLinesAndExitCodes(t *testing.T) {
	reg, srv := newTestAPI(t)
	go func() {
		time.Sleep(100 * time.Millisecond)
		reg.Send("s1", proto.Command{Type: "prompt", Text: "hi"})
		time.Sleep(50 * time.Millisecond)
		reg.Gone("s1")
	}()
	var out, errb bytes.Buffer
	code := RunAttach(context.Background(), srv.URL, "tok", "s1", &out, &errb)
	require.Equal(t, 0, code)
	require.Contains(t, out.String(), `"hi"`)

	require.Equal(t, 2, RunAttach(context.Background(), srv.URL, "wrong", "s1", &out, &errb))
	srv.Close()
	require.Equal(t, 2, RunAttach(context.Background(), srv.URL, "tok", "s1", &out, &errb))
}

// Minor: a stream cut with an error exits with 3 (distinct from a clean close, 0).
func TestRunAttachStreamErrorExitCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("{\"type\":\"ping\"}\n"))
		w.Write(bytes.Repeat([]byte("x"), 9<<20)) // line > 8 MiB with no newline
	}))
	defer srv.Close()
	var out, errb bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	require.Equal(t, 3, RunAttach(ctx, srv.URL, "tok", "s1", &out, &errb))
	require.Contains(t, out.String(), "ping")
	require.NotEmpty(t, errb.String())
}

// The daemon relays every command type unfiltered; plugin commands reach the mod intact.
func TestAttachForwardsPluginCommand(t *testing.T) {
	reg, srv := newTestAPI(t)
	_, rd := openAttach(t, context.Background(), srv.URL, "tok")
	require.True(t, reg.Send("s1", proto.Command{Type: "plugin", Command: "timeline", Args: "undo"}))
	l, err := rd.ReadString('\n')
	require.NoError(t, err)
	var c proto.Command
	require.NoError(t, json.Unmarshal([]byte(l), &c))
	require.Equal(t, proto.Command{Type: "plugin", Command: "timeline", Args: "undo"}, c)
}
