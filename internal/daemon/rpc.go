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

// geteuid se sustituye en los tests.
var geteuid = os.Geteuid

// Host agrupa lo que el daemon necesita para hablar con herdr.
type Host struct {
	Herdr      *herdr.Client
	WS         *launch.Workspaces
	Terms      *Terminals
	TerminalOn bool

	// vigilantes de terminal activos por panel (ver terminal.go)
	wmu     sync.Mutex
	watches map[string]*termWatch

	// cierres de pestaña pendientes por sesión (ver sessionclose.go)
	cmu     sync.Mutex
	closing map[string]*pendingClose
}

// NewHost arma el Host desde la config (socket de herdr y workspaces guardados).
func NewHost(cfg Config) *Host {
	h := &Host{
		Herdr:      &herdr.Client{Socket: herdr.SocketPath(cfg.HerdrSocket)},
		WS:         &launch.Workspaces{},
		Terms:      &Terminals{},
		TerminalOn: cfg.TerminalOn(),
	}
	dir, err := ConfigDir()
	if err != nil {
		// sin carpeta de config no se recuerda nada (nunca se escribe en el cwd)
		log.Printf("quorumd: sin carpeta de config, no se recuerdan workspaces ni terminales de herdr: %v", err)
		return h
	}
	h.WS.Path = filepath.Join(dir, "herdr-workspaces.json")
	h.Terms.Path = filepath.Join(dir, "herdr-terminals.json")
	return h
}

func (h *Host) herdrUp(ctx context.Context) bool {
	return h != nil && h.Herdr != nil && h.Herdr.Available(ctx)
}

// Caps calcula las capacidades actuales de la máquina.
func (h *Host) Caps(ctx context.Context) proto.MachineCaps {
	up := h.herdrUp(ctx)
	return proto.MachineCaps{Herdr: up, Terminal: up && h.TerminalOn, Root: geteuid() == 0}
}

// launch abre la sesión en herdr si responde; el respaldo (launch.Run) solo se usa
// si herdr no respondió antes de tocar nada: cualquier otro fallo es definitivo.
func (h *Host) launch(ctx context.Context, req proto.LaunchRequest) proto.LaunchResult {
	if h.herdrUp(ctx) {
		res, err := launchHerdr(ctx, h.Herdr, h.WS, req)
		if err == nil || !errors.Is(err, launch.ErrHerdrUnavailable) {
			return res
		}
	}
	return launchRun(ctx, req)
}

// rpcHandlers se llena en otros ficheros (conversaciones, terminal).
var rpcHandlers = map[string]func(ctx context.Context, h *Host, params json.RawMessage) (any, error){}

// rpcTimeout acota cada llamada rpc; algo menos que la espera del hub (10 s) para
// que el error del daemon le llegue antes de que se rinda. Variable para tests.
var rpcTimeout = 9 * time.Second

// errRPCSlow es el error que ve el hub cuando un handler se pasa de rpcTimeout.
const errRPCSlow = "la operación tardó demasiado en la máquina"

var errUnknownMethod = errors.New("método desconocido")

// rpcLinkKey guarda en el ctx de cada llamada el enlace que la recibió: el ctx
// del enlace (vive lo que la conexión, no lo que la llamada) y el registro.
type rpcLinkKey struct{}

type rpcLink struct {
	ctx context.Context
	reg *Registry
}

// linkOf devuelve el enlace de la llamada; sin enlace, el propio ctx y un registro nil.
func linkOf(ctx context.Context) rpcLink {
	if l, ok := ctx.Value(rpcLinkKey{}).(rpcLink); ok {
		return l
	}
	return rpcLink{ctx: ctx}
}

// invokeRPC ejecuta el handler del método con un plazo de rpcTimeout.
func invokeRPC(ctx context.Context, host *Host, reg *Registry, rq proto.RPC) (any, error) {
	fn, ok := rpcHandlers[rq.Method]
	if !ok {
		return nil, errUnknownMethod
	}
	cctx, cancel := context.WithTimeout(context.WithValue(ctx, rpcLinkKey{}, rpcLink{ctx: ctx, reg: reg}), rpcTimeout)
	defer cancel()
	return fn(cctx, host, rq.Params)
}

// handleRPC despacha por método y responde rpc_result con el mismo reqId.
// ctx es el del enlace: lo que arranque un handler (vigilantes) termina con él.
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
