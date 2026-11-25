package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/daemon/herdr"
	"github.com/S-kkipie/quorum/internal/daemon/herdr/herdrtest"
	"github.com/S-kkipie/quorum/internal/daemon/launch"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

// Tests must never touch the PC's real herdr.
func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "qd")
	os.Setenv("HERDR_SOCKET_PATH", filepath.Join(dir, "no-herdr.sock"))
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func hostFor(t *testing.T, sock string) *Host {
	return &Host{Herdr: &herdr.Client{Socket: sock}, WS: &launch.Workspaces{Path: filepath.Join(t.TempDir(), "ws.json")}, TerminalOn: true}
}

func noHerdrHost(t *testing.T) *Host { return hostFor(t, filepath.Join(t.TempDir(), "none.sock")) }

func fakeUp(t *testing.T) *herdrtest.Fake {
	f := herdrtest.New(t)
	f.Handle("workspace.list", func(json.RawMessage) (any, string) { return map[string]any{"workspaces": []any{}}, "" })
	return f
}

// startLink starts a fake hub and the link; returns the hub and the registry.
func startLink(t *testing.T, host *Host) (*fakeHub, *Registry) {
	fastBackoff(t)
	fh := &fakeHub{}
	srv := httptest.NewServer(http.HandlerFunc(fh.handler))
	t.Cleanup(srv.Close)
	reg := NewRegistry("m1")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go RunHubLink(ctx, Config{Machine: "m1", Hub: srv.URL, MachineToken: "tok"}, reg, host)
	require.Eventually(t, func() bool { return fh.count() == 1 }, 3*time.Second, 10*time.Millisecond)
	return fh, reg
}

func (f *fakeHub) send(t *testing.T, e proto.Envelope) {
	f.mu.Lock()
	c := f.conns[len(f.conns)-1]
	f.mu.Unlock()
	require.NoError(t, wsjson.Write(context.Background(), c, e))
}

func (f *fakeHub) waitEnv(t *testing.T, typ string) proto.Envelope {
	var got proto.Envelope
	require.Eventually(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, e := range f.envs {
			if e.Type == typ {
				got = e
				return true
			}
		}
		return false
	}, 3*time.Second, 10*time.Millisecond, typ)
	return got
}

func TestHelloCarriesCaps(t *testing.T) {
	fh, _ := startLink(t, hostFor(t, fakeUp(t).Socket))
	fh.mu.Lock()
	defer fh.mu.Unlock()
	require.True(t, fh.hellos[0].Caps.Herdr)
	require.True(t, fh.hellos[0].Caps.Terminal)
}

func TestTerminalOffInConfig(t *testing.T) {
	off := false
	h := hostFor(t, fakeUp(t).Socket)
	h.TerminalOn = Config{Terminal: &off}.TerminalOn()
	c := h.Caps(context.Background())
	require.True(t, c.Herdr)
	require.False(t, c.Terminal)
	require.True(t, Config{}.TerminalOn())
}

func TestCapsRoot(t *testing.T) {
	old := geteuid
	geteuid = func() int { return 0 }
	defer func() { geteuid = old }()
	require.True(t, noHerdrHost(t).Caps(context.Background()).Root)
}

func TestCapsReemittedOnChange(t *testing.T) {
	old := capsEvery.Load()
	capsEvery.Store(int64(50 * time.Millisecond))
	defer capsEvery.Store(old)
	f := fakeUp(t)
	fh, _ := startLink(t, hostFor(t, f.Socket))
	f.Close()
	env := fh.waitEnv(t, "caps")
	var c proto.MachineCaps
	require.NoError(t, json.Unmarshal(env.Payload, &c))
	require.False(t, c.Herdr)
	require.False(t, c.Terminal)
}

func stubLaunch(t *testing.T) (viaRun *int, viaHerdr *int) {
	viaRun, viaHerdr = new(int), new(int)
	oR, oH := launchRun, launchHerdr
	t.Cleanup(func() { launchRun, launchHerdr = oR, oH })
	launchRun = func(_ context.Context, r proto.LaunchRequest) proto.LaunchResult {
		*viaRun++
		return proto.LaunchResult{ReqID: r.ReqID, OK: true, Via: "tmux"}
	}
	launchHerdr = func(_ context.Context, _ *herdr.Client, _ *launch.Workspaces, r proto.LaunchRequest) (proto.LaunchResult, error) {
		*viaHerdr++
		return proto.LaunchResult{ReqID: r.ReqID, OK: true, Via: "herdr", Pane: "p1"}, nil
	}
	return
}

