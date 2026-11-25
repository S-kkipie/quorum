// Command quorum is the device client: `quorum pair`, `quorum watch`, `quorum board` and `quorum attach`.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/S-kkipie/quorum/internal/client"
	"github.com/S-kkipie/quorum/internal/client/attach"
	"github.com/S-kkipie/quorum/internal/client/board"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "pair":
		err = pair(os.Args[2:])
	case "watch":
		err = watch()
	case "board":
		err = runBoard()
	case "attach":
		if len(os.Args) != 3 {
			usage()
		}
		err = runAttach(os.Args[2])
	default:
		usage()
	}
	var off *attach.OfflineError
	switch {
	case errors.As(err, &off):
		fmt.Fprintln(os.Stderr, off.Error())
		os.Exit(1)
	case err != nil:
		fmt.Fprintln(os.Stderr, "quorum:", err)
		os.Exit(exitCode(err))
	}
}

// exitCode is 2 for what a restart cannot fix (not paired, a broken client.json, a revoked
// token), so the systemd unit's RestartPreventExitStatus=2 stops retrying; else 1.
func exitCode(err error) int {
	if errors.Is(err, client.ErrNotPaired) || errors.Is(err, client.ErrBadConfig) || errors.Is(err, client.ErrUnauthorized) {
		return 2
	}
	return 1
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: quorum pair <hubURL> <code> [--name <device>] [--machine <name>]\n       quorum watch\n       quorum board\n       quorum attach <session>")
	os.Exit(2)
}

func pair(args []string) error {
	// flags may come after the positional arguments
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	host, _ := os.Hostname()
	name := fs.String("name", "quorum-"+host, "device name")
	machine := fs.String("machine", "", "machine name (default: quorumd's, else the hostname)")
	var pos []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return err
		}
		args = fs.Args()
		if len(args) > 0 {
			pos = append(pos, args[0])
			args = args[1:]
		}
	}
	if len(pos) != 2 {
		usage()
	}
	m := *machine
	if m == "" {
		m = client.DaemonMachine()
	}
	if m == "" {
		m = host
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tok, err := client.Pair(ctx, pos[0], pos[1], *name)
	if err != nil {
		return err
	}
	if err := client.Save(client.Config{Hub: pos[0], Token: tok, Device: *name, Machine: m}); err != nil {
		return err
	}
	fmt.Printf("Paired as %s\n", *name)
	return nil
}

func watch() error {
	cfg, err := client.Load()
	if err != nil {
		return err
	}
	lp, err := client.LockPath()
	if err != nil {
		return err
	}
	unlock, ok, err := client.AcquireLock(lp)
	if err != nil {
		return err
	}
	if !ok {
		log.Print("quorum watch is already running; exiting")
		return nil
	}
	defer unlock()
	sp, err := client.SeenPath()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	w := &client.Watcher{Notifier: client.NewNotifier(), Seen: client.LoadSeen(sp)}
	log.Printf("watching %s as %s", cfg.Hub, cfg.Device)
	return w.Run(ctx, cfg)
}

// tuiContext ends on SIGTERM/SIGHUP (the herdr pane closing); log lines would draw over the screen.
func tuiContext() (context.Context, context.CancelFunc) {
	log.SetOutput(io.Discard)
	return signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGHUP)
}

func runBoard() error {
	ctx, stop := tuiContext()
	defer stop()
	return board.Run(ctx)
}

func runAttach(session string) error {
	cfg, err := client.Load()
	if err != nil {
		return err
	}
	ctx, stop := tuiContext()
	defer stop()
	return attach.Run(ctx, cfg, session)
}
