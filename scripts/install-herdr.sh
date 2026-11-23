#!/bin/sh
# Installs herdr (terminal multiplexer) and its Claude integration. Idempotent, no root.
# Usage: scripts/install-herdr.sh
# Only touches ~/.local/bin, ~/.config/systemd/user/herdr-server.service and whatever 'herdr integration' writes.
set -eu

MIN="0.9.5"
DEST="$HOME/.local/bin"
case ":$PATH:" in *":$DEST:"*) ;; *) PATH="$DEST:$PATH"; export PATH ;; esac

if ! command -v herdr >/dev/null 2>&1; then
  echo "installing herdr..."
  curl -fsSL https://herdr.dev/install.sh | sh
  command -v herdr >/dev/null 2>&1 || { echo "error: herdr is not in PATH nor in $DEST" >&2; exit 1; }
fi

# ver_ge A B: succeeds if version A >= B (numeric, per component, POSIX sh).
ver_ge() {
  _a=$1; _b=$2
  for _i in 1 2 3; do
    _x=${_a%%.*}; _y=${_b%%.*}
    case "$_a" in *.*) _a=${_a#*.} ;; *) _a=0 ;; esac
    case "$_b" in *.*) _b=${_b#*.} ;; *) _b=0 ;; esac
    _x=${_x:-0}; _y=${_y:-0}
    [ "$_x" -gt "$_y" ] && return 0
    [ "$_x" -lt "$_y" ] && return 1
  done
  return 0
}

# "herdr 0.9.5" -> 0.9.5 (first version-shaped token).
VER="$(herdr --version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1 || true)"
[ -n "$VER" ] || { echo "error: could not read the version from 'herdr --version'" >&2; exit 1; }
ver_ge "$VER" "$MIN" || { echo "error: herdr $VER is older than $MIN; upgrade it" >&2; exit 1; }
echo "herdr $VER ready"

if [ -d "$HOME/.claude" ]; then
  herdr integration install claude || echo "warning: 'herdr integration install claude' failed; check 'herdr integration status'" >&2
fi

# If a server is already responding (e.g. the owner's herdr), nothing else is touched.
# Only probe if the socket exists: that way we never invoke a CLI that could start or hang.
SOCK="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
if [ -S "$SOCK" ]; then
  if command -v timeout >/dev/null 2>&1; then PROBE="timeout 5 herdr"; else PROBE="herdr"; fi
  if $PROBE workspace list >/dev/null 2>&1; then
    echo "the herdr server already responds; leaving everything else alone"
  else
    echo "warning: socket $SOCK exists but did not respond; a server may be hung." >&2
    echo "  Not creating the service. If no server is running, delete the socket and run this script again." >&2
  fi
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "no user systemd: start 'herdr server' yourself"
  exit 0
fi

HERDR_BIN="$(command -v herdr)"
HERDR_DIR="$(dirname "$HERDR_BIN")"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/herdr-server.service" <<UNIT
[Unit]
Description=herdr server (headless)

[Service]
ExecStart=$HERDR_BIN server
Restart=on-failure
Environment=PATH=$HERDR_DIR:%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now herdr-server
echo "herdr-server service enabled"

if [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)" != "Linger=yes" ]; then
  echo "warning: linger is off; the server will stop when your last session closes." >&2
  echo "  enable it (with admin rights): sudo loginctl enable-linger $(id -un)" >&2
fi
