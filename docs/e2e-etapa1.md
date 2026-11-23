# Verificación de punta a punta, etapa 1

Lista manual con el resultado esperado en cada paso y el resultado real de la última corrida.

**Corrida del 2026-11-22: humo local aislado** en la PC (WSL), sin instalar nada: hub en `127.0.0.1:7498` con base temporal,
`QUORUM_CONFIG_DIR` temporal, mod cargado con `claude --plugin-dir ./mod` dentro de tmux, y la API del hub y el WebSocket
`/api/live` manejados con curl y un script de node. Los pasos que necesitan una VPS, o ccapi quedan pendientes.

Leyenda: OK / FALLA / pendiente.

| # | Paso | Resultado esperado | Resultado |
|---|------|--------------------|-----------|
| 1 | Hub en la VPS, `quorum-hub pair`, emparejar el celular | La app muestra "sin máquinas" | VPS y celular: pendiente. Humo local: OK (`pair` + `POST /api/pair` devolvió un token de dispositivo y `GET /api/machines` autenticado respondió) |
| 2 | `quorumd link` en la PC (WSL) y en una VPS | Ambas aparecen en línea | PC: OK (`link` dijo "enlazada como pc-wsl", `online:true`). VPS: pendiente (requiere VPS) |
| 3 | Abrir `claude` a mano en la PC | La sesión aparece en menos de 2 s con estado "en reposo" | OK. Tras aceptar la confianza de carpeta, la sesión llegó por `/api/live` y `/api/sessions` con `state:idle` |
| 4 | Prompt desde el celular | Streaming visible, herramientas como filas, vuelve a "en reposo" | OK parcial. `POST .../prompt` (modo now): llegaron `user`, `turn_start`, `status working`, `assistant_delta`, `assistant`, `turn_end`, `status idle`. Filas de herramientas no probadas (el prompt no usó herramientas) |
| 5 | `/quorum` en la terminal | Muestra máquina y "conectado" | OK. Salida: `máquina: pc-wsl`, `conexión: conectado`, `rol: trabajo` |
| 6 | Activar "fuera" y pedir algo con permiso | Tarjeta en el celular; Permitir y la herramienta corre | pendiente (no se probó para no gastar cuota ni requerir permisos; la sesión corría en modo auto) |
| 7 | `AskUserQuestion` respondida en la terminal | La tarjeta del celular desaparece | pendiente (no probado) |
| 8 | Matar `quorumd` | En 10 s o menos la sesión vuelve a estar conectada | OK. Se mató el PID del daemon; en 1 s había otro `quorumd serve` (lo relanzó el mod), la máquina volvió `online:true` y la sesión siguió en `idle` |
| 9 | Detener el hub 30 s y levantarlo | Todo vuelve sin cerrar sesiones | OK. Hub detenido 30 s y relanzado con la misma base: máquina en línea y sesión `idle` en 10 s; un prompt posterior generó eventos con normalidad |
| 10 | Lanzar una sesión en la VPS desde la app | Aparece; `tmux ls` muestra `quorum-...`; `whoas which claude` coincide | pendiente en VPS. Local: `POST /api/launch` devolvió 202 y `launch_result ok:true`, pero en WSL el daemon usa `wt.exe` (Windows Terminal), no tmux, así que `tmux ls` no aplica. Se vio un `claude` en la carpeta pedida; como el mod no estaba instalado no apareció sesión en el hub (esperado en este humo). Se cerró el proceso a mano |
| 11 | Con ccapi corriendo | Aparece en "Servicios"; el Composer queda deshabilitado | pendiente (requiere ccapi) |
| 12 | Máquina con pastor habilitado | NO APLICA (pastor retirado) | NO APLICA |
| 13 | `/clear` en una sesión | La tarjeta conserva su lugar y el chat sigue | OK. El hub emitió `session_upsert` con `previousId` = id anterior; `/api/sessions` quedó con una sola tarjeta (id nuevo), el historial de eventos se conservó y un prompt posterior generó `user`/`assistant`/`turn_end` en el id nuevo. Nota: `previousId` solo viaja en el upsert en vivo; la lista REST lo devuelve vacío |
| 14 | Cerrar la sesión desde la app | Desaparece y el proceso termina | OK. `POST .../close` devolvió 202; `/api/sessions` quedó vacía y el panel de tmux se cerró |

Resumen: 8 OK (algunos parciales o solo locales), 0 FALLA, 6 pendientes (VPS en 1, 2 y 10; 6, 7, 11, 12).

