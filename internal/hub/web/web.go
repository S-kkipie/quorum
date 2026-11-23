// Package web serves the embedded app: dist/ if it was built (make app) or, if not,
// a placeholder page.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

//go:embed all:placeholder
var placeholderFS embed.FS

// Handler serves the app, falling back to index.html for unknown routes.
func Handler() http.Handler {
	return handler(distFS, "dist", placeholderFS, "placeholder")
}

func handler(dist fs.FS, distDir string, ph fs.FS, phDir string) http.Handler {
	root, err := fs.Sub(dist, distDir)
	if err != nil {
		panic(err)
	}
	if _, err := fs.Stat(root, "index.html"); err != nil {
		if root, err = fs.Sub(ph, phDir); err != nil {
			panic(err)
		}
	}
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if strings.HasPrefix(p, "api/") || p == "api" {
			http.NotFound(w, r)
			return
		}
		if p != "" {
			if st, err := fs.Stat(root, p); err == nil && !st.IsDir() {
				if p == "index.html" || p == "sw.js" {
					w.Header().Set("Cache-Control", "no-cache")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// Routes with an extension are files: 404 if missing. The rest is the SPA.
		if path.Ext(p) != "" {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(root, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	})
}
