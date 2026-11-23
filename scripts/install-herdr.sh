#!/bin/sh
# Instala herdr (multiplexor de terminal) y su integración con Claude. Idempotente, sin root.
# Uso: scripts/install-herdr.sh
# Solo toca ~/.local/bin, ~/.config/systemd/user/herdr-server.service y lo que escriba 'herdr integration'.
set -eu

MIN="0.9.5"
DEST="$HOME/.local/bin"
case ":$PATH:" in *":$DEST:"*) ;; *) PATH="$DEST:$PATH"; export PATH ;; esac

if ! command -v herdr >/dev/null 2>&1; then
  echo "instalando herdr..."
  curl -fsSL https://herdr.dev/install.sh | sh
  command -v herdr >/dev/null 2>&1 || { echo "error: herdr no quedó en PATH ni en $DEST" >&2; exit 1; }
fi

# ver_ge A B: éxito si la versión A >= B (numérica, por componentes, POSIX sh).
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

# "herdr 0.9.5" -> 0.9.5 (primer token con forma de versión).
VER="$(herdr --version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1 || true)"
[ -n "$VER" ] || { echo "error: no pude leer la versión de 'herdr --version'" >&2; exit 1; }
ver_ge "$VER" "$MIN" || { echo "error: herdr $VER es anterior a $MIN; actualízalo" >&2; exit 1; }
echo "herdr $VER listo"

if [ -d "$HOME/.claude" ]; then
  herdr integration install claude || echo "aviso: 'herdr integration install claude' falló; revisa 'herdr integration status'" >&2
fi

# Si ya hay un servidor respondiendo (p. ej. el herdr del dueño), no se toca nada más.
# Solo se sondea si el socket existe: así nunca se invoca un CLI que podría arrancar o colgarse.
SOCK="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
if [ -S "$SOCK" ]; then
  if command -v timeout >/dev/null 2>&1; then PROBE="timeout 5 herdr"; else PROBE="herdr"; fi
  if $PROBE workspace list >/dev/null 2>&1; then
    echo "el servidor de herdr ya responde; no toco nada más"
  else
    echo "aviso: existe el socket $SOCK pero no respondió; puede haber un servidor colgado." >&2
    echo "  No creo el servicio. Si no corre ningún servidor, borra el socket y vuelve a ejecutar este script." >&2
  fi
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "sin systemd de usuario: arranca 'herdr server' por tu cuenta"
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
echo "servicio herdr-server activado"

if [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)" != "Linger=yes" ]; then
  echo "aviso: linger está apagado; el servidor se detendrá al cerrar tu última sesión." >&2
  echo "  actívalo (con permisos de administrador): sudo loginctl enable-linger $(id -un)" >&2
fi
