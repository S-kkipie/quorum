package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/S-kkipie/quorum/internal/daemon"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		if p := os.Getenv(daemon.LogEnv); p != "" {
			log.SetOutput(daemon.NewRotatingLog(p)) // launched by ensure: log with rotation
		}
		cfg, err := daemon.LoadConfig()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := daemon.Serve(ctx, cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "ensure":
		r := daemon.Ensure()
		daemon.PrintJSON(r)
		if !r.OK {
			os.Exit(1)
		}
	case "attach":
		fs := flag.NewFlagSet("attach", flag.ContinueOnError)
		session := fs.String("session", "", "session id")
		if err := fs.Parse(os.Args[2:]); err != nil || *session == "" {
			fmt.Fprintln(os.Stderr, "uso: quorumd attach --session <id>")
			os.Exit(2)
		}
		cfg, err := daemon.LoadConfig()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		code := daemon.RunAttach(ctx, fmt.Sprintf("http://127.0.0.1:%d", cfg.Port), cfg.LocalToken, *session, os.Stdout, os.Stderr)
		stop()
		os.Exit(code)
	case "hold":
		// launched by the mod from tool.check while it waits for a permission from the device
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		daemon.Hold(ctx, daemon.HoldMax)
		stop()
	case "link":
		if len(os.Args) != 4 {
			fmt.Fprintln(os.Stderr, "usage: quorumd link <hubURL> <code>")
			os.Exit(2)
		}
		cfg, err := daemon.LoadConfig()
		if err != nil {
			fmt.Fprintln(os.Stderr, "could not read the config:", err)
			os.Exit(1)
		}
		cfg, err = daemon.LinkMachine(context.Background(), cfg, os.Args[2], os.Args[3])
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		fmt.Printf("linked as %s with %s\n", cfg.Machine, cfg.Hub)
		if err := daemon.ReloadRunning(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "warning: the daemon did not reload; it will link on next start:", err)
		}
	case "meetings":
		sub := ""
		if len(os.Args) > 2 {
			sub = os.Args[2]
		}
		switch sub {
		case "setup":
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			err := daemon.MeetingsSetup(ctx, os.Stdout)
			stop()
			if err != nil {
				fmt.Fprintln(os.Stderr, "error:", err)
				os.Exit(1)
			}
		case "status":
			daemon.MeetingsStatus(os.Stdout)
		default:
			fmt.Fprintln(os.Stderr, "usage: quorumd meetings [setup|status]")
			os.Exit(2)
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: quorumd [serve|ensure --json|attach --session <id>|hold|link <hubURL> <code>|meetings setup|status]")
		os.Exit(2)
	}
}
