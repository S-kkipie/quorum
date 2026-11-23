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

// pingInterval is the period of the {"type":"ping"} lines; a variable for tests.
var pingInterval = 20 * time.Second

// attachHandler streams a session's commands to the mod as NDJSON.
func attachHandler(reg *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		// The stream is long-lived: override any server WriteTimeout.
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

// RunAttach connects to the attach endpoint and copies each line to out. It returns the
// exit code: 0 if the server closes the stream cleanly, 2 if it cannot
// connect or gets a status other than 200, 3 if the stream breaks with an error
// (the mod reconnects in every case).
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
