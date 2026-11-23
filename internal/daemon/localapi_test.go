package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func newTestAPI(t *testing.T) (*Registry, *httptest.Server) {
	reg := NewRegistry("m1")
	srv := httptest.NewServer(NewLocalAPI(reg, "tok", "9.9.9"))
	t.Cleanup(srv.Close)
	return reg, srv
}

func post(t *testing.T, url, token string, body any) *http.Response {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func next(t *testing.T, reg *Registry) proto.Envelope {
	select {
	case e := <-reg.Out():
		return e
	case <-time.After(time.Second):
		t.Fatal("no envelope")
		return proto.Envelope{}
	}
}

func TestRegisterAndEventsInOrder(t *testing.T) {
	reg, srv := newTestAPI(t)
	r := post(t, srv.URL+"/v1/sessions/register", "tok", proto.SessionInfo{ID: "s1", Name: "x"})
	require.Equal(t, 204, r.StatusCode)
	evs := []proto.Event{{Kind: proto.KindUser, Data: json.RawMessage(`{"a":1}`)}, {Kind: proto.KindInfo, TS: 5}}
	r = post(t, srv.URL+"/v1/sessions/s1/events", "tok", evs)
	require.Equal(t, 204, r.StatusCode)

	e := next(t, reg)
	require.Equal(t, "session_upsert", e.Type)
	require.Equal(t, "m1", e.Machine)
	require.Equal(t, "s1", e.Session)
	var si proto.SessionInfo
	require.NoError(t, json.Unmarshal(e.Payload, &si))
	require.Equal(t, "m1", si.Machine)

	e = next(t, reg)
	require.Equal(t, "event", e.Type)
	var ev proto.Event
	require.NoError(t, json.Unmarshal(e.Payload, &ev))
	require.Equal(t, "s1", ev.Session)
	require.NotZero(t, ev.TS)
	require.Equal(t, proto.KindUser, ev.Kind)
	e = next(t, reg)
	require.NoError(t, json.Unmarshal(e.Payload, &ev))
	require.Equal(t, proto.KindInfo, ev.Kind)
	require.EqualValues(t, 5, ev.TS)

	require.Len(t, reg.Snapshot(), 1)
}

func TestBadTokenIs401(t *testing.T) {
	_, srv := newTestAPI(t)
	require.Equal(t, 401, post(t, srv.URL+"/v1/sessions/register", "bad", proto.SessionInfo{ID: "s"}).StatusCode)
	require.Equal(t, 401, post(t, srv.URL+"/v1/sessions/register", "", proto.SessionInfo{ID: "s"}).StatusCode)
	resp, err := http.Get(srv.URL + "/v1/health")
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
}

func TestGoneEmitsAndRemoves(t *testing.T) {
	reg, srv := newTestAPI(t)
	post(t, srv.URL+"/v1/sessions/register", "tok", proto.SessionInfo{ID: "s1"})
	next(t, reg)
	require.Equal(t, 204, post(t, srv.URL+"/v1/sessions/s1/gone", "tok", nil).StatusCode)
	e := next(t, reg)
	require.Equal(t, "session_gone", e.Type)
	require.Equal(t, "s1", e.Session)
	require.Empty(t, reg.Snapshot())
}

func TestSubscribeSend(t *testing.T) {
	reg := NewRegistry("m")
	require.False(t, reg.Send("nope", proto.Command{Type: "abort"}))
	ch, cancel := reg.Subscribe("s1")
	require.True(t, reg.Send("s1", proto.Command{Type: "abort"}))
	require.Equal(t, "abort", (<-ch).Type)
	ch2, cancel2 := reg.Subscribe("s1")
	_, ok := <-ch
	require.False(t, ok, "previous subscriber closed")
	cancel() // stale cancel must not kill the new subscriber
	require.True(t, reg.Send("s1", proto.Command{Type: "close"}))
	require.Equal(t, "close", (<-ch2).Type)
	cancel2()
	require.False(t, reg.Send("s1", proto.Command{}))
}

func TestConfigRoundTripAndToken(t *testing.T) {
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	c, err := LoadConfig()
	require.NoError(t, err)
	require.NotEmpty(t, c.Machine)
	require.Len(t, c.LocalToken, 43)
	c2, err := LoadConfig()
	require.NoError(t, err)
	require.Equal(t, c.LocalToken, c2.LocalToken)
	c2.Port = 1234
	require.NoError(t, SaveConfig(c2))
	c3, _ := LoadConfig()
	require.Equal(t, 1234, c3.Port)
}

func TestOversizedBodyIs413(t *testing.T) {
	_, srv := newTestAPI(t)
	big := bytes.Repeat([]byte("a"), 5<<20)
	req, _ := http.NewRequest("POST", srv.URL+"/v1/sessions/s1/events", bytes.NewReader(append(append([]byte(`[{"kind":"info","data":"`), big...), []byte(`"}]`)...)))
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 413, resp.StatusCode)
}

func TestBatchBoundedWhenOutFull(t *testing.T) {
	reg, srv := newTestAPI(t)
	for i := 0; i < outBuffer; i++ {
		reg.Emit("s", proto.Event{Kind: proto.KindInfo})
	}
	evs := make([]proto.Event, 50)
	for i := range evs {
		evs[i] = proto.Event{Kind: proto.KindInfo}
	}
	start := time.Now()
	require.Equal(t, 204, post(t, srv.URL+"/v1/sessions/s/events", "tok", evs).StatusCode)
	require.Less(t, time.Since(start), 1800*time.Millisecond)
}

func TestEnsureConcurrentSpawnsOnce(t *testing.T) {
	t.Setenv("QUORUM_CONFIG_DIR", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	var spawns atomic.Int32
	done := make(chan struct{})
	spawn := func() error {
		spawns.Add(1)
		cfg, err := loadConfigLocked()
		if err != nil {
			return err
		}
		go func() { Serve(ctx, cfg); close(done) }()
		return nil
	}
	var wg sync.WaitGroup
	res := make([]EnsureResult, 5)
	for i := range res {
		wg.Add(1)
		go func() { defer wg.Done(); res[i] = ensureWith(spawn) }()
	}
	wg.Wait()
	cancel()
	<-done
	require.EqualValues(t, 1, spawns.Load())
	for _, r := range res {
		require.True(t, r.OK, r.Error)
		require.Equal(t, res[0].Port, r.Port)
		require.Equal(t, res[0].Token, r.Token)
		require.Equal(t, proto.Version, r.Version)
	}
}

// ensure reports the version of the daemon that answers, not of the binary running ensure.
func TestHealthReportsDaemonVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"version":"0.0.9","machine":"m"}`))
	}))
	defer srv.Close()
	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	v, ok := health(Config{Port: port, Machine: "m"})
	require.True(t, ok)
	require.Equal(t, "0.0.9", v)
}
