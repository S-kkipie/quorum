package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNormalizeHub(t *testing.T) {
	for in, want := range map[string]string{
		"http://vps-1:7420":          "http://vps-1:7420",
		" https://vps-1/some/path/ ": "https://vps-1",
		"http://vps-1:7420/#/x":      "http://vps-1:7420",
	} {
		got, err := normalizeHub(in)
		require.NoError(t, err, in)
		require.Equal(t, want, got)
	}
	for _, bad := range []string{"", "vps-1:7420", "ftp://vps-1", "http://", "javascript:alert(1)"} {
		_, err := normalizeHub(bad)
		require.Error(t, err, bad)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "Quorum", "desktop.json")
	require.Equal(t, "", loadSettings(p).Hub) // missing file: first run
	require.NoError(t, saveSettings(p, settings{Hub: "http://vps-1:7420"}))
	require.Equal(t, "http://vps-1:7420", loadSettings(p).Hub)
	require.NoError(t, saveSettings(p, settings{Hub: "not a url"}))
	require.Equal(t, "", loadSettings(p).Hub) // a bad stored value means first run, never a broken navigation
}

func TestReachable(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/ping", r.URL.Path)
	}))
	defer ok.Close()
	require.True(t, reachable(ok.URL, time.Second))

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(502) }))
	defer down.Close()
	require.False(t, reachable(down.URL, time.Second))
	require.False(t, reachable("http://127.0.0.1:1", 200*time.Millisecond))
}

func TestPagesEscapeTheHub(t *testing.T) {
	out := page(offlinePage, `http://vps-1"><script>x</script>`)
	require.NotContains(t, out, "<script>x")
	require.True(t, strings.Contains(out, "Can't reach the hub. Is Tailscale connected?"))
}

func TestPagesCarryTheMarkAndTerminalGreen(t *testing.T) {
	for name, tpl := range map[string]string{"first run": firstRunPage, "offline": offlinePage} {
		out := page(tpl, "http://vps-1:7420")
		require.Equal(t, 7, strings.Count(out, "<circle"), name)
		require.Contains(t, out, `class="mark"`, name)
		require.Contains(t, out, "#0C7548", name)
		require.Contains(t, out, "#3DDC97", name)
		require.NotContains(t, out, "#FAF9F6", name)
	}
}

func TestWindowsIconResourceIsCommitted(t *testing.T) {
	// Run `go generate ./cmd/quorum-desktop` with GOOS=windows to refresh it after the icon changes.
	for _, f := range []string{"rsrc_windows_amd64.syso", "quorum.ico"} {
		st, err := os.Stat(f)
		require.NoError(t, err, f)
		require.Greater(t, st.Size(), int64(1000), f)
	}
}

func TestColorref(t *testing.T) {
	c, ok := colorref("#0E1311")
	require.True(t, ok)
	require.Equal(t, uint32(0x0011130E), c) // 0x00BBGGRR
	c, ok = colorref(" #3ddc97 ")
	require.True(t, ok)
	require.Equal(t, uint32(0x0097DC3D), c)
	for _, bad := range []string{"", "#123", "red", "#GGGGGG", "#0E13111"} {
		_, ok := colorref(bad)
		require.False(t, ok, bad)
	}
}
