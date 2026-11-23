package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(h http.Handler, p string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", p, nil))
	return w
}

var ph = fstest.MapFS{"placeholder/index.html": {Data: []byte("<html>PLACEHOLDER</html>")}}

func TestPlaceholderWhenNoDist(t *testing.T) {
	dist := fstest.MapFS{"dist/.keep": {}}
	h := handler(dist, "dist", ph, "placeholder")
	for _, p := range []string{"/", "/s/abc"} {
		w := get(h, p)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "PLACEHOLDER") {
			t.Fatalf("%s: %d %q", p, w.Code, w.Body.String())
		}
	}
}

func TestDistSPAFallbackAndTypes(t *testing.T) {
	dist := fstest.MapFS{
		"dist/index.html":   {Data: []byte("<html>APP</html>")},
		"dist/assets/a.js":  {Data: []byte("console.log(1)")},
		"dist/assets/a.css": {Data: []byte("a{}")},
	}
	h := handler(dist, "dist", ph, "placeholder")
	w := get(h, "/algo/raro")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "APP") || w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("fallback: %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	if w = get(h, "/assets/a.js"); !strings.Contains(w.Header().Get("Content-Type"), "javascript") || w.Body.String() != "console.log(1)" {
		t.Fatalf("js: %v", w.Header())
	}
	if w = get(h, "/assets/a.css"); !strings.Contains(w.Header().Get("Content-Type"), "text/css") {
		t.Fatalf("css: %v", w.Header())
	}
	if w = get(h, "/index.html"); w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index cache: %v", w.Header())
	}
	if w = get(h, "/assets/falta.js"); w.Code != 404 {
		t.Fatalf("asset faltante: %d", w.Code)
	}
	if w = get(h, "/api/nope"); w.Code != 404 {
		t.Fatalf("api no debe caer en SPA: %d", w.Code)
	}
}
