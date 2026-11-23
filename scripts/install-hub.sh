#!/bin/sh
# Installs quorum-hub as a systemd user service. Idempotent.
# Usage: scripts/install-hub.sh [path-to-binary]
#   (default ./bin/<os>-<arch>/quorum-hub, then ./bin/quorum-hub, then the one on PATH)
set -eu

# bin/<os>-<arch>/ from 'make cross' for this machine (e.g. linux-arm64).
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) OS=$(uname -s | tr 'A-Z' 'a-z') ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
HERE="$(dirname "$0")/.."
BIN="${1:-}"
if [ -z "$BIN" ]; then
  if [ -x "$HERE/bin/$OS-$ARCH/quorum-hub" ]; then BIN="$HERE/bin/$OS-$ARCH/quorum-hub"
  elif [ -x "$HERE/bin/quorum-hub" ]; then BIN="$HERE/bin/quorum-hub"
  else BIN="$(command -v quorum-hub || true)"; fi
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "error: quorum-hub binary not found (build it with 'make build')" >&2; exit 1; }

DEST="$HOME/.local/bin"
UNITDIR="$HOME/.config/systemd/user"
mkdir -p "$DEST" "$UNITDIR"
if [ "$(readlink -f "$BIN")" != "$(readlink -f "$DEST/quorum-hub" 2>/dev/null || true)" ]; then
  cp "$BIN" "$DEST/quorum-hub.new" && mv "$DEST/quorum-hub.new" "$DEST/quorum-hub"
fi
chmod 755 "$DEST/quorum-hub"
echo "binary installed at $DEST/quorum-hub"

cat > "$UNITDIR/quorum-hub.service" <<UNIT
[Unit]
Description=Quorum hub
After=network.target

[Service]
ExecStart=$DEST/quorum-hub serve --addr 127.0.0.1:7420
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT

# linger first: starts the systemd user manager even with no open session.
loginctl enable-linger "$(id -un)" || echo "warning: could not enable linger; the hub will not start without an open session" >&2
if ! systemctl --user daemon-reload; then
  cat >&2 <<HINT
error: 'systemctl --user' does not work (no user bus).
  - On WSL, enable systemd in /etc/wsl.conf ([boot] systemd=true) and restart with 'wsl --shutdown'.
  - Over SSH or su/sudo, use a real login session of the user (or export
    XDG_RUNTIME_DIR=/run/user/\$(id -u)) and run this script again.
  - Meanwhile you can run it by hand: $DEST/quorum-hub serve --addr 127.0.0.1:7420
HINT
  exit 1
fi
systemctl --user enable quorum-hub.service
systemctl --user restart quorum-hub.service
echo "quorum-hub service active on 127.0.0.1:7420"

cat <<MSG

Next steps:
  1. Publish it on your tailnet (NEVER use 'tailscale funnel'):
       tailscale serve --bg 7420
  2. Generate a code and pair your phone from the app:
       quorum-hub pair
  3. To link a machine:
       quorum-hub link-code     (then 'quorumd link <url> <code>' on that machine)
MSG
