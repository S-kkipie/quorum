# Quorum — sesiones y terminal sobre herdr (celular primero)

Fecha: 2026-11-23 · Estado: borrador para aprobación · Complementa el diseño general (`2026-11-22-quorum-design.md`)

## 1. Qué y por qué

El dueño trabaja todos los días dentro de **herdr** (multiplexor de terminales para agentes: workspaces, pestañas y paneles persistentes, con detección del estado de Claude). Quorum hoy lanza sesiones con tmux / Windows Terminal y no tiene terminal remota. El dueño quiere, **desde el celular primero**:

1. **Abrir una sesión nueva de Claude Code directamente en el proyecto en el que está**, en cualquier máquina (sobre todo servidores), con whoas y con `--dangerously-skip-permissions` a un toque. Siempre es "Nueva sesión": nada de "feature" o "bug"; Claude dentro de la sesión maneja ramas y lo demás.
2. **Retomar una conversación anterior** del proyecto.
3. **Usar terminales reales de los servidores** desde el celular.

Todo eso debe vivir dentro de herdr: lo que se abre desde el celular aparece en el herdr del dueño y viceversa.

## 2. Objetivos

- **G1. Nueva sesión en un toque** desde la pantalla de un proyecto (o desde una sesión de ese proyecto), con las opciones recordadas.
- **G2. Retomar conversación**: lista de conversaciones anteriores del proyecto en esa máquina; un toque la reanuda (`claude --resume <id>`).
- **G3. Las sesiones nacen en herdr**: una pestaña nueva del workspace de herdr del proyecto en esa máquina, con Claude arrancado por herdr (`herdr agent start --kind claude`), por shell de login (whoas).
- **G4. Terminal real** en el celular: un panel de herdr en la carpeta del proyecto, visto en vivo (colores) con teclado y teclas especiales; persistente.
- **G5. Al lanzar, el celular te lleva a la sesión nueva** (no esperar a que aparezca en la lista).
- **G6.** herdr instalado y corriendo como servicio en cada máquina de Quorum (empezando por el servidor Linux arm64 y la PC con WSL).

## 3. No-objetivos

- Elegir modelo, nombre de sesión o worktree al lanzar (Claude se encarga; se puede agregar después).
- Clonar repos / carpetas nuevas desde el celular (lo hacía pastor; queda para después).
- Explorador de archivos, git en la app.
- Reemplazar el TUI de herdr en escritorio.

## 4. Anti-objetivos

- Que abrir una sesión desde el celular requiera más de 2 toques en el caso normal.
- Que una sesión lanzada desde Quorum **no** aparezca en el herdr del dueño (o aparezca en un lugar raro).
- Una "terminal" que solo ejecuta comandos de a uno (el error de pastor).
- Saltarse whoas (lanzar `claude` por ruta absoluta o sin shell de login).
- Romper o reorganizar los workspaces que el dueño ya tiene abiertos en herdr.

## 5. Restricciones

- herdr 0.9.5 (protocolo 22) en la PC con WSL; el servidor Linux arm64 no lo tiene todavía. herdr expone una API por socket (`$XDG_RUNTIME_DIR`/`~/.config/herdr/herdr.sock`) y CLI con salida JSON: `workspace list/create`, `tab create`, `pane split/read/send-keys/send-text/close`, `agent start/list/get/wait`, `events.subscribe` (eventos `pane.updated`, `pane.agent_status_changed`, `pane.created/closed`, …), `pane.read --format ansi --source visible|recent`.
- `herdr agent start` exige un panel en el prompt del shell y devuelve cuando Claude está listo; los argumentos de claude van tras `--`.
- El mod sigue registrando la sesión en Quorum como hoy; dentro de un panel de herdr tiene `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`.
- Máquinas sin herdr deben seguir funcionando con el lanzador actual (tmux / wt.exe).
- Celular primero: pantallas pensadas para una mano; escritorio usa lo mismo con más espacio.

## 6. Enfoques (elegido A)

| Enfoque | Resumen | Por qué no / sí |
|---|---|---|
| **A. quorumd maneja el herdr local de cada máquina** ✅ | Cada `quorumd` habla con su herdr por socket/CLI; sesiones = pestañas en el workspace del proyecto; terminal = panel de herdr espejado al celular | Una sola experiencia en todas las máquinas; lo que hace el celular aparece en herdr |
| B. herdr solo donde ya exista, tmux en servidores | Menos instalación | Dos experiencias; sin terminal real en servidores |
| C. Modo remoto SSH de herdr | herdr-a-herdr | No sirve para un celular |

