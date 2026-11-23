package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// pingInterval es el periodo de las líneas {"type":"ping"}; variable para tests.
var pingInterval = 20 * time.Second

// attachHandler hace streaming NDJSON de los comandos de una sesión al mod.
func attachHandler(reg *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		// El stream es largo: anula cualquier WriteTimeout del servidor.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
		ch, cancel := reg.Subscribe(r.PathValue("id"))
		defer cancel()
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		fl.Flush()
		tick := time.NewTicker(pingInterval)
		defer tick.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case c, ok := <-ch:
				if !ok {
					return
				}
				b, err := json.Marshal(c)
				if err != nil {
					continue
				}
				if _, err := w.Write(append(b, '\n')); err != nil {
					return
				}
				fl.Flush()
			case <-tick.C:
				if _, err := io.WriteString(w, "{\"type\":\"ping\"}\n"); err != nil {
					return
				}
				fl.Flush()
			}
		}
	}
}

// RunAttach conecta al endpoint attach y copia cada línea a out. Devuelve el
// código de salida: 0 si el servidor cierra el stream limpiamente, 2 si no puede
// conectar o recibe un estado distinto de 200, 3 si el stream se corta con error
// (el mod reconecta en todos los casos).
func RunAttach(ctx context.Context, base, token, session string, out, errw io.Writer) int {
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/sessions/"+url.PathEscape(session)+"/attach", nil)
	if err != nil {
		fmt.Fprintln(errw, err)
		return 2
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		fmt.Fprintln(errw, err)
		return 2
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(errw, "attach: status", resp.StatusCode)
		return 2
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		if _, err := out.Write(append(sc.Bytes(), '\n')); err != nil {
			fmt.Fprintln(errw, err)
			return 2
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		fmt.Fprintln(errw, err)
		return 3
	}
	return 0
}
