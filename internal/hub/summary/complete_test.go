package summary

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOpenAICompatibleClient(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		auth = r.Header.Get("Authorization")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"{\"title\":\"T\"}"}}]}`))
	}))
	defer srv.Close()
	o := &OpenAI{BaseURL: srv.URL + "/v1/", Model: "m-1", Key: "sk-secret"}
	out, err := o.Complete(context.Background(), "the prompt", 4000, true)
	require.NoError(t, err)
	require.Equal(t, `{"title":"T"}`, out)
	require.Equal(t, "Bearer sk-secret", auth)
	require.Equal(t, "m-1", got["model"])
	require.Equal(t, float64(4000), got["max_tokens"])
	require.Equal(t, map[string]any{"type": "json_object"}, got["response_format"])
	require.Equal(t, []any{map[string]any{"role": "user", "content": "the prompt"}}, got["messages"])
}

func TestOpenAICompatibleErrorsNeverCarryTheKey(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"message":"bad key sk-secret-123"}}`))
	}))
	defer srv.Close()
	o := &OpenAI{BaseURL: srv.URL, Model: "m", Key: "sk-secret-123"}
	_, err := o.Complete(context.Background(), "p", 100, true)
	require.Error(t, err)
	require.Contains(t, err.Error(), "HTTP 401")
	require.NotContains(t, err.Error(), "sk-secret-123")
	require.Equal(t, int32(1), calls.Load())
}

func TestOpenAICompatibleRetriesWithoutJSONModeOn400(t *testing.T) {
	var formats []bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		_, has := b["response_format"]
		formats = append(formats, has)
		if has {
			w.WriteHeader(400)
			w.Write([]byte(`{"error":{"message":"response_format not supported"}}`))
			return
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()
	out, err := (&OpenAI{BaseURL: srv.URL, Model: "m"}).Complete(context.Background(), "p", 0, true)
	require.NoError(t, err)
	require.Equal(t, "ok", out)
	require.Equal(t, []bool{true, false}, formats)
}

func TestOpenAICompatibleRefusesBadSettings(t *testing.T) {
	for _, base := range []string{"", "ftp://x", "http://user:pw@host", "file:///etc", "http://h/?q=1"} {
		_, err := (&OpenAI{BaseURL: base, Model: "m"}).Complete(context.Background(), "p", 1, false)
		require.Error(t, err, base)
	}
	_, err := (&OpenAI{BaseURL: "http://127.0.0.1:1", Model: ""}).Complete(context.Background(), "p", 1, false)
	require.ErrorContains(t, err, "no model")
}

func TestLongCCAPIUsesModelAndMaxTokens(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Write([]byte(`{}`))
			return
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.Write([]byte(`{"content":[{"type":"text","text":"{\"a\":"},{"type":"text","text":"1}"}]}`))
	}))
	defer srv.Close()
	tok := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(tok, []byte("k\n"), 0o600))
	a := NewAuto(srv.URL, tok)
	a.CLI = &fakeModel{err: context.Canceled}
	out, err := a.Long("").Complete(context.Background(), "p", 8000, true)
	require.NoError(t, err)
	require.Equal(t, `{"a":1}`, out)
	require.Equal(t, DefaultMeetingModel, got["model"])
	require.Equal(t, float64(8000), got["max_tokens"])
	_, err = a.Long("haiku").Complete(context.Background(), "p", 10, false)
	require.NoError(t, err)
	require.Equal(t, "haiku", got["model"])
}

func TestValidBaseURL(t *testing.T) {
	require.True(t, ValidBaseURL("https://api.example.com/v1"))
	require.True(t, ValidBaseURL("http://127.0.0.1:8000"))
	require.False(t, ValidBaseURL("api.example.com"))
}
