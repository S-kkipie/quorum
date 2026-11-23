# Quorum

Centro de mando personal para sesiones de Claude Code en varias máquinas. Desde el celular ves todas tus sesiones, lees el chat en vivo, mandas prompts, respondes permisos y preguntas, y abres o cierras sesiones.

Diseño completo: [docs/superpowers/specs/2026-11-22-quorum-design.md](docs/superpowers/specs/2026-11-22-quorum-design.md)

## Arquitectura

```
 celular / navegador (app React, servida por el hub)
          |  HTTPS por tailnet (tailscale serve)
          v
   quorum-hub  (una instancia, Go, SQLite)  127.0.0.1:7420
          ^  WebSocket (token de máquina)
          |
   quorumd  (uno por máquina, Go)  <--socket local-->  mod de Claude Code (TypeScript)
          |                                              dentro de cada sesión `claude`
          +-- lanza sesiones nuevas (tmux / Windows Terminal / Terminal.app)
```

- Hub: agrega sesiones, guarda eventos y sirve la app web embebida.
- Daemon: uno por máquina; conecta las sesiones locales con el hub y las lanza.
- Mod: plugin de Claude Code que emite eventos y recibe prompts y decisiones.
- App: panel React para ver y gobernar las sesiones.

## Instalar el hub

En la máquina que será el hub (normalmente una VPS):

```sh
make build
scripts/install-hub.sh
tailscale serve --bg 7420
```

El script copia `quorum-hub` a `~/.local/bin`, crea la unidad de usuario `quorum-hub.service` (`serve --addr 127.0.0.1:7420`) y activa `loginctl enable-linger`. Es idempotente.

## Emparejar el celular

```sh
quorum-hub pair
```

Abre la URL de tu tailnet en el celular y escribe el código (un solo uso). Los dispositivos se listan con `quorum-hub devices` y se revocan con `quorum-hub revoke device <nombre>`.

## Enlazar máquinas

En cada máquina de trabajo:

```sh
scripts/install-daemon.sh        # copia quorumd e instala el plugin quorum
quorumd link <url-del-hub> <código>
```

El código sale de `quorum-hub link-code` en el hub. El script ejecuta `claude plugin marketplace add S-kkipie/quorum && claude plugin install quorum@quorum`. Para revocar una máquina: `quorum-hub revoke machine <nombre>`.

## Seguridad

Quorum da control remoto total de las máquinas por diseño.

- El hub escucha por defecto en loopback (`127.0.0.1:7420`; `--addr` lo cambia) y el daemon siempre en loopback. Publica el hub en tu tailnet con `tailscale serve`, nunca con `tailscale funnel`.
- Dispositivos: código de un solo uso que da un token propio, revocable.
- Máquinas: código de un solo uso que da un token de máquina, revocable.
- El socket local entre el mod y el daemon queda restringido al usuario del sistema.

## whoas y ccapi

- whoas: el daemon lanza `claude` en un shell de login dentro de la carpeta del proyecto, así los shims de whoas y el `.whoas.yaml` del repo aplican la cuenta correcta. Quorum no hace `/login` ni toca logins globales.
- ccapi: la sesión de ccapi se detecta y se muestra como servicio de la máquina, no como sesión de trabajo (sin prompts, permisos ni notificaciones).

## Desarrollo

```sh
make test        # typecheck del mod, go test, claude plugin test mod, vitest de la app
make app         # compila la app (se embebe en el hub)
make build       # app + binarios en ./bin
make cross       # binarios para linux/amd64, linux/arm64, windows/amd64, darwin/arm64 en bin/<os>-<arch>/
make proto       # regenera los tipos TypeScript desde internal/proto
```

Verificación manual de punta a punta: [docs/e2e-etapa1.md](docs/e2e-etapa1.md).
