package hub

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/stretchr/testify/require"
)

func newTestServer(t *testing.T) (*Server, *store.Store, http.Handler) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	s := NewServer(st)
	return s, st, s.Handler()
}

func do(h http.Handler, method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func tokenFrom(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	require.Equal(t, 200, rr.Code, rr.Body.String())
	i := strings.Index(rr.Body.String(), `"token":"`)
	require.GreaterOrEqual(t, i, 0)
	rest := rr.Body.String()[i+9:]
	return rest[:strings.Index(rest, `"`)]
}

func TestPairFlow(t *testing.T) {
	_, st, h := newTestServer(t)
	code, err := st.CreateCode("pair")
	require.NoError(t, err)

	rr := do(h, "POST", "/api/pair", `{"code":"`+code+`","deviceName":"tel"}`, nil)
	tok := tokenFrom(t, rr)
	require.Len(t, tok, 43)

	rr = do(h, "GET", "/api/sessions", "", map[string]string{"Authorization": "Bearer " + tok})
	require.Equal(t, 200, rr.Code)

	rr = do(h, "POST", "/api/pair", `{"code":"`+code+`","deviceName":"tel"}`, nil)
	require.Equal(t, 400, rr.Code)
	require.JSONEq(t, `{"error":"código inválido o vencido"}`, rr.Body.String())
}

func TestSessionsRequiresToken(t *testing.T) {
	_, _, h := newTestServer(t)
	rr := do(h, "GET", "/api/sessions", "", nil)
	require.Equal(t, 401, rr.Code)
	require.JSONEq(t, `{"error":"no autorizado"}`, rr.Body.String())
	rr = do(h, "GET", "/api/sessions?token=x", "", nil)
	require.Equal(t, 401, rr.Code)
}

func TestQueryTokenOnlyForWebSocket(t *testing.T) {
	_, st, h := newTestServer(t)
	code, _ := st.CreateCode("pair")
	tok := tokenFrom(t, do(h, "POST", "/api/pair", `{"code":"`+code+`"}`, nil))
	require.Equal(t, 401, do(h, "GET", "/api/sessions?token="+tok, "", nil).Code)
	require.Equal(t, 200, do(h, "GET", "/api/sessions?token="+tok, "", map[string]string{"Upgrade": "websocket"}).Code)
}

func TestMachineTokenNotDevice(t *testing.T) {
	s, st, h := newTestServer(t)
	code, _ := st.CreateCode("link")
	tok := tokenFrom(t, do(h, "POST", "/api/link", `{"code":"`+code+`","machine":"wsl"}`, nil))
	require.Equal(t, 401, do(h, "GET", "/api/sessions", "", map[string]string{"Authorization": "Bearer " + tok}).Code)

	var got string
	mh := s.requireMachine(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = AuthName(r.Context()) }))
	rr := do(mh, "GET", "/", "", map[string]string{"Authorization": "Bearer " + tok})
	require.Equal(t, 200, rr.Code)
	require.Equal(t, "wsl", got)

	// y al revés: token de dispositivo no sirve como máquina
	pc, _ := st.CreateCode("pair")
	dt := tokenFrom(t, do(h, "POST", "/api/pair", `{"code":"`+pc+`"}`, nil))
	require.Equal(t, 401, do(mh, "GET", "/", "", map[string]string{"Authorization": "Bearer " + dt}).Code)
}

func TestLinkRequiresMachineName(t *testing.T) {
	_, st, h := newTestServer(t)
	code, _ := st.CreateCode("link")
	rr := do(h, "POST", "/api/link", `{"code":"`+code+`"}`, nil)
	require.Equal(t, 400, rr.Code)
	require.JSONEq(t, `{"error":"falta el nombre de la máquina"}`, rr.Body.String())
}

func TestPing(t *testing.T) {
	_, _, h := newTestServer(t)
	rr := do(h, "GET", "/api/ping", "", nil)
	require.Equal(t, 200, rr.Code)
	require.JSONEq(t, `{"ok":true,"version":"0.1.0"}`, rr.Body.String())
}

func TestPairSameNameKeepsBothTokens(t *testing.T) {
	_, st, h := newTestServer(t)
	var toks []string
	var names []string
	for i := 0; i < 2; i++ {
		code, _ := st.CreateCode("pair")
		rr := do(h, "POST", "/api/pair", `{"code":"`+code+`","deviceName":"tel"}`, nil)
		toks = append(toks, tokenFrom(t, rr))
		names = append(names, rr.Body.String())
	}
	require.Contains(t, names[0], `"name":"tel"`)
	require.Contains(t, names[1], `"name":"tel (2)"`)
	for _, tk := range toks {
		require.Equal(t, 200, do(h, "GET", "/api/sessions", "", map[string]string{"Authorization": "Bearer " + tk}).Code)
	}
}

func TestRelinkMachineReplacesToken(t *testing.T) {
	_, st, h := newTestServer(t)
	var toks []string
	for i := 0; i < 2; i++ {
		code, _ := st.CreateCode("link")
		toks = append(toks, tokenFrom(t, do(h, "POST", "/api/link", `{"code":"`+code+`","machine":"wsl"}`, nil)))
	}
	_, ok := st.CheckToken("machine", toks[0])
	require.False(t, ok)
	_, ok = st.CheckToken("machine", toks[1])
	require.True(t, ok)
}

func TestRevokeMissingIsNotFound(t *testing.T) {
	_, st, _ := newTestServer(t)
	require.ErrorIs(t, st.RevokeToken("device", "nadie"), store.ErrNotFound)
}
