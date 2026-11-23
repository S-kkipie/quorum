#!/bin/sh
# Instala quorumd y el mod/plugin de Quorum en esta máquina. Idempotente.
# Uso: scripts/install-daemon.sh [ruta-al-binario]
#   (por defecto ./bin/<os>-<arch>/quorumd, luego ./bin/quorumd, luego el de PATH)
set -eu

# bin/<os>-<arch>/ de 'make cross' para esta máquina (p. ej. linux-arm64).
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) OS=$(uname -s | tr 'A-Z' 'a-z') ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
HERE="$(dirname "$0")/.."
BIN="${1:-}"
if [ -z "$BIN" ]; then
  if [ -x "$HERE/bin/$OS-$ARCH/quorumd" ]; then BIN="$HERE/bin/$OS-$ARCH/quorumd"
  elif [ -x "$HERE/bin/quorumd" ]; then BIN="$HERE/bin/quorumd"
  else BIN="$(command -v quorumd || true)"; fi
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "error: no encuentro el binario quorumd (compílalo con 'make build' o 'make cross')" >&2; exit 1; }

DEST="$HOME/.local/bin"
mkdir -p "$DEST"
if [ "$(readlink -f "$BIN")" != "$(readlink -f "$DEST/quorumd" 2>/dev/null || true)" ]; then
  cp "$BIN" "$DEST/quorumd.new" && mv "$DEST/quorumd.new" "$DEST/quorumd"
fi
chmod 755 "$DEST/quorumd"
echo "binario instalado en $DEST/quorumd"

case ":$PATH:" in *":$DEST:"*) ;; *) echo "aviso: $DEST no está en tu PATH" >&2 ;; esac

if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add S-kkipie/quorum || echo "aviso: el marketplace ya estaba agregado o falló; sigo"
  claude plugin install quorum@quorum || echo "aviso: el plugin ya estaba instalado o falló; revisa 'claude plugin list'"
else
  echo "aviso: 'claude' no está en PATH; instala el plugin a mano:" >&2
  echo "  claude plugin marketplace add S-kkipie/quorum && claude plugin install quorum@quorum" >&2
fi

cat <<MSG

Siguientes pasos:
  1. En el hub: quorum-hub link-code
  2. En esta máquina: quorumd link <url-del-hub> <código>
MSG
