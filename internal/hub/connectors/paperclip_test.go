package connectors

import (
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

func pcConn(t *testing.T, base, project string, timeout time.Duration) *paperclipConnector {
	p, err := newPaperclip(proto.ConnectorConfig{Kind: "paperclip", Settings: map[string]string{"baseURL": base + "/", "companyId": "c1", "projectId": project}}, "sekret", timeout)
	require.NoError(t, err)
	return p
}

func TestPaperclipListMaps(t *testing.T) {
	var auth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = append(auth, r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/api/companies/c1/issues":
			require.Empty(t, r.URL.RawQuery)
			io.WriteString(w, `[{"id":"i1","identifier":"ACME-1","title":"Uno","description":"d","descriptionTruncated":true,"status":"in_progress","assigneeAgentId":"abcdef123456","projectId":"p1","updatedAt":"2026-01-02T03:04:05Z"},
			 {"id":"i3","title":"other","status":"todo","projectId":"zzz"},
			 {"id":"i4","title":"no project","status":"todo"},
			 {"id":"i5","title":"hidden","status":"todo","projectId":"p1","hiddenAt":"2026-01-01T00:00:00Z"},
			 {"id":"i2","title":"Dos","status":"cancelled","projectId":"p1","assigneeUserId":"user12345678","url":"http://x/y"}]`)
		case "/api/issues/i1/comments":
			io.WriteString(w, `[{"body":"b","createdAt":"2026-01-01T00:00:00Z","authorType":"agent","authorAgentId":"ag1"},
			 {"body":"deleted","createdAt":"2026-01-01T00:00:00Z","deletedAt":"2026-01-02T00:00:00Z"},
			 {"body":"sys","createdAt":"2026-01-03T00:00:00Z","authorType":"system"}]`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	ts, err := pcConn(t, srv.URL, "p1", time.Second).List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, ts, 2)
	require.Equal(t, "i1", ts[0].ExternalID)
	require.Equal(t, "[ACME-1] Uno", ts[0].Title)
	require.Equal(t, "d\n\n(description truncated in Paperclip)", ts[0].Body)
	require.Equal(t, "agent abcdef12", ts[0].Assignee)
	require.Equal(t, srv.URL+"/issues/i1", ts[0].URL)
	require.Equal(t, "in_progress", StatusMap(ts[0].RawStatus, nil))
	require.Equal(t, int64(1767323045000), ts[0].UpdatedAt)
	require.Len(t, ts[0].Comments, 2)
	require.Equal(t, "ag1", ts[0].Comments[0].Author)
	require.Equal(t, "system", ts[0].Comments[1].Author)
	require.Equal(t, "user user1234", ts[1].Assignee)
	require.Equal(t, "http://x/y", ts[1].URL)
	require.Equal(t, "done", StatusMap(ts[1].RawStatus, nil))
	require.Nil(t, ts[1].Comments)
	for _, a := range auth {
		require.Equal(t, "Bearer sekret", a)
	}
}

func TestPaperclipStatusMapping(t *testing.T) {
	for raw, want := range map[string]string{"todo": "todo", "backlog": "todo", "in_progress": "in_progress", "in_review": "in_review", "blocked": "blocked", "done": "done", "cancelled": "done"} {
		require.Equal(t, want, StatusMap(raw, nil), raw)
	}
}

func TestPaperclipWrites(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = append(got, r.Method+" "+r.URL.Path+" "+string(b))
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()
	p := pcConn(t, srv.URL, "", time.Second)
	require.NoError(t, p.Comment(context.Background(), "i1", "hola"))
	require.NoError(t, p.SetStatus(context.Background(), "i1", "in_review"))
	require.Error(t, p.SetStatus(context.Background(), "i1", "xx"))
	require.Len(t, got, 2)
	require.Regexp(t, `^POST /api/issues/i1/comments \{"body":"hola","clientRequestId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$`, got[0])
	require.Equal(t, `PATCH /api/issues/i1 {"status":"in_review"}`, got[1])
}

func TestPaperclipErrors(t *testing.T) {
	code := 401
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(code)
		io.WriteString(w, "boom sekret "+strings.Repeat("x", 500))
	}))
	defer srv.Close()
	p := pcConn(t, srv.URL, "", time.Second)
	_, err := p.List(context.Background(), 0)
	require.EqualError(t, err, "Paperclip: invalid token")
	code = 404
	_, err = p.List(context.Background(), 0)
	require.EqualError(t, err, "Paperclip: not found (/api/companies/c1/issues)")
	code = 500
	_, err = p.List(context.Background(), 0)
	require.ErrorContains(t, err, "Paperclip: HTTP 500: boom ***")
	require.Less(t, len(err.Error()), 330)
}

func TestPaperclipTimeoutAndSettings(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(300 * time.Millisecond) }))
	defer srv.Close()
	_, err := pcConn(t, srv.URL, "", 50*time.Millisecond).List(context.Background(), 0)
	require.ErrorContains(t, err, "Paperclip:")
	for _, s := range []map[string]string{{"baseURL": "http://x"}, {"companyId": "c"}, {"baseURL": "ftp://x", "companyId": "c"}} {
		_, err := newPaperclip(proto.ConnectorConfig{Settings: s}, "", time.Second)
		require.Error(t, err)
	}
	_, err = newPaperclip(proto.ConnectorConfig{Settings: map[string]string{"baseURL": "http://x"}}, "", time.Second)
	require.EqualError(t, err, "Paperclip: missing baseURL/companyId")
	c, err := New(proto.ConnectorConfig{Kind: "paperclip", Settings: map[string]string{"baseURL": "http://x", "companyId": "c"}}, "t", nil)
	require.NoError(t, err)
	require.NotNil(t, c)
}

func TestPaperclipNoCrossHostRedirectWithToken(t *testing.T) {
	var leaked string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = r.Header.Get("Authorization") }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/x", http.StatusFound)
	}))
	defer srv.Close()
	_, err := pcConn(t, srv.URL, "", time.Second).List(context.Background(), 0)
	require.Error(t, err)
	require.Empty(t, leaked)
	_ = json.Valid
}