func launchVia(t *testing.T, fh *fakeHub) proto.LaunchResult {
	lp, _ := json.Marshal(proto.LaunchRequest{ReqID: "r1", Dir: "/work"})
	fh.send(t, proto.Envelope{Type: "launch", Payload: lp})
	var res proto.LaunchResult
	require.NoError(t, json.Unmarshal(fh.waitEnv(t, "launch_result").Payload, &res))
	return res
}

func TestLaunchPrefersHerdr(t *testing.T) {
	viaRun, viaHerdr := stubLaunch(t)
	fh, _ := startLink(t, hostFor(t, fakeUp(t).Socket))
	res := launchVia(t, fh)
	require.Equal(t, "herdr", res.Via)
	require.Equal(t, 0, *viaRun)
	require.Equal(t, 1, *viaHerdr)
}

func TestLaunchFallsBackWithoutHerdr(t *testing.T) {
	viaRun, viaHerdr := stubLaunch(t)
	fh, _ := startLink(t, noHerdrHost(t))
	res := launchVia(t, fh)
	require.Equal(t, "tmux", res.Via)
	require.Equal(t, 1, *viaRun)
	require.Equal(t, 0, *viaHerdr)
}

func TestLaunchFallsBackOnlyWhenHerdrUnavailable(t *testing.T) {
	viaRun, _ := stubLaunch(t)
	h := hostFor(t, fakeUp(t).Socket)
	launchHerdr = func(_ context.Context, _ *herdr.Client, _ *launch.Workspaces, r proto.LaunchRequest) (proto.LaunchResult, error) {
		return proto.LaunchResult{ReqID: r.ReqID, Error: "failed", Via: "herdr"}, &herdr.Error{Code: "boom"}
	}
	res := h.launch(context.Background(), proto.LaunchRequest{ReqID: "r1"})
	require.Equal(t, "failed", res.Error)
	require.Equal(t, 0, *viaRun) // herdr failure: final, no second launch

	launchHerdr = func(_ context.Context, _ *herdr.Client, _ *launch.Workspaces, r proto.LaunchRequest) (proto.LaunchResult, error) {
		return proto.LaunchResult{ReqID: r.ReqID}, launch.ErrHerdrUnavailable
	}
	res = h.launch(context.Background(), proto.LaunchRequest{ReqID: "r1"})
	require.Equal(t, "tmux", res.Via)
	require.Equal(t, 1, *viaRun)
}

func TestRPCUnknownMethod(t *testing.T) {
	fh, _ := startLink(t, noHerdrHost(t))
	rp, _ := json.Marshal(proto.RPC{ReqID: "q1", Method: "nothing"})
	fh.send(t, proto.Envelope{Type: "rpc", Payload: rp})
	var res proto.RPCResult
	require.NoError(t, json.Unmarshal(fh.waitEnv(t, "rpc_result").Payload, &res))
	require.Equal(t, "q1", res.ReqID)
	require.Equal(t, "unknown method", res.Error)
}

func TestRPCDispatchesHandler(t *testing.T) {
	rpcHandlers["eco"] = func(_ context.Context, _ *Host, p json.RawMessage) (any, error) {
		return map[string]json.RawMessage{"p": p}, nil
	}
	defer delete(rpcHandlers, "eco")
	fh, _ := startLink(t, noHerdrHost(t))
	rp, _ := json.Marshal(proto.RPC{ReqID: "q2", Method: "eco", Params: json.RawMessage(`1`)})
	fh.send(t, proto.Envelope{Type: "rpc", Payload: rp})
	var res proto.RPCResult
	require.NoError(t, json.Unmarshal(fh.waitEnv(t, "rpc_result").Payload, &res))
	require.Equal(t, "q2", res.ReqID)
	require.JSONEq(t, `{"p":1}`, string(res.Result))
}
