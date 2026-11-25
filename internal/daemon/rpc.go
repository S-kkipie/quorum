package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/proto"
)

// geteuid is replaced in tests.
var geteuid = os.Geteuid

// Host groups what the daemon needs to talk to herdr.
type Host struct {
	Herdr      *herdr.Client
	WS         *launch.Workspaces
	Terms      *Terminals
	TerminalOn bool
	// HubURL is the hub's base URL (meeting jobs carry URLs relative to it).
	HubURL string
	// OllamaURL is the machine's own Ollama address for local summaries ("" = the loopback default; only
	// this local setting may point elsewhere, never the hub's job settings).
	OllamaURL string

	// active terminal watchers per pane (see terminal.go)
	wmu     sync.Mutex
	watches map[string]*termWatch

	// pending tab closes per session (see sessionclose.go)
	cmu     sync.Mutex
	closing map[string]*pendingClose
}

// NewHost builds the Host from the config (herdr socket and saved workspaces).
func NewHost(cfg Config) *Host {
	h := &Host{
		Herdr:      &herdr.Client{Socket: herdr.SocketPath(cfg.HerdrSocket)},
		WS:         &launch.Workspaces{},
		Terms:      &Terminals{},
		TerminalOn: cfg.TerminalOn(),
		HubURL:     cfg.Hub,
		OllamaURL:  cfg.OllamaURL,
	}
	dir, err := ConfigDir()
	if err != nil {
		// without a config folder nothing is remembered (never writes into the cwd)
		log.Printf("quorumd: no config folder, herdr workspaces and terminals are not remembered: %v", err)
		return h
	}
	h.WS.Path = filepath.Join(dir, "herdr-workspaces.json")
	h.Terms.Path = filepath.Join(dir, "herdr-terminals.json")
	return h
}

func (h *Host) herdrUp(ctx context.Context) bool {
	return h != nil && h.Herdr != nil && h.Herdr.Available(ctx)
}

// Caps computes the machine's current capabilities.
func (h *Host) Caps(ctx context.Context) proto.MachineCaps {
	up := h.herdrUp(ctx)
	mw := meetingWorkerState()
	return proto.MachineCaps{Herdr: up, Terminal: up && h.TerminalOn, Root: geteuid() == 0, Transcribe: mw == "ready", MeetingWorker: mw}
}

// launch opens the session in herdr if it answers; the fallback (launch.Run) is only used
// if herdr did not answer before touching anything: any other failure is final.
func (h *Host) launch(ctx context.Context, req proto.LaunchRequest) proto.LaunchResult {
	if h.herdrUp(ctx) {
		res, err := launchHerdr(ctx, h.Herdr, h.WS, req)
		if err == nil || !errors.Is(err, launch.ErrHerdrUnavailable) {
			return res
		}
	}
	return launchRun(ctx, req)
}

// rpcHandlers is filled in other files (conversations, terminal).
var rpcHandlers = map[string]func(ctx context.Context, h *Host, params json.RawMessage) (any, error){}

// rpcTimeout bounds each rpc call; somewhat less than the hub's wait (10 s) so that
// the daemon's error reaches it before it gives up. A variable for tests.
var rpcTimeout = 9 * time.Second

// errRPCSlow is the error the hub sees when a handler exceeds rpcTimeout.
const errRPCSlow = "the operation took too long on the machine"

var errUnknownMethod = errors.New("unknown method")

// rpcLinkKey stores in each call's ctx the link that received it: the link's ctx
// (lives as long as the connection, not the call) and the registry.
type rpcLinkKey struct{}

type rpcLink struct {
	ctx context.Context
	reg *Registry
}

// linkOf returns the call's link; with no link, the ctx itself and a nil registry.
func linkOf(ctx context.Context) rpcLink {
	if l, ok := ctx.Value(rpcLinkKey{}).(rpcLink); ok {
		return l
	}
	return rpcLink{ctx: ctx}
}

// invokeRPC runs the method's handler with an rpcTimeout deadline.
func invokeRPC(ctx context.Context, host *Host, reg *Registry, rq proto.RPC) (any, error) {
	fn, ok := rpcHandlers[rq.Method]
	if !ok {
		return nil, errUnknownMethod
	}
	cctx, cancel := context.WithTimeout(context.WithValue(ctx, rpcLinkKey{}, rpcLink{ctx: ctx, reg: reg}), rpcTimeout)
	defer cancel()
	return fn(cctx, host, rq.Params)
}

// handleRPC dispatches by method and answers rpc_result with the same reqId.
// ctx is the link's: whatever a handler starts (watchers) ends with it.
func handleRPC(ctx context.Context, host *Host, reg *Registry, rq proto.RPC) {
	out := proto.RPCResult{ReqID: rq.ReqID}
	if res, err := invokeRPC(ctx, host, reg, rq); errors.Is(err, context.DeadlineExceeded) {
		out.Error = errRPCSlow
	} else if err != nil {
		out.Error = err.Error()
	} else if b, err := json.Marshal(res); err != nil {
		out.Error = err.Error()
	} else {
		out.Result = b
	}
	p, _ := json.Marshal(out)
	reg.EmitEnvelope(proto.Envelope{Type: "rpc_result", Machine: reg.machine, Payload: p})
}
