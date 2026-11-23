#!/bin/sh
# Instala quorum-hub como servicio de usuario de systemd. Idempotente.
# Uso: scripts/install-hub.sh [ruta-al-binario]
#   (por defecto ./bin/<os>-<arch>/quorum-hub, luego ./bin/quorum-hub, luego el de PATH)
set -eu

# bin/<os>-<arch>/ de 'make cross' para esta máquina (p. ej. linux-arm64).
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) OS=$(uname -s | tr 'A-Z' 'a-z') ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
HERE="$(dirname "$0")/.."
BIN="${1:-}"
if [ -z "$BIN" ]; then
  if [ -x "$HERE/bin/$OS-$ARCH/quorum-hub" ]; then BIN="$HERE/bin/$OS-$ARCH/quorum-hub"
  elif [ -x "$HERE/bin/quorum-hub" ]; then BIN="$HERE/bin/quorum-hub"
  else BIN="$(command -v quorum-hub || true)"; fi
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "error: no encuentro el binario quorum-hub (compílalo con 'make build')" >&2; exit 1; }

DEST="$HOME/.local/bin"
UNITDIR="$HOME/.config/systemd/user"
mkdir -p "$DEST" "$UNITDIR"
if [ "$(readlink -f "$BIN")" != "$(readlink -f "$DEST/quorum-hub" 2>/dev/null || true)" ]; then
  cp "$BIN" "$DEST/quorum-hub.new" && mv "$DEST/quorum-hub.new" "$DEST/quorum-hub"
fi
chmod 755 "$DEST/quorum-hub"
echo "binario instalado en $DEST/quorum-hub"

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

# linger primero: arranca el administrador de usuario de systemd aunque no haya sesión abierta.
loginctl enable-linger "$(id -un)" || echo "aviso: no se pudo activar linger; el hub no arrancará sin sesión abierta" >&2
if ! systemctl --user daemon-reload; then
  cat >&2 <<HINT
error: 'systemctl --user' no funciona (no hay bus de usuario).
  - En WSL, activa systemd en /etc/wsl.conf ([boot] systemd=true) y reinicia con 'wsl --shutdown'.
  - Por SSH o su/sudo, entra con una sesión de login real del usuario (o exporta
    XDG_RUNTIME_DIR=/run/user/\$(id -u)) y vuelve a correr este script.
  - Mientras tanto puedes correrlo a mano: $DEST/quorum-hub serve --addr 127.0.0.1:7420
HINT
  exit 1
fi
systemctl --user enable quorum-hub.service
systemctl --user restart quorum-hub.service
echo "servicio quorum-hub activo en 127.0.0.1:7420"

cat <<MSG

Siguientes pasos:
  1. Publícalo en tu tailnet (NUNCA uses 'tailscale funnel'):
       tailscale serve --bg 7420
  2. Genera un código y empareja el celular desde la app:
       quorum-hub pair
  3. Para enlazar una máquina:
       quorum-hub link-code     (luego 'quorumd link <url> <código>' en esa máquina)
MSG
