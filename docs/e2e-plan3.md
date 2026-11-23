# Verificación de punta a punta, Plan 3 (herdr)

**Corrida:** pendiente (la llena quien despliega).

Montaje: pendiente. App en un viewport de celular (390x844) contra el hub real; máquinas: un servidor Linux arm64 (herdr headless por
`scripts/install-herdr.sh`) y la PC (herdr propio, sin tocarlo).

Leyenda: OK / FALLA→ARREGLADO (commit) / PENDIENTE.

| # | Caso | Resultado | Evidencia |
|---|------|-----------|-----------|
| 1 | Un proyecto → "Nueva sesión" (servidor Linux, Sin permisos): la app pasa a "Arrancando…" y abre el chat sola; en `herdr pane list` hay una pestaña nueva en el workspace del proyecto con Claude y `--dangerously-skip-permissions`; un prompt desde el celular responde | PENDIENTE | |
| 2 | "Retomar" una conversación cerrada: abre en una pestaña nueva y la app navega a ella | PENDIENTE | |
| 3 | "Terminal": se ve la pantalla; `git status` + ⏎ muestra la salida; Ctrl-C funciona; cerrar la vista y volver reusa el mismo panel | PENDIENTE | |
| 4 | Cerrar el panel de terminal desde herdr en el servidor Linux: la app muestra "La terminal se cerró" | PENDIENTE | |
| 5 | PC con WSL (herdr propio): "Nueva sesión" en un proyecto aparece como pestaña en el workspace existente de ese proyecto, sin renombrarlo | PENDIENTE | |
| 6 | Doble toque rápido en "Nueva sesión": una sola sesión | PENDIENTE | |

Limpieza: cerrar con `herdr tab close` solo las pestañas que creó la prueba.
