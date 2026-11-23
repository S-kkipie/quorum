package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/S-kkipie/quorum/internal/hub"
	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/hub/summary"
)

const usage = `usage: quorum-hub <command>
  serve [--addr 127.0.0.1:7420] [--db PATH] [--ccapi-url URL] [--ccapi-token-file PATH]
  pair                      prints a code to pair a device
  link-code                 prints a code to link a machine
  devices                   lists the paired devices
  revoke <device|machine> <name>`

func defaultDB() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "hub.db"
	}
	return filepath.Join(home, ".local", "share", "quorum", "hub.db")
}

func openStore(path string) (*store.Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return store.Open(path)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Println(usage)
		return errors.New("missing command")
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:7420", "listen address")
	db := fs.String("db", defaultDB(), "path to the database")
	ccURL := fs.String("ccapi-url", summary.DefaultCCAPI, "ccapi URL (Haiku summaries)")
	ccTok := fs.String("ccapi-token-file", "", "file with the ccapi key (default ~/.config/ccapi/token); if missing, `claude -p` is used")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	st, err := openStore(*db)
	if err != nil {
		return err
	}
	defer st.Close()

	switch args[0] {
	case "serve":
		return serve(st, *addr, hub.Options{CCAPIURL: *ccURL, CCAPITokenFile: *ccTok})
	case "pair", "link-code":
		kind := "pair"
		if args[0] == "link-code" {
			kind = "link"
		}
		code, err := st.CreateCode(kind)
		if err != nil {
			return err
		}
		fmt.Println(code)
	case "devices":
		ds, err := st.ListDevices()
		if err != nil {
			return err
		}
		for _, d := range ds {
			fmt.Printf("%s\t%s\n", d.Name, time.UnixMilli(d.CreatedAt).Format(time.RFC3339))
		}
	case "revoke":
		if fs.NArg() != 2 || (fs.Arg(0) != "device" && fs.Arg(0) != "machine") {
			return errors.New("usage: quorum-hub revoke <device|machine> <name>")
		}
		if err := st.RevokeToken(fs.Arg(0), fs.Arg(1)); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("no such %s %q", fs.Arg(0), fs.Arg(1))
			}
			return err
		}
	default:
		fmt.Println(usage)
		return fmt.Errorf("unknown command: %s", args[0])
	}
	return nil
}

func serve(st *store.Store, addr string, opts hub.Options) error {
	hs := hub.NewServer(st, opts)
	srv := &http.Server{Addr: addr, Handler: hs.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	hs.StartSync(ctx)
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	fmt.Println("quorum-hub listening on", addr)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(sctx)
}
