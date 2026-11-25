package client

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

var logf = log.Printf

// Runner runs an external command with extra environment entries (NAME=value).
type Runner func(ctx context.Context, name string, args []string, env []string) error

func execRunner(ctx context.Context, name string, args []string, env []string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	return cmd.Run()
}

// Notifier shows a notification in herdr and, under WSL, as a Windows toast.
type Notifier struct {
	Run Runner // nil: really run the commands
	WSL bool

	interopOnce sync.Once
}

// Lookups, replaced in tests. A systemd user service gets a bare PATH (no ~/.local/bin, no
// /mnt/c/...) and no WSL_INTEROP, so each binary has a fixed fallback and the interop socket is
// found under /run/WSL.
var (
	lookPath    = exec.LookPath
	userHomeDir = os.UserHomeDir
	interopGlob = "/run/WSL/*_interop"
	winPS       = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
)

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// herdrBin is $HERDR_BIN_PATH, else herdr on PATH, else ~/.local/bin/herdr, else "herdr".
func herdrBin() string {
	if b := os.Getenv("HERDR_BIN_PATH"); b != "" {
		return b
	}
	if p, err := lookPath("herdr"); err == nil {
		return p
	}
	if h, err := userHomeDir(); err == nil {
		if p := filepath.Join(h, ".local", "bin", "herdr"); isFile(p) {
			return p
		}
	}
	return "herdr"
}

// powershellBin is powershell.exe on PATH, else its fixed Windows path, else "powershell.exe".
func powershellBin() string {
	if p, err := lookPath("powershell.exe"); err == nil {
		return p
	}
	if isFile(winPS) {
		return winPS
	}
	return "powershell.exe"
}

// findInterop returns the newest WSL interop socket matching pattern, or "".
func findInterop(pattern string) string {
	matches, _ := filepath.Glob(pattern)
	best, bestT := "", time.Time{}
	for _, m := range matches {
		st, err := os.Stat(m)
		if err != nil {
			continue
		}
		if best == "" || st.ModTime().After(bestT) {
			best, bestT = m, st.ModTime()
		}
	}
	return best
}

// interopEnv sets WSL_INTEROP for the child when the environment lacks it (a systemd service);
// without it a Linux process cannot start Windows executables.
func (n *Notifier) interopEnv() []string {
	if os.Getenv("WSL_INTEROP") != "" {
		return nil
	}
	if p := findInterop(interopGlob); p != "" {
		return []string{"WSL_INTEROP=" + p}
	}
	n.interopOnce.Do(func() { logf("windows toast: WSL_INTEROP is unset and no interop socket matches %s", interopGlob) })
	return nil
}

// NewNotifier detects WSL from /proc/version.
func NewNotifier() *Notifier { return &Notifier{WSL: detectWSL("/proc/version")} }

func detectWSL(procVersion string) bool {
	b, err := os.ReadFile(procVersion)
	return err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft")
}

// toastScript reads title and body from the environment; nothing is interpolated into it. The XML
// is filled through the DOM (InnerText), so markup characters in the values are escaped.
const toastScript = `$ErrorActionPreference='Stop';` +
	`[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;` +
	`[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null;` +
	`$x=New-Object Windows.Data.Xml.Dom.XmlDocument;` +
	`$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>');` +
	`$t=$x.GetElementsByTagName('text');` +
	`$t.Item(0).InnerText=$env:QUORUM_TOAST_TITLE;` +
	`$t.Item(1).InnerText=$env:QUORUM_TOAST_BODY;` +
	`$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe';` +
	`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))`

// Notify never fails: errors are logged.
func (n *Notifier) Notify(ctx context.Context, title, body string) {
	run := n.Run
	if run == nil {
		run = execRunner
	}
	// herdr 0.9.5 takes the title as the first argument, literally (a leading "-" is fine), and
	// the token after --body literally; it supports neither "--" nor "--body=<v>".
	hctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	if err := run(hctx, herdrBin(), []string{"notification", "show", title, "--body", body}, nil); err != nil {
		logf("herdr notification: %v", err)
	}
	cancel()
	if !n.WSL {
		return
	}
	wslenv := "QUORUM_TOAST_TITLE:QUORUM_TOAST_BODY"
	if cur := os.Getenv("WSLENV"); cur != "" {
		wslenv = cur + ":" + wslenv
	}
	tctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	env := []string{"QUORUM_TOAST_TITLE=" + title, "QUORUM_TOAST_BODY=" + body, "WSLENV=" + wslenv}
	env = append(env, n.interopEnv()...)
	if err := run(tctx, powershellBin(), []string{"-NoProfile", "-Command", toastScript}, env); err != nil {
		logf("windows toast: %v", err)
	}
}

// SessionName is the name the app and the notifications show: the recap, else the name, else
// "Session".
func SessionName(s proto.SessionInfo) string {
	if r := strings.TrimSpace(s.Recap); r != "" {
		return r
	}
	if s.Name != "" {
		return s.Name
	}
	return "Session"
}

// Text returns the notification title and body of an attention; an old hub sends none, so they
// are built from the machine and kind.
func Text(env proto.Envelope, a proto.Attention) (title, body string) {
	title, body = a.Title, a.Body
	if title == "" {
		title = "Session · " + env.Machine
	}
	if body == "" {
		body = "Needs you"
		if a.Kind == "done" {
			body = "Finished"
		}
	}
	return title, body
}
