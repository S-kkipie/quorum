package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func TestPair(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/pair", r.URL.Path)
		var b struct{ Code, DeviceName string }
		require.NoError(t, json.NewDecoder(r.Body).Decode(&b))
		require.Equal(t, "123456", b.Code)
		require.Equal(t, "quorum-laptop", b.DeviceName)
		_, _ = w.Write([]byte(`{"token":"secret-token","name":"quorum-laptop"}`))
	}))
	defer ts.Close()
	tok, err := Pair(context.Background(), ts.URL+"/", "123456", "quorum-laptop")
	require.NoError(t, err)
	require.Equal(t, "secret-token", tok)
}

func TestPairRejected(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"invalid or expired code"}`))
	}))
	defer ts.Close()
	_, err := Pair(context.Background(), ts.URL, "x", "d")
	require.ErrorContains(t, err, "invalid or expired code")
}

func TestSessionsSendsBearer(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`[{"id":"s1","machine":"vps-1","name":"api"}]`))
	}))
	defer ts.Close()
	ss, err := Sessions(context.Background(), Config{Hub: ts.URL, Token: "tok"})
	require.NoError(t, err)
	require.Len(t, ss, 1)
	require.Equal(t, "s1", ss[0].ID)
}

func TestBackoffSchedule(t *testing.T) {
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30, 30}
	for i, w := range want {
		require.Equal(t, w*time.Second, Backoff(i), "attempt %d", i)
	}
	require.Equal(t, 30*time.Second, Backoff(1000))
}

func TestLiveDeliversAndReconnects(t *testing.T) {
	conns := make(chan struct{}, 4)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "tok" {
			w.WriteHeader(401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		require.NoError(t, err)
		conns <- struct{}{}
		_ = wsjson.Write(r.Context(), c, proto.Envelope{Type: "session_upsert", Session: "s1", Payload: json.RawMessage(`{}`)})
		c.Close(websocket.StatusNormalClosure, "bye") // forces a reconnect
	}))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l := dial(ctx, Config{Hub: ts.URL, Token: "tok"}, func(int) time.Duration { return 10 * time.Millisecond })
	defer l.Close()
	// each connection starts with the EnvConnected marker, then the hub's envelopes
	want := []string{EnvConnected, "session_upsert", EnvConnected, "session_upsert"}
	for i, w := range want {
		select {
		case e := <-l.Envelopes():
			require.Equal(t, w, e.Type, "envelope %d", i)
		case <-time.After(3 * time.Second):
			t.Fatalf("no envelope %d", i)
		}
	}
	require.Len(t, conns, 2)
}

func TestDoUnauthorized(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer ts.Close()
	_, err := Sessions(context.Background(), Config{Hub: ts.URL, Token: "tok"})
	require.ErrorIs(t, err, ErrUnauthorized)
}
