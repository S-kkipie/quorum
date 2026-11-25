package client

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

type call struct {
	name string
	args []string
	env  []string
}

type fakeRunner struct {
	calls []call
	err   map[string]error
}

func (f *fakeRunner) run(_ context.Context, name string, args []string, env []string) error {
	f.calls = append(f.calls, call{name, args, env})
	return f.err[name]
}

// isolate makes the binary lookups and the interop discovery see nothing of this machine.
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	oldLook, oldHome, oldGlob, oldPS := lookPath, userHomeDir, interopGlob, winPS
	t.Cleanup(func() { lookPath, userHomeDir, interopGlob, winPS = oldLook, oldHome, oldGlob, oldPS })
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	userHomeDir = func() (string, error) { return home, nil }
	interopGlob = filepath.Join(t.TempDir(), "*_interop")
	winPS = filepath.Join(home, "no-powershell.exe")
	t.Setenv("HERDR_BIN_PATH", "")
	t.Setenv("WSL_INTEROP", "")
	return home
}

func TestHerdrArgsExact(t *testing.T) {
	isolate(t)
	f := &fakeRunner{}
	n := &Notifier{Run: f.run}
	n.Notify(context.Background(), "api · vps-1", "Needs you")
	require.Equal(t, []call{{"herdr", []string{"notification", "show", "api · vps-1", "--body", "Needs you"}, nil}}, f.calls)
}

func TestHerdrBinFromEnv(t *testing.T) {
	isolate(t)
	t.Setenv("HERDR_BIN_PATH", "/opt/herdr")
	f := &fakeRunner{}
	(&Notifier{Run: f.run}).Notify(context.Background(), "t", "b")
	require.Equal(t, "/opt/herdr", f.calls[0].name)
}

func TestHerdrFailureStillToasts(t *testing.T) {
	isolate(t)
	f := &fakeRunner{err: map[string]error{"herdr": errors.New("no server")}}
	n := &Notifier{Run: f.run, WSL: true}
	n.Notify(context.Background(), "t", "b")
	require.Len(t, f.calls, 2)
	require.Equal(t, "powershell.exe", f.calls[1].name)
}

func TestToastUsesEnvNotInterpolation(t *testing.T) {
	isolate(t)
	t.Setenv("WSLENV", "PATH/l")
	f := &fakeRunner{}
	n := &Notifier{Run: f.run, WSL: true}
	title, body := `x"; Remove-Item C:\ ; '$(evil)`, "`b`\nline2"
	n.Notify(context.Background(), title, body)
	c := f.calls[1]
	require.Equal(t, "powershell.exe", c.name)
	require.Equal(t, []string{"-NoProfile", "-Command"}, c.args[:2])
	require.Len(t, c.args, 3)
	require.NotContains(t, c.args[2], "Remove-Item")
	require.NotContains(t, c.args[2], "evil")
	require.NotContains(t, c.args[2], "line2")
	require.Contains(t, c.args[2], "$env:QUORUM_TOAST_TITLE")
	require.Contains(t, c.args[2], "$env:QUORUM_TOAST_BODY")
	require.Contains(t, c.env, "QUORUM_TOAST_TITLE="+title)
	require.Contains(t, c.env, "QUORUM_TOAST_BODY="+body)
	require.Contains(t, c.env, "WSLENV=PATH/l:QUORUM_TOAST_TITLE:QUORUM_TOAST_BODY")
}

func TestNoToastOutsideWSL(t *testing.T) {
	isolate(t)
	f := &fakeRunner{}
	(&Notifier{Run: f.run}).Notify(context.Background(), "t", "b")
	require.Len(t, f.calls, 1)
}

func TestDetectWSL(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "version")
	require.False(t, detectWSL(p)) // missing
	require.NoError(t, os.WriteFile(p, []byte("Linux version 6.1 (gcc) #1 SMP"), 0o644))
	require.False(t, detectWSL(p))
	require.NoError(t, os.WriteFile(p, []byte("Linux version 6.18.58.1-microsoft-standard-WSL2"), 0o644))
	require.True(t, detectWSL(p))
}

func TestTextFallbackForOldHub(t *testing.T) {
	env := proto.Envelope{Type: "attention", Machine: "vps-1", Session: "s1"}
	title, body := Text(env, proto.Attention{Session: "s1", Kind: "needs_you"})
	require.Equal(t, "Session · vps-1", title)
	require.Equal(t, "Needs you", body)
	_, body = Text(env, proto.Attention{Kind: "done"})
	require.Equal(t, "Finished", body)
	title, body = Text(env, proto.Attention{Title: "api · vps-1", Body: "Needs you: question"})
	require.Equal(t, "api · vps-1", title)
	require.Equal(t, "Needs you: question", body)
	require.False(t, strings.Contains(title, "\x00"))
}

