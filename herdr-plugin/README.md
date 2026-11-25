# Quorum herdr plugin

Opens `quorum board` as an overlay pane in herdr: every session on every machine, grouped by
attention (needs you, working, background, done-unread, idle).

- `↑`/`↓` or `j`/`k` move, `/` filters by name, project or machine, `Esc` clears the filter.
- `Enter` on a session in this machine's herdr focuses its pane. On another machine's session it
  opens a new tab running `quorum attach <session>`, which mirrors that pane through the hub
  (`Ctrl-]` detaches).
- `q` or `Esc` closes the board.

## Install

Requires herdr 0.9.5 or newer and a paired `quorum` on `PATH`:

```bash
quorum pair <hubURL> <code>
herdr plugin link /path/to/quorum/herdr-plugin
```

The plugin has no build step and no startup hook: it only runs when you open the board.

## Notifications (`quorum watch`)

`quorum watch` shows each attention (a session needs you or finished) as a herdr notification
and, under WSL, as a Windows toast. Run it as a systemd user service:

```bash
make quorum-service
```

which builds `quorum` into `~/.local/bin` and does the same as:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/quorum-watch.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now quorum-watch
```

Logs: `journalctl --user -u quorum-watch -f`. The service exits with status 2 and is not
restarted when the device is not paired, `client.json` is broken or the token was revoked; pair
again and run `systemctl --user restart quorum-watch`. herdr is found through `HERDR_BIN_PATH`,
then `PATH`, then `~/.local/bin/herdr`; under WSL, `powershell.exe` through `PATH`, then
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, and a missing `WSL_INTEROP`
(the case in a systemd service) is filled in with the newest `/run/WSL/*_interop` socket.

## Keybinding

Add to `~/.config/herdr/config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+q"
type = "plugin_action"
command = "quorum.board"
description = "Quorum board"
```

`prefix+shift+q` is unbound in herdr's default keymap. Without a binding, open the board with
`herdr plugin action invoke quorum.board` or `herdr plugin pane open --plugin quorum --entrypoint board`.
