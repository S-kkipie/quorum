package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// The hub's upload route against the real daemon handlers, both in process: the bytes land in
// the uploads folder, the hub records them for the session and serves them through an upload link.
func TestUploadEndToEnd(t *testing.T) {
	root := uploadFx(t)
	fastBackoff(t)
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	srv := hub.NewServer(st)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	require.NoError(t, st.AddToken("machine", "m1", "mtok"))
	require.NoError(t, st.AddToken("device", "phone", "dtok"))

	reg := NewRegistry("m1")
	reg.Upsert(proto.SessionInfo{ID: "s1", Cwd: "/work/p", State: proto.StateIdle})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go RunHubLink(ctx, Config{Machine: "m1", Hub: ts.URL, MachineToken: "mtok"}, reg, noHerdrHost(t))
	require.Eventually(t, func() bool {
		si, err := st.Session("s1")
		return err == nil && si.State != proto.StateClosed && srv.Hub().Connected("m1")
	}, 5*time.Second, 20*time.Millisecond)

	data := make([]byte, 2*uploadChunkMax+333)
	_, _ = rand.Read(data)
	req, _ := http.NewRequest("POST", ts.URL+"/api/sessions/s1/files?name=Caf%C3%A9%20menu.pdf", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer dtok")
	req.Header.Set("Content-Type", "application/pdf")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	var out struct {
		Path, Name, Mime string
		Size             int64
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.True(t, strings.HasPrefix(out.Path, root+string(filepath.Separator)), out.Path)
	require.Regexp(t, `^[0-9a-f]{6}-Cafe_menu\.pdf$`, out.Name)
	require.EqualValues(t, len(data), out.Size)
	got, err := os.ReadFile(out.Path)
	require.NoError(t, err)
	require.True(t, bytes.Equal(data, got))
	entries, _ := os.ReadDir(filepath.Dir(out.Path))
	require.Len(t, entries, 1, "no partial file left")

	// the recorded upload opens through a view link; another path does not
	view := func(p string) (int, string) {
		b, _ := json.Marshal(map[string]any{"sessionId": "s1", "path": p, "upload": true})
		req, _ := http.NewRequest("POST", ts.URL+"/api/machines/m1/views", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer dtok")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var v struct{ URL string }
		_ = json.NewDecoder(resp.Body).Decode(&v)
		return resp.StatusCode, v.URL
	}
	code, u := view(out.Path)
	require.Equal(t, 200, code)
	resp, err = http.Get(ts.URL + u)
	require.NoError(t, err)
	served, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "application/pdf", resp.Header.Get("Content-Type"))
	require.True(t, bytes.Equal(data, served))
	code, _ = view(filepath.Join(filepath.Dir(out.Path), "abcdef-other.pdf"))
	require.Equal(t, 403, code)
}