func TestHerdrDashTitleAndBodyStayLiteral(t *testing.T) {
	isolate(t)
	f := &fakeRunner{}
	(&Notifier{Run: f.run}).Notify(context.Background(), "-rf · vps-1", "--sound done")
	require.Equal(t, []string{"notification", "show", "-rf · vps-1", "--body", "--sound done"}, f.calls[0].args)
}

func TestHerdrLookupOrder(t *testing.T) {
	home := isolate(t)
	require.Equal(t, "herdr", herdrBin()) // nothing anywhere

	local := filepath.Join(home, ".local", "bin", "herdr")
	require.NoError(t, os.MkdirAll(filepath.Dir(local), 0o755))
	require.NoError(t, os.WriteFile(local, []byte("#!/bin/sh\n"), 0o755))
	require.Equal(t, local, herdrBin()) // the systemd PATH lacks ~/.local/bin

	lookPath = func(n string) (string, error) { return "/usr/bin/" + n, nil }
	require.Equal(t, "/usr/bin/herdr", herdrBin())

	t.Setenv("HERDR_BIN_PATH", "/opt/herdr")
	require.Equal(t, "/opt/herdr", herdrBin())
}

func TestPowershellLookupOrder(t *testing.T) {
	home := isolate(t)
	require.Equal(t, "powershell.exe", powershellBin())

	winPS = filepath.Join(home, "powershell.exe")
	require.NoError(t, os.WriteFile(winPS, nil, 0o755))
	require.Equal(t, winPS, powershellBin())

	lookPath = func(n string) (string, error) { return "/mnt/c/WINDOWS/" + n, nil }
	require.Equal(t, "/mnt/c/WINDOWS/powershell.exe", powershellBin())
}

func TestToastFindsInteropSocket(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	interopGlob = filepath.Join(dir, "*_interop")
	old, newer := filepath.Join(dir, "12_interop"), filepath.Join(dir, "345_interop")
	require.NoError(t, os.WriteFile(old, nil, 0o600))
	require.NoError(t, os.WriteFile(newer, nil, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "unrelated"), nil, 0o600))
	now := time.Now()
	require.NoError(t, os.Chtimes(old, now.Add(-time.Hour), now.Add(-time.Hour)))
	require.NoError(t, os.Chtimes(newer, now, now))

	f := &fakeRunner{}
	(&Notifier{Run: f.run, WSL: true}).Notify(context.Background(), "t", "b")
	require.Contains(t, f.calls[1].env, "WSL_INTEROP="+newer)
	require.NotContains(t, f.calls[0].env, "WSL_INTEROP="+newer) // herdr needs no interop
}

func TestToastKeepsExistingInterop(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	interopGlob = filepath.Join(dir, "*_interop")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "1_interop"), nil, 0o600))
	t.Setenv("WSL_INTEROP", "/run/WSL/9_interop")
	f := &fakeRunner{}
	(&Notifier{Run: f.run, WSL: true}).Notify(context.Background(), "t", "b")
	for _, e := range f.calls[1].env {
		require.False(t, strings.HasPrefix(e, "WSL_INTEROP="), e)
	}
}

func TestToastWithoutInteropLogsOnce(t *testing.T) {
	isolate(t)
	var logs []string
	oldLog := logf
	t.Cleanup(func() { logf = oldLog })
	logf = func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }
	f := &fakeRunner{}
	n := &Notifier{Run: f.run, WSL: true}
	n.Notify(context.Background(), "t", "b")
	n.Notify(context.Background(), "t", "b")
	n2 := 0
	for _, l := range logs {
		if strings.Contains(l, "WSL_INTEROP") {
			n2++
		}
	}
	require.Equal(t, 1, n2)
	require.Len(t, f.calls, 4) // the toast is still attempted
}

func TestSessionNameMatchesTheApp(t *testing.T) {
	require.Equal(t, "fixing the login", SessionName(proto.SessionInfo{Name: "api", Recap: "fixing the login"}))
	require.Equal(t, "api", SessionName(proto.SessionInfo{Name: "api", Recap: "  "}))
	require.Equal(t, "Session", SessionName(proto.SessionInfo{}))
}