## Procedimiento del humo local

1. `make build`.
2. Hub: `./bin/quorum-hub serve --addr 127.0.0.1:7498 --db $TMP/hub.db`; `quorum-hub pair --db ...` y `link-code --db ...`.
3. Daemon: `export QUORUM_CONFIG_DIR=$TMP/qcfg`, `./bin` primero en el PATH, `quorumd link http://127.0.0.1:7498 <código>`, `quorumd ensure --json`.
4. Sesión: `tmux new-session -d -s quorum-smoke -c <carpeta> "QUORUM_CONFIG_DIR=$TMP/qcfg PATH=$PWD/bin:\$PATH claude --plugin-dir $PWD/mod"`.
5. Verificar por la API con `Authorization: Bearer <token>` y por WebSocket `/api/live?token=<token>`.
6. Limpiar: detener hub y daemon, cerrar tmux, borrar `$TMP`.

## Hallazgos

- En WSL el lanzamiento desde la app abre Windows Terminal (`wt.exe`) en vez de tmux; el paso 10 de esta lista asume tmux, que solo aplica a VPS Linux.
- Un `quorumd` recién matado lo relanza el mod en cerca de 1 s, antes del objetivo de 10 s.

## E2E funcional 2026-11-22 (PC WSL + VPS arm64)

Corrida real en dos máquinas, sin instalar nada:

