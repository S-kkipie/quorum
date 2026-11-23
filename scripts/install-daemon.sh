#!/bin/sh
# Installs quorumd and the Quorum mod/plugin on this machine. Idempotent.
# Usage: scripts/install-daemon.sh [path-to-binary]
#   (default ./bin/<os>-<arch>/quorumd, then ./bin/quorumd, then the one on PATH)
set -eu

# bin/<os>-<arch>/ from 'make cross' for this machine (e.g. linux-arm64).
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) OS=$(uname -s | tr 'A-Z' 'a-z') ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
HERE="$(dirname "$0")/.."
BIN="${1:-}"
if [ -z "$BIN" ]; then
  if [ -x "$HERE/bin/$OS-$ARCH/quorumd" ]; then BIN="$HERE/bin/$OS-$ARCH/quorumd"
  elif [ -x "$HERE/bin/quorumd" ]; then BIN="$HERE/bin/quorumd"
  else BIN="$(command -v quorumd || true)"; fi
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "error: quorumd binary not found (build it with 'make build' or 'make cross')" >&2; exit 1; }

DEST="$HOME/.local/bin"
mkdir -p "$DEST"
if [ "$(readlink -f "$BIN")" != "$(readlink -f "$DEST/quorumd" 2>/dev/null || true)" ]; then
  cp "$BIN" "$DEST/quorumd.new" && mv "$DEST/quorumd.new" "$DEST/quorumd"
fi
chmod 755 "$DEST/quorumd"
echo "binary installed at $DEST/quorumd"

case ":$PATH:" in *":$DEST:"*) ;; *) echo "warning: $DEST is not in your PATH" >&2 ;; esac

if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add S-kkipie/quorum || echo "warning: the marketplace was already added or failed; continuing"
  claude plugin install quorum@quorum || echo "warning: the plugin was already installed or failed; check 'claude plugin list'"
else
  echo "warning: 'claude' is not in PATH; install the plugin by hand:" >&2
  echo "  claude plugin marketplace add S-kkipie/quorum && claude plugin install quorum@quorum" >&2
fi

command -v herdr >/dev/null 2>&1 || echo "optional: scripts/install-herdr.sh for sessions and terminal in herdr"

cat <<MSG

Next steps:
  1. On the hub: quorum-hub link-code
  2. On this machine: quorumd link <hub-url> <code>
MSG
