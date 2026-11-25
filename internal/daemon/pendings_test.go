package daemon

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func pendingsAPI(t *testing.T, hub string) *httptest.Server {
	t.Helper()
	cfg := Config{Hub: hub, MachineToken: "mtok"}
	api := httptest.NewServer(NewLocalAPIFull(NewRegistry("m"), "tok", "v", nil, func() Config { return cfg }))
	t.Cleanup(api.Close)
	return api
}

func pdo(t *testing.T, method, url, tok, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestPendingsForwardAddsMachineToken(t *testing.T) {
	var gotAuth, gotURI, gotBody string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotAuth, gotURI, gotBody = r.Header.Get("Authorization"), r.URL.RequestURI(), string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":1}`))
	}))
	defer hub.Close()
	api := pendingsAPI(t, hub.URL)
	if c, b := pdo(t, "GET", api.URL+"/v1/sessions/s1/pendings?status=all", "tok", ""); c != 200 || b != `{"ok":1}` {
		t.Fatal(c, b)
	}
	if gotAuth != "Bearer mtok" || gotURI != "/api/machine/sessions/s1/pendings?status=all" {
		t.Fatal(gotAuth, gotURI)
	}
	pdo(t, "POST", api.URL+"/v1/sessions/s1/pendings", "tok", `{"text":"x"}`)
	if gotURI != "/api/machine/sessions/s1/pendings" || gotBody != `{"text":"x"}` {
		t.Fatal(gotURI, gotBody)
	}
	pdo(t, "POST", api.URL+"/v1/sessions/s1/pendings/p%2F1/done", "tok", `{}`)
	if gotURI != "/api/machine/sessions/s1/pendings/p%2F1/done" {
		t.Fatal(gotURI)
	}
}

func TestPendingsForwardPassesHubErrors(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		w.Write([]byte(`{"error":"already done"}`))
	}))
	defer hub.Close()
	api := pendingsAPI(t, hub.URL)
	if c, b := pdo(t, "POST", api.URL+"/v1/sessions/s1/pendings/p1/done", "tok", `{}`); c != 409 || b != `{"error":"already done"}` {
		t.Fatal(c, b)
	}
}

func TestPendingsForwardHubDown(t *testing.T) {
	hub := httptest.NewServer(http.NotFoundHandler())
	url := hub.URL
	hub.Close()
	want := `{"error":"Quorum hub unreachable; the item was not saved"}`
	for _, u := range []string{url, ""} {
		api := pendingsAPI(t, u)
		if c, b := pdo(t, "GET", api.URL+"/v1/sessions/s1/pendings", "tok", ""); c != 502 || b != want {
			t.Fatal(c, b)
		}
	}
}

func TestPendingsForwardNeedsLocalToken(t *testing.T) {
	api := pendingsAPI(t, "http://127.0.0.1:1")
	if c, _ := pdo(t, "GET", api.URL+"/v1/sessions/s1/pendings", "", ""); c != 401 {
		t.Fatal(c)
	}
	if c, _ := pdo(t, "POST", api.URL+"/v1/sessions/s1/pendings", "bad", "{}"); c != 401 {
		t.Fatal(c)
	}
}
