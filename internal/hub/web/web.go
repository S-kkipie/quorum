// Package web sirve la app embebida: dist/ si se compiló (make app) o, si no,
// una página marcador.
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

// Handler sirve la app con fallback a index.html para rutas desconocidas.
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
			http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
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
		// Rutas con extensión son archivos: si faltan, 404. El resto es SPA.
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
