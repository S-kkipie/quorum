package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// rpcTimeout: cuánto espera el hub la respuesta de una máquina (variable para los tests).
var rpcTimeout = 10 * time.Second

var (
	errOffline = errors.New("la máquina está fuera de línea")
	errTimeout = errors.New("la máquina no respondió")
)

// daemonError es un error devuelto por el daemon en RPCResult.Error.
type daemonError string

func (e daemonError) Error() string { return string(e) }

type rpcWaiter struct {
	machine string
	conn    *machineConn
	ch      chan proto.RPCResult // con búfer 1: quien resuelve nunca se bloquea
}

type rpcState struct {
	rpcMu   sync.Mutex
	waiters map[string]*rpcWaiter
}

// resolveRPC entrega res al waiter, solo si lo llamó esa misma máquina.
func (h *Hub) resolveRPC(machine string, res proto.RPCResult) {
	h.rpcMu.Lock()
	w := h.waiters[res.ReqID]
	if w != nil && w.machine == machine {
		delete(h.waiters, res.ReqID)
	} else {
		w = nil
	}
	h.rpcMu.Unlock()
	if w != nil {
		w.ch <- res
	}
}

// failWaiters despierta con errOffline a los waiters de una conexión que se cayó.
func (h *Hub) failWaiters(c *machineConn) {
	h.rpcMu.Lock()
	defer h.rpcMu.Unlock()
	for id, w := range h.waiters {
		if w.conn == c {
			delete(h.waiters, id)
			w.ch <- proto.RPCResult{ReqID: id, Error: errOffline.Error()}
		}
	}
}

// call manda un rpc a la máquina y espera su rpc_result (hasta rpcTimeout).
func (h *Hub) call(ctx context.Context, machine, method string, params any, out any) error {
	h.mu.Lock()
	c := h.conns[machine]
	h.mu.Unlock()
	if c == nil {
		return errOffline
	}
	pj, err := json.Marshal(params)
	if err != nil {
		return err
	}
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return err
	}
	id := hex.EncodeToString(b[:])
	w := &rpcWaiter{machine: machine, conn: c, ch: make(chan proto.RPCResult, 1)}
	h.rpcMu.Lock()
	if h.waiters == nil {
		h.waiters = map[string]*rpcWaiter{}
	}
	h.waiters[id] = w
	h.rpcMu.Unlock()
	defer func() {
		h.rpcMu.Lock()
		delete(h.waiters, id)
		h.rpcMu.Unlock()
	}()
	p, _ := json.Marshal(proto.RPC{ReqID: id, Method: method, Params: pj})
	if err := c.write(ctx, proto.Envelope{Type: "rpc", Machine: machine, Payload: p}); err != nil {
		return errOffline
	}
	t := time.NewTimer(rpcTimeout)
	defer t.Stop()
	select {
	case res := <-w.ch:
		if res.Error == errOffline.Error() && res.Result == nil {
			return errOffline
		}
		if res.Error != "" {
			return daemonError(res.Error)
		}
		if out != nil && len(res.Result) > 0 {
			return json.Unmarshal(res.Result, out)
		}
		return nil
	case <-t.C:
		return errTimeout
	case <-ctx.Done():
		return ctx.Err()
	}
}
