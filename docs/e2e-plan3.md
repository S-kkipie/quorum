# Verificación de punta a punta, Plan 3 (herdr)

**Corrida del 2026-11-23** contra el hub real ya desplegado, con la app real en el navegador.

Montaje: app en un viewport de celular (390x844) en Chrome (Windows) emparejado como dispositivo de prueba (revocado al
final); máquinas: un servidor Linux arm64 (herdr 0.9.5 headless por `scripts/install-herdr.sh`, servicio de usuario) y
la PC con WSL (herdr propio del dueño, sin tocarlo salvo las pestañas que abrió la prueba).

Ningún proyecto tenía checkout en el servidor Linux. El caso 1 se corrió con "Lanzar" (diálogo de lanzamiento) sobre un
repo git desechable creado para la prueba en el servidor. "Retomar" y "Terminal" solo existen en la pantalla de un
proyecto con checkout en la máquina elegida, así que los casos 2, 3 y 4 se corrieron en la PC con WSL sobre un proyecto
con checkout allí (pestañas propias de la prueba dentro del workspace del dueño).

Leyenda: OK / FALLA→ARREGLADO (commit) / FALLA (sin arreglar) / PENDIENTE / NO CORRIDO.

| # | Caso | Resultado | Evidencia |
|---|------|-----------|-----------|
| 1 | Un proyecto → "Nueva sesión" (servidor Linux, Sin permisos): la app pasa a "Arrancando…" y abre el chat sola; en `herdr pane list` hay una pestaña nueva en el workspace del proyecto con Claude y `--dangerously-skip-permissions`; un prompt desde el celular responde | OK (por "Lanzar", sin proyecto) | Lanzar → máquina del servidor, carpeta del repo desechable, Sin permisos: la app abrió el chat sola en ~5 s. En herdr apareció un workspace nuevo con el nombre de la carpeta, una pestaña y un panel con `agent: claude`; el proceso es `claude --dangerously-skip-permissions` con cwd en la carpeta. "Responde solo: OK" → "OK · fin del turno · 4 tokens". La pantalla "Arrancando Claude en <máquina>…" se vio en el caso 6 (aquí el cambio fue más rápido que la captura) |
| 2 | "Retomar" una conversación cerrada: abre en una pestaña nueva y la app navega a ella | OK (en la PC) | Sesión del caso 5 cerrada con "Cerrar" (confirmación): sale como "cerrada" y en CONVERSACIONES del proyecto. Un toque → pestaña nueva en el mismo workspace con `claude --dangerously-skip-permissions --resume <id>`; la app navegó sola a la sesión (mismo id), con el historial y el compositor activo |
| 3 | "Terminal": se ve la pantalla; `git status` + ⏎ muestra la salida; Ctrl-C funciona; cerrar la vista y volver reusa el mismo panel | FALLA→ARREGLADO (re-prueba OK) | **Re-prueba tras el arreglo:** terminal abierta, `echo` + ⏎, volver y tocar "Terminal" otra vez: mismo panel y la pantalla en vivo apareció en ~1 s, sin "Conectando…". **Primera corrida:** | Pantalla visible, `git status` + ⏎ mostró la salida, `sleep 30` + Ctrl-C lo cortó (`^C`, prompt de vuelta, sin proceso). Volver y tocar "Terminal" otra vez reusa el mismo panel (ninguno nuevo en herdr), **pero la vista queda en "Conectando con la terminal…"** hasta que la pantalla del panel cambia (al mandar un `echo` apareció). Causa probable: si el vigilante del daemon sigue vivo (lease de 15 s), `watch` solo renueva el lease y el bucle solo emite foto cuando el texto cambia; la app descarta a propósito la foto guardada de la visita anterior y espera una nueva que no llega |
| 4 | Cerrar el panel de terminal desde herdr: la app muestra "La terminal se cerró" | FALLA→ARREGLADO (re-prueba OK) | **Re-prueba tras el arreglo (en la PC):** `herdr pane close` del panel de la prueba con la app mirando: "La terminal se cerró" en ~1 s. **Primera corrida:** | Corrido en la PC (no había terminal posible en el servidor). `herdr pane close <panel>` con la app mirando: la app siguió mostrando la última foto, sin aviso. Causa: herdr 0.9.5 responde `{"code":"pane_not_found"}` y el daemon solo reconoce `not_found` (`isNotFound`), así que nunca emite el `term_frame` de cierre. Volver a tocar "Terminal" sí abrió un panel nuevo (la limpieza de `herdr-terminals.json` funciona). "Cerrar terminal" desde el menú ⋯ de la app sí cierra la pestaña |
| 5 | PC con WSL (herdr propio): "Nueva sesión" en un proyecto aparece como pestaña en el workspace existente de ese proyecto, sin renombrarlo | OK | Antes/después de `herdr workspace list`: mismos workspaces y nombres; el del proyecto pasó de 1 a 2 pestañas (la nueva, "claude"), sin cambiar el foco. `claude --dangerously-skip-permissions` en la carpeta del proyecto. "Responde solo: OK" → "OK" |
| 6 | Doble toque rápido en "Nueva sesión": una sola sesión | OK | Doble clic en "Nueva sesión": un solo `POST /api/launch`, "Arrancando Claude en <máquina>…", una sola pestaña nueva y un solo proceso claude |
| — | Lanzar desde un ticket | NO CORRIDO | El único proyecto con tickets no tiene checkout en ninguna máquina (solo "Otra carpeta…"), y sus tickets son reales: lanzar mandaría el ticket como primer prompt a un Claude sin permisos |

Resumen: primera corrida 4 OK y 2 FALLA (casos 3 y 4); tras el arreglo (quorumd reiniciado en las dos máquinas) la re-prueba de los casos 3 y 4 dio OK. Queda NO CORRIDO el lanzamiento desde un ticket.

Hallazgos sin falla de caso:

- Primera corrida: cerrar una sesión desde la app terminaba Claude pero dejaba la pestaña de herdr abierta con el shell.
  **Re-prueba tras el arreglo:** "Nueva sesión" en la PC → chat → "Cerrar" (confirmación): la pestaña de la sesión
  desapareció de `herdr tab list` en ~1 s; los demás workspaces y pestañas del dueño quedaron iguales (antes/después).
- `herdr-terminals.json` conserva el panel cerrado desde herdr hasta la próxima apertura de "Terminal", que lo limpia.
- Al lanzar sin proyecto en una máquina con herdr sin workspaces, se crea un workspace nuevo con el nombre de la carpeta.

Limpieza: se cerraron con `herdr tab close` solo las pestañas que creó la prueba (en la PC las listas de workspaces y
pestañas quedaron iguales a las de antes; en el servidor herdr quedó vacío como al principio), se borró el repo
desechable y se revocó el dispositivo de prueba. En la re-prueba igual: dispositivo nuevo revocado al final y listas de
workspaces y pestañas de la PC idénticas antes y después.
