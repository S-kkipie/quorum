# Verificación de punta a punta, Plan 2 (proyectos)

**Corrida del 2026-11-22** en dos máquinas reales, con la app real en el navegador.

Montaje (el mismo aislamiento del e2e de la etapa 1, `docs/e2e-etapa1.md`):

- Hub en la VPS (aarch64, claude 2.1.330) en `127.0.0.1:7498`, base en `~/quorum-e2e/hub.db`. La PC llega
  por `ssh -L 17498:127.0.0.1:7498`.
- `quorumd` en la VPS con `CLAUDE_CONFIG_DIR=~/quorum-e2e/claude-config` (settings con
  `CLAUDE_CODE_PLUGIN_DIRS` hacia la copia del mod y `model: haiku`), `TMUX_TMPDIR` y `QUORUM_CONFIG_DIR` propios,
  y `~/quorum-e2e/bin` primero en el PATH. Todo bajo `~/quorum-e2e`, borrado al final.
- En la PC (WSL, claude 2.1.330): `QUORUM_CONFIG_DIR` temporal y la sesión `claude --plugin-dir ./mod --model haiku
  --permission-mode default` en un tmux con `TMUX_TMPDIR` propio.
- Repo de prueba `demo` con el remoto `https://github.com/e2e-quorum/demo.git` en las dos máquinas (PC en la rama
  `feat/1-arreglar-login`, VPS en `main`). El conector exec es el script de ejemplo de `docs/conectores.md`
  (dos tickets fijos; `comment`/`set_status` se anotan en un archivo).
- La app se manejó con agent-browser sobre el Chrome visible de Windows (escritorio y 390 px).
- Haiku: 3 prompts de usuario, unos 4 recaps y los resúmenes de proyecto (vía el ccapi del dueño en la VPS): 2 en la corrida y al
  menos 2 más mientras el hub quedó encendido sin vigilancia (ver el paso 10). Unas 11 llamadas cortas.
- La corrida se cortó por un error de red y la PC perdió `/tmp`: se fueron la sesión de la PC y las capturas de la
  primera pasada. El hub de la VPS siguió corriendo unas 6 h hasta la limpieza.

Leyenda: OK / FALLA→ARREGLADO (commit) / PENDIENTE.