## 7. Diseño

### 7.1 Mapeo Quorum ↔ herdr (por máquina)
- **Proyecto/checkout → workspace de herdr**: el daemon busca un workspace cuyo cwd raíz sea el `root` del checkout (vía `workspace list` + `pane list`/cwd); si no hay, crea uno (`workspace create --cwd <root>`, label = nombre del proyecto en Quorum o el basename). Nunca renombra ni cierra workspaces existentes.
- **Sesión → pestaña nueva** en ese workspace (`tab create`), con su panel raíz en `<root>`; ahí `herdr agent start q<shortid> --kind claude --pane <pane> -- <flags>`.
- **Terminal → pestaña "terminal"** en ese workspace (una por proyecto y máquina, reutilizada; botón "Nueva terminal" crea otra), con un shell de login.
- El mod reporta en `SessionInfo` su `herdrPane` (de `HERDR_PANE_ID`) y `herdrWorkspace`; así el hub sabe qué panel de herdr corresponde a cada sesión (para "abrir terminal aquí", y para atar el lanzamiento).

### 7.2 Lanzar (Nueva sesión / Retomar)
- Flags de claude: `--dangerously-skip-permissions` si "Sin permisos", si no `--permission-mode <modo>`; `--resume <id>` para retomar. Siempre a través de un shell de login en el panel (el panel ya es un shell de login de herdr; verificar que herdr arranca shells de login — si no, `agent start` se hace tras `exec bash -l` en el panel). whoas aplica por PATH.
- Confiar en la carpeta: igual que pastor, el daemon marca la carpeta como confiada en `~/.claude.json` antes de lanzar (escritura atómica), para que no salga el diálogo de confianza. Opción por defecto activa.
- Respuesta inmediata al celular con `reqId`; cuando el mod de la nueva sesión se registra con ese `herdrPane`, el hub la asocia y la app **navega sola** a la sesión (pantalla "Arrancando…" mientras tanto; timeout 60 s con error claro y botón "Ver en terminal").
- Máquinas sin herdr: lanzador actual (tmux/wt) como respaldo, mismo flujo en la app.

### 7.3 Conversaciones anteriores (Retomar)
- El daemon lista `~/.claude/projects/<cwd codificado>/*.jsonl` del `root`: id, título (resumen de Claude si existe, si no el primer prompt del usuario recortado), primer prompt, mensajes, última actividad; marca las que están abiertas ahora (sesión viva con ese id). Máx. 60, más recientes primero. Endpoint del hub que pide la lista a la máquina (`GET /api/machines/{m}/conversations?root=`).
- Tocar una abierta → ir a esa sesión; tocar una cerrada → retomar en una pestaña nueva.

### 7.4 Terminal en el celular
- El daemon se suscribe a `events.subscribe` del herdr local y, para los paneles que un dispositivo está mirando, manda **fotos de pantalla** (`pane.read --source visible --format ansi`) cuando hay `pane.updated`, como mucho ~8 por segundo, por el canal del hub (`term_frame {machine, pane, cols, rows, ansi}`); solo mientras hay alguien mirando.
- Entrada: texto (`pane.send_text`) y teclas (`pane.send_keys`: Esc, Tab, Enter, Ctrl-C, Ctrl-D, Ctrl-L, flechas, PgUp/PgDn).
- La app dibuja con xterm.js (o un render ANSI de solo lectura) ajustado al ancho del celular (fuente que entre en el ancho del panel; scroll horizontal si no entra).
- Persistente: cerrar la vista no cierra el panel. "Cerrar terminal" la cierra (`pane close`) con confirmación.

### 7.5 Pantallas del celular

Proyecto (al entrar desde el tablero):
```
← Mi proyecto                      Trabajo
┌───────────────────────────────────────┐
│  ▶ Nueva sesión          vps-1 ▾      │  ← botón grande; chip de máquina
│  ⛔ Sin permisos  ✓                    │  ← recordado por proyecto
└───────────────────────────────────────┘
  ⌨ Terminal                              ← abre/reutiliza la terminal del proyecto
SESIONES ABIERTAS
  ● Arreglando el login con OAuth   trabajando
CONVERSACIONES
  Refactor del checkout   hace 2 h · 48 msj
  Ajustar estilos del header   ayer · 12 msj
  …                                (buscar si hay > 6)
TICKETS · RESUMEN · AVANCE (lo del Plan 2, debajo)
```

