# Quorum

Personal command center for Claude Code sessions across several machines. From your phone you see all your sessions, read the chat live, send prompts, answer permissions and questions, and open or close sessions.

Full design: [docs/superpowers/specs/2026-11-22-quorum-design.md](docs/superpowers/specs/2026-11-22-quorum-design.md)

## Architecture

```
 phone / browser (React app, served by the hub)
          |  HTTPS over the tailnet (tailscale serve)
          v
   quorum-hub  (single instance, Go, SQLite)  127.0.0.1:7420
          ^  WebSocket (machine token)
          |
   quorumd  (one per machine, Go)  <--local socket-->  Claude Code mod (TypeScript)
          |                                              inside each `claude` session
          +-- launches new sessions (tmux / Windows Terminal / Terminal.app)
```

- Hub: aggregates sessions, stores events and serves the embedded web app.
- Daemon: one per machine; connects local sessions to the hub and launches them.
- Mod: Claude Code plugin that emits events and receives prompts and decisions.
  It also ships the `local-artifacts` skill, so pages Claude writes for you to view come out phone-first.
- App: React panel to view and govern the sessions.

## Install the hub

On the machine that will be the hub (usually a VPS):

```sh
make build
scripts/install-hub.sh
tailscale serve --bg 7420
```

The script copies `quorum-hub` to `~/.local/bin`, creates the user unit `quorum-hub.service` (`serve --addr 127.0.0.1:7420`) and enables `loginctl enable-linger`. It is idempotent.

## Pair your phone

```sh
quorum-hub pair
```

Open your tailnet URL on the phone and type the code (single use). Devices are listed with `quorum-hub devices` and revoked with `quorum-hub revoke device <name>`.

For the Android app with push notifications (Firebase setup, `make apk`, sideloading), see [docs/android.md](docs/android.md).

## Link machines

On each work machine:

```sh
scripts/install-daemon.sh        # copies quorumd and installs the quorum plugin
quorumd link <hub-url> <code>
```

The code comes from `quorum-hub link-code` on the hub. The script runs `claude plugin marketplace add S-kkipie/quorum && claude plugin install quorum@quorum`. To revoke a machine: `quorum-hub revoke machine <name>`.

## herdr

[herdr](https://herdr.dev) gives each machine persistent tabs for Claude sessions and a "Terminal" view in the app (see the screen, send text and keys such as Ctrl-C). Quorum only creates its own tabs and panes: it never renames or closes yours.

```sh
scripts/install-herdr.sh   # installs herdr (>= 0.9.5), the Claude integration and, if there is no server, a user service
```

If a herdr server is already responding (for example yours on your PC), the script touches nothing else. On a server with no open session, `sudo loginctl enable-linger <user>` is advisable. Machines without herdr keep working: they launch with tmux (or `wt`/osascript) and have no terminal view.

## Security

Quorum gives full remote control of the machines by design.

- The hub listens on loopback by default (`127.0.0.1:7420`; `--addr` changes it) and the daemon always on loopback. Publish the hub on your tailnet with `tailscale serve`, never with `tailscale funnel`.
- Devices: single-use code that yields their own revocable token.
- Machines: single-use code that yields a revocable machine token.
- The local socket between the mod and the daemon is restricted to the system user.

## whoas and ccapi

- whoas: the daemon launches `claude` in a login shell inside the project folder, so the whoas shims and the repo's `.whoas.yaml` apply the right account. Quorum never runs `/login` or touches global logins.
- ccapi: the ccapi session is detected and shown as a machine service, not a work session (no prompts, permissions or notifications).

## Development

```sh
make test        # mod typecheck, go test, claude plugin test mod, app vitest
make app         # builds the app (embedded in the hub)
make build       # app + binaries in ./bin
make cross       # binaries for linux/amd64, linux/arm64, windows/amd64, darwin/arm64 into bin/<os>-<arch>/
make proto       # regenerates the TypeScript types from internal/proto
```

Manual end-to-end verification: [docs/e2e-stage1.md](docs/e2e-stage1.md).
