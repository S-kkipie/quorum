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

// rpcTimeout: how long the hub waits for a machine's response (a variable for tests).
var rpcTimeout = 10 * time.Second

var (
	errOffline = errors.New("machine is offline")
	errTimeout = errors.New("machine did not respond")
)

// daemonError is an error returned by the daemon in RPCResult.Error.
type daemonError string

func (e daemonError) Error() string { return string(e) }

type rpcWaiter struct {
	machine string
	conn    *machineConn
	ch      chan proto.RPCResult // buffered 1: whoever resolves never blocks
}

type rpcState struct {
	rpcMu   sync.Mutex
	waiters map[string]*rpcWaiter
}

// resolveRPC delivers res to the waiter, only if that same machine called it.
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

// failWaiters wakes the waiters of a dropped connection with errOffline.
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

// call sends an rpc to the machine and waits for its rpc_result (up to rpcTimeout).
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
	// the write never follows the caller's cancellation: the websocket closes the whole machine
	// link when a write is interrupted, and a device that goes away mid-request must not do that
	// (the write keeps its own size-scaled timeout)
	if err := c.write(context.WithoutCancel(ctx), proto.Envelope{Type: "rpc", Machine: machine, Payload: p}); err != nil {
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
