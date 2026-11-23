// Package herdrtest es un herdr falso para tests: escucha en un socket unix
// temporal y responde con los handlers registrados.
package herdrtest

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Call es una petición recibida por el falso.
type Call struct {
	Method string
	Params json.RawMessage
}

// Fake es un servidor herdr de mentira.
type Fake struct {
	Socket string

	ln       net.Listener
	mu       sync.Mutex
	handlers map[string]func(json.RawMessage) (any, string)
	calls    []Call
}

// New arranca el falso y lo cierra al terminar el test.
func New(t *testing.T) *Fake {
	t.Helper()
	dir, err := os.MkdirTemp("", "hdr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	f := &Fake{Socket: sock, ln: ln, handlers: map[string]func(json.RawMessage) (any, string){}}
	t.Cleanup(func() { ln.Close() })
	go f.accept()
	return f
}

// Handle registra el handler de un método. Si devuelve errCode != "", responde
// un error con ese código; si no, responde result.
func (f *Fake) Handle(method string, fn func(params json.RawMessage) (result any, errCode string)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handlers[method] = fn
}

// Calls devuelve una copia de las peticiones recibidas, en orden.
func (f *Fake) Calls() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.calls...)
}

func (f *Fake) accept() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.serve(c)
	}
}

func (f *Fake) serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReaderSize(c, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var req struct {
			ID     string          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(line, &req) != nil {
			return
		}
		f.mu.Lock()
		f.calls = append(f.calls, Call{Method: req.Method, Params: req.Params})
		fn := f.handlers[req.Method]
		f.mu.Unlock()

		resp := map[string]any{"id": req.ID}
		if fn == nil {
			resp["error"] = map[string]string{"code": "unknown_method", "message": "método sin handler: " + req.Method}
		} else if res, code := fn(req.Params); code != "" {
			resp["error"] = map[string]string{"code": code, "message": code}
		} else {
			resp["result"] = res
		}
		b, _ := json.Marshal(resp)
		if _, err := c.Write(append(b, '\n')); err != nil {
			return
		}
	}
}

// Close detiene el falso y borra su socket (simula que herdr se cerró).
func (f *Fake) Close() {
	f.ln.Close()
	os.Remove(f.Socket)
}