| # | Paso | Resultado | Evidencia |
|---|------|-----------|-----------|
| 1 | Permiso a la vez en la terminal y en la app | FALLA→ARREGLADO (57deb94) | Prompt "crea uno.txt con Write": en tmux salió el diálogo "Permiso · Write: … · 1. Permitir 2. Denegar" y en la app la tarjeta. Pero la app mostraba además una fila `AskUserQuestion` y una segunda tarjeta de pregunta: el `$.ui.ask` del propio mod corre como `tool.call` de AskUserQuestion y el hook lo reflejaba. Contestado en la terminal: `ask_resolved{by:terminal}`, el archivo se creó y las dos tarjetas desaparecieron. Arreglo: las llamadas de mods (`next.origin` distinto de `engine`, o id `toolu_plugin_…`) pasan sin eventos. Tras la recarga en caliente, segundo prompt (dos.txt) desde el Composer: una sola tarjeta. Permitir en la app → `ask_resolved{by:device:Chrome · Windows}` y `dos.txt` creado. El diálogo de la terminal siguió abierto; contestarlo después solo mostró "quorum: Ya decidido desde Quorum", sin eventos nuevos |
| 2 | Recap como nombre | OK | Tras el primer prompt la sesión se llamó "Creando el archivo uno.txt con el texto "hola"" en la lista y la cabecera; tras el segundo, "Creando el archivo dos.txt…". La sesión abierta desde el ticket salió como "Redactando documentación para el ticket 2 del proyecto" |
| 3 | Trabajo + proyecto con conector exec | OK | Desde Configuración: "Nuevo trabajo" (E2E Quorum) y "Crear proyecto" sobre la sugerencia, con "Ejecutable (script propio)" y el comando del script. Tickets: `1 Arreglar login` `rawStatus open` → `por_hacer`; `2 Escribir docs` `in progress` → `en_curso`, assignee `ana`; avance 0/2 |
| 4 | Conector GitHub (hub local en la PC, solo lectura) | OK parcial | Ruling Y: hub local en `127.0.0.1:17499` con `S-kkipie/ccapi` y `labelsAsStatus`. Sincronizó sin error y trajo 0 tickets, igual que `gh issue list --state all` (el repo no tiene issues), así que la normalización no se pudo ver. Con un repo inexistente: "GitHub: repositorio no encontrado (S-kkipie/no-existe-quorum-e2e)". Nada se escribió en GitHub |
| 5 | Conector Paperclip contra la VPS (solo lectura) | OK | Proyecto con `baseURL http://127.0.0.1:3100` y la company ACME. El token del board se leyó en la VPS y se mandó con `PUT /api/projects/{id}/token` sin imprimirlo; la API solo devolvió `hasToken:true` y el log del hub no lo contiene. 136 tickets: `[AID-138] Chequeo del servidor` `done` → hecho, `[AID-52] …` `in_progress` → en_curso, avance 129/136. No se crearon ni aprobaron propuestas contra Paperclip |
| 6 | Proyecto sugerido por el remoto; dos checkouts | OK | Con las dos sesiones abiertas (PC y VPS en `demo`), Configuración mostró la sugerencia `https://github.com/e2e-quorum/demo.git` con las dos raíces y "2 sesiones". Al crearlo, las dos sesiones quedaron con `projectId` y `GET /api/projects/{id}/checkouts` devolvió dos checkouts (pc-wsl en `feat/1-arreglar-login`, la VPS en `main`); la pantalla Proyecto los lista en "CHECKOUTS" |
| 7 | Rama `feat/1-…` → sugerencia → confirmar | FALLA→ARREGLADO (f7dfa28) | La sesión de la PC ya estaba abierta al crear el proyecto: el checkout se adoptó antes de que la primera sincronización trajera los tickets y nadie volvía a mirar la rama (el ticket 1 quedó con `sessions: []`). Arreglo: al adoptar checkouts y cuando una sincronización cambia los tickets, se buscan las ramas de las sesiones vivas del proyecto. Tras el redeploy se borró y recreó el proyecto desde la UI: la sugerencia "… → 1 Arreglar login" apareció en "SUGERENCIAS DE ASOCIACIÓN", Confirmar → `confirmed:true` y el ticket dice "sesión en pc-wsl" |
| 8 | Abrir sesión desde el ticket en la VPS; segundo intento → 409 | OK | Ticket 2, máquina vps-arm64, Normal, checkout `/home/usuario/quorum-e2e/work/demo` → "Abrir sesión": tmux `quorum-toxagi-…` con el primer prompt "Ticket 2: Escribir docs" (el ticket del script no tiene cuerpo ni comentarios), la sesión quedó asociada y confirmada. Segundo `POST /api/tickets/{id}/launch` → 409 `{"error":"ya hay una sesión trabajando este ticket","session":"aa40d6f6-…"}`; la pantalla del ticket muestra "Ya hay una sesión con este ticket … Ir a la sesión" y el botón lleva a ella. La rama del 409 al pulsar "Abrir sesión" (carrera) la cubre `TicketDetail.test.tsx`; no se forzó en el navegador |
| 9 | `turn_end` → propuesta; aprobar contra exec; rechazar otra | OK | Permitido un `Bash` de lectura y denegado otro desde la app; al terminar el turno salió la propuesta `comment` pendiente "Avance (Quorum, vps-arm64): …", visible y editable en el ticket. Aprobar → `aprobada` y `writes.log` del script recibió `{"op":"comment","externalId":"2","body":"Avance …"}`. Proponer "en review" → Rechazar → `rechazada`; el log siguió con una sola línea |
| 10 | Resumen del proyecto; no se regenera antes de 30 min | OK | En la VPS corre el ccapi del dueño (`127.0.0.1:18787`, clave en `~/.config/ccapi/token`), así que el hub resumió por su API con Haiku. El proceso de ccapi no se tocó: "Proyecto "demo": hay 1 ticket por hacer (arreglar login) y 1 en curso (escribir docs), con dos sesiones inactivas…". Después hubo actividad (sesión nueva, propuestas, conector roto) y `summaryAt` no cambió en las consultas de los minutos siguientes. La regeneración de demo quedó a las 22:02:12 UTC, 31 min después de la primera (21:31:12). ACME se regeneró por última vez a las 01:36 UTC al cambiar sus issues (131/138) |
| 11 | Conector exec roto (exit 1) | OK | Editar el proyecto con `broken.sh` (`exit 1` y "gestor caído (e2e)" en stderr): la tarjeta y la pantalla Proyecto muestran "Error de sincronización: el conector falló: exit status 1: gestor caído (e2e)" y "último intento hace …". Los dos tickets se conservaron |
| 12 | Smoke de UI (escritorio y 390 px) | OK | Proyectos, Proyecto, Ticket y Configuración en escritorio y a 390 px: sin desbordes; en móvil cada pantalla ocupa el ancho con "←" para volver. Las capturas de la primera pasada se perdieron con `/tmp`; al reanudar se repitieron Proyectos, Proyecto, Ticket, Configuración y Proyectos a 390 px en `.superpowers/sdd/2026-11-22-quorum-plan2-proyectos/task-15-shots/` |

Resumen: 10 OK (uno parcial, el 4) y 2 FALLA→ARREGLADO (pasos 1 y 7) con 2 commits. Ninguno PENDIENTE.
Log completo: `.superpowers/sdd/2026-11-22-quorum-plan2-proyectos/task-15-report.md`.

Hallazgos sin cambio de código (entorno):

- El reloj de Windows iba unos 7 min adelantado respecto de WSL y la VPS, que coincidían. Por eso la app en Chrome
  decía "inactiva 8 min" o "sincronizado hace 7 min" para cosas recientes.
- El reloj de WSL saltó unos 6,5 min hacia adelante durante el primer turno y luego volvió. Claude Code mostró
  "Churned for 7m 2s" y la fila de herramienta salió con `-390258 ms`: el `tool_start` llevaba una hora posterior a la
  del `tool_end`. Las horas las pone el mod con el reloj de la máquina.
- En la sesión de la VPS, la denegación llegó como "denied by plugins quorum, cc-plugin-privacy": en esa máquina hay
  otro plugin que también vota en tool.check. No afectó al resultado.
- El repo de prueba de GitHub acordado (`S-kkipie/ccapi`) no tiene issues. Para ver la normalización de GitHub hace
  falta un repo con issues.