Terminal:
```
← Terminal · proyecto · vps-1          ⋯
┌───────────────────────────────────────┐
│ usuario@vps:~/proyecto$ git status    │  pantalla en vivo con colores
│ On branch main …                      │
└───────────────────────────────────────┘
[Esc][Tab][Ctrl-C][↑][↓][←][→][Ctrl-D]
[ escribe y Enter…                  ⏎ ]
```

Nueva sesión arrancando: la app pasa a la pantalla de la sesión con "Arrancando Claude en vps-1…" y el chat aparece cuando llega.

### 7.6 Instalación de herdr
- Script `scripts/install-herdr.sh`: instala el binario oficial de herdr (linux amd64/arm64) en `~/.local/bin` si falta, instala su integración de Claude (`herdr integration install claude` o equivalente, para estados de agente), y crea un servicio systemd de usuario `herdr-server` (`herdr server`, sesión por defecto). En la PC del dueño herdr ya corre: no se toca su servidor.
- `quorumd` detecta herdr (binario + socket); si no está, usa el lanzador de respaldo y la app muestra "Terminal no disponible en esta máquina (falta herdr)".

## 7.7 Decisiones tras la revisión del constructor (decisiones del autor del diseño; el dueño puede corregirlas)
- **Autorización de la terminal:** cualquier dispositivo emparejado puede abrir terminales y mandar teclas, igual que hoy puede mandar prompts y aprobar permisos: Quorum es de un solo dueño y emparejar ya equivale a control total (§14 del diseño general). Se agrega un **registro** en el hub (quién abrió qué terminal y cuándo) y cada máquina tiene un interruptor `terminal: true|false` en la config de `quorumd` (por defecto true).
- **Qué herdr usar:** la sesión `default` de herdr de cada máquina (la que usa el dueño; en esta PC es `~/.config/herdr/herdr.sock`). Config opcional `herdrSession` en `quorumd` para usar otra.
- **Atar el lanzamiento a la sesión:** por el id de panel de herdr: el daemon recuerda `{reqId → pane}` al crear la pestaña; el mod reporta `HERDR_PANE_ID`; el primer registro en ese panel en 60 s se asocia (y si es "Retomar", la app navega a lo que se registre en ese panel, sea cual sea su id). "Abierta ahora" en la lista de conversaciones compara por id de sesión de Claude (`--resume` mantiene el id; si Claude lo cambia, el mod ya informa `previousId`).
- **Workspace ambiguo:** 1) el workspace que Quorum usó antes para ese root en esa máquina (el daemon lo recuerda por id de workspace mientras exista); 2) si no, el workspace cuyo panel raíz tenga ese cwd y esté enfocado o se haya usado más recientemente; 3) si no, uno nuevo. Varios checkouts del mismo proyecto en una máquina: se usa el checkout elegido (el de la sesión desde la que se lanza o el último usado).
- **Tamaño del panel en el celular:** el celular **nunca** redimensiona paneles (no desarma el layout del dueño). Se ve al tamaño real del panel con fuente ajustada al ancho, zoom con pellizco y scroll horizontal; el historial se lee con `--source recent` (PgUp/PgDn desplazan la vista en la app, no envían teclas). Las terminales que abre Quorum son pestañas propias, así que su tamaño es el del herdr.
- **Transporte de las fotos de pantalla:** por el WebSocket existente daemon↔hub↔app, mensaje `term_frame`, **solo la última foto** por panel (coalescing; nunca se encola más de una), ≤ 8/s, ≤ 256 KiB por foto.
- **"Sin permisos" por defecto:** activado la primera vez (pedido del dueño). Si la máquina corre como root, Claude rechaza ese flag: el daemon lo detecta y la app lo muestra deshabilitado con el motivo. Hoy las máquinas usan usuarios normales (no root).
- **Plataformas con herdr:** Linux amd64/arm64 y WSL (herdr dentro de WSL, como en esta PC). macOS y Windows nativo usan el lanzador de respaldo por ahora.

## 8. Lo que queda al constructor
- Cliente de herdr: CLI con JSON vs. socket directo (preferir CLI salvo para `events.subscribe`).
- Detalles del render de terminal en el celular (xterm.js vs. render propio), tamaño de fuente y tasa de fotos dentro del límite.
- Cómo detectar el workspace del proyecto (por cwd del panel raíz o metadatos `workspace report-metadata`).
- Limpieza de pestañas de sesiones terminadas (dejar a herdr/al dueño; Quorum no cierra pestañas salvo "Cerrar sesión").