- Hub en la VPS (aarch64, claude 2.1.325) en `127.0.0.1:7498`, con base en `~/quorum-e2e/hub.db`. La PC llega por un túnel `ssh -L 17498:127.0.0.1:7498`.
- `quorumd` en la VPS con entorno aislado: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PLUGIN_DIRS=~/quorum-e2e/repo/mod`, un tmux propio con `TMUX_TMPDIR` y `QUORUM_CONFIG_DIR`.
- En la PC (WSL, claude 2.1.330), `QUORUM_CONFIG_DIR` temporal y sesiones `claude --plugin-dir ./mod` en un tmux `-L` propio.
- La app se probó con agent-browser sobre un Chrome headless de Windows con perfil temporal.
- Se usaron 11 prompts cortos en total.

Leyenda: OK / FALLA→ARREGLADO (commit) / NO APLICA.

| # | Resultado | Evidencia |
|---|-----------|-----------|
| 1 | OK | `quorum-hub pair --db …` + `POST /api/pair` por el túnel devolvió el token; `GET /api/machines` respondió `[]`. En la UI, el emparejamiento con código mostró la lista |
| 2 | OK | `quorumd link` en la PC (`http://127.0.0.1:17498`) y en la VPS (`http://127.0.0.1:7498`). Las dos máquinas salieron `online:true` en la API y en la UI |
| 3 | FALLA→ARREGLADO (a73c7a5, abe1969) | PC: `session_upsert` 1,7 s después de aceptar la confianza de carpeta. VPS: con `POST /api/launch`, el tmux aislado mostró `quorum-…` y la línea fue `bash -lc 'claude …'` (sin ruta absoluta), pero la sesión no se registró: en 2.1.325 `$.session.info` no existe y session.start lanzaba TypeError. Arreglado: el upsert llega unos 2,4 s después del launch. Además, el modo "Normal (pide permisos)" abría en modo auto (sin bandera, claude usaba el defaultMode de la cuenta). Ahora pasa `--permission-mode default` y la sesión sale "manual mode on" |
| 4 | OK | Prompt "lista los archivos… con ls": `user`, `turn_start`, `status working`, `tool_start Bash ls`/`tool_end leeme.txt`, `assistant_delta`×2, `assistant`, `turn_end`, `status idle` |
| 5 | OK | `/quorum` en las dos terminales: `máquina: pc-wsl` / `vps-arm64`, `conexión: conectado`, `rol: trabajo` |
| 6 | FALLA→ARREGLADO (43d56b0) | Con "fuera", el permiso iba a la terminal: el hook tool.check tiene 10 s propios (`remainingMs=10000`), así que la espera salía negativa y, sin tope, el engine cortaba el hook a los 10 s (`ask_resolved{by:terminal}` exacto a los 10 s). Arreglado con `quorumd hold` lanzado con el `$` del hook. En la VPS: tarjeta por `/api/live`, Permitir a los 32 s → `prueba.txt` creado; Denegar con motivo → `tool_end ok:false … no hace falta` |
| 7 | OK | Dos AskUserQuestion en un turno. La primera, respondida en la terminal: `ask_resolved{by:terminal}` y la tarjeta se retiró. La segunda, desde el dispositivo (`answers`): el modelo respondió "Color favorito: azul / Fruta favorita: manzana" |
| 8 | OK | VPS con un permiso pendiente: `kill` del PID de quorumd; el mod lo relanzó en 1 s y la sesión volvió (`session_upsert needs_you`) en 1,3 s. La tarjeta pendiente se denegó tras la reconexión (202 y `tool_end ok:false`). PC: daemon relanzado en 1 s |
| 9 | FALLA→ARREGLADO (284cd1b) | Hub detenido 30 s y relanzado con la misma base: máquinas en línea en 2-30 s según el backoff del daemon (tope de 30 s) y sesiones de vuelta, pero `away {}`: el modo fuera se perdía. Arreglado: tabla `away` persistida. Corrida de nuevo: snapshot con `away {dc2b…: true}` y, tras el reinicio, el permiso del paso UI llegó al dispositivo (presencia reenviada al mod) |
| 10 | OK (VPS) / NO APLICA parcial (PC) | VPS: dos lanzamientos por API → `launch_result ok`, `tmux ls` con `quorum-tox2…` y la sesión registrada; después se cerraron por API. PC: `launch_result ok` y apareció `claude --permission-mode default` en la carpeta, bajo `wt.exe → wsl.exe → bash -lic`. No se registró porque la pestaña nueva de Windows Terminal no hereda el entorno aislado (`QUORUM_CONFIG_DIR`, `--plugin-dir`, `quorumd` fuera del PATH de login); con la instalación real sí estaría. Se cerró matando el proceso, porque al no estar registrada no tenía tarjeta |
| 11 | OK (instancia aislada) | El ccapi del dueño no corría en la PC y no se tocó el repo. Se levantó una instancia aislada: la línea de `bin/ccapi start` en un tmux propio, `CCAPI_PORT=18799`, carpeta y env temporales, más `--plugin-dir ./mod`. `/health` respondió ok; la sesión llegó con `role:service` y salió en "SERVICIOS" en la UI con el Composer deshabilitado. Un prompt por API generó solo `info "Sesión de servicio: Quorum no la controla"`; no se aplicó |
| 12 | NO APLICA (pastor retirado) | Detección eliminada |
| 13 | OK | `/clear` dos veces: `session_upsert previousId=<anterior>`, `session_gone` del viejo, away movido al id nuevo, una sola tarjeta. Ruling Q: con `claude --resume d273…` (id viejo de 7c9d…) las dos quedaron vivas y visibles, sin `previousId` mientras el viejo vive. Fuera en d273 desde la UI: la tarjeta de permiso llegó en d273, no en 7c9d, y Denegar se aplicó a la terminal de d273 |
| 14 | OK | `POST …/close` en la PC y en la VPS: `info "Cerrando la sesión desde Quorum"` + `session_gone`; el proceso `claude` terminó y la ventana tmux se cerró |
| UI | FALLA→ARREGLADO (aa97309, 9914e93) | Con agent-browser: emparejar con código, las dos máquinas, sesiones y "Servicios". Desde el Composer, el prompt llegó y la respuesta se vio en streaming, pero salía la alerta "Unexpected end of JSON input" y el texto no se borraba (202 sin cuerpo). Arreglado: tras redeploy, sin alerta y con el Composer limpio. Tarjeta de permiso respondida con clic (Permitir en la VPS, Denegar en la PC). La pantalla de emparejar decía `quorum pair` y ahora dice `quorum-hub pair` |

Resumen: 9 OK (más uno, el 10, OK en la VPS y NO APLICA parcial en la PC), 4 FALLA→ARREGLADO (pasos 3, 6 y 9, y la UI) con 6 commits, 1 NO APLICA (paso 12). Log completo: `.superpowers/sdd/2026-11-22-quorum-plan1-fundacion/e2e-report.md`.

Hallazgos sin cambio de código:

- Al matar el daemon de la VPS, el hub publicó un `session_gone` seguido de un `session_upsert` unos 170 ms después; la tarjeta parpadea, pero conserva estado, away y asks.
- Si se edita el mod con la sesión abierta (`--plugin-dir` con recarga en caliente), el mod recargado arranca con away/watching en falso y el hub no reenvía la presencia hasta que cambie. Solo pasa en desarrollo.
- Tras un reinicio del hub, el daemon tarda hasta 30 s en volver por el tope de su backoff exponencial.
