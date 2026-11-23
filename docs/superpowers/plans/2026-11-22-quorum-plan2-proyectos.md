# Quorum — Plan 2: control sin modos, recap y proyectos/tickets/estado

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar la Etapa 1 del spec: permisos y preguntas contestables desde todos lados a la vez (sin modos), sesiones nombradas por su recap, y el centro de proyectos — trabajos → proyectos → tickets y sesiones, con conectores genéricos de ticketeras, estado de cada ticket sin preguntar y resumen automático de cada proyecto.

**Architecture:** Sobre lo existente (hub Go + SQLite, `quorumd`, mod TS, app React). El mod gana el diálogo de permisos propio y el recap (Haiku vía `$.model.complete`). El hub gana el modelo de proyectos, un motor de conectores (GitHub vía `gh`, Paperclip vía REST, y uno ejecutable genérico con JSON por stdin/stdout), sincronización periódica, propuestas de escritura que el dueño aprueba, y un resumidor (ccapi si está, si no `claude -p --model haiku`). La app gana el tablero de proyectos.

**Tech Stack:** igual que el Plan 1 (Go 1.27, `modernc.org/sqlite`, `coder/websocket`, tygo; TS mod con `claude plugin test`; React 19 + Vite + Tailwind v4 + vitest).

**Spec:** `docs/superpowers/specs/2026-11-22-quorum-design.md` (§8–10, §14b y §18).

## Global Constraints

- Todo lo del Plan 1 sigue vigente (loopback por defecto, nunca `funnel`, tokens SHA-256, sin cgo, textos en español, nada compilado en git, `claude` por shell de login).
- **Sin modos:** no existe `away`, `watch` ni presencia. Ningún comportamiento depende de dónde esté el dueño.
- **Permisos:** carrera entre el diálogo propio de la terminal (`$.ui.ask`, opciones exactas `Permitir` / `Denegar`) y las tarjetas de los dispositivos; gana el primero. Espera máxima `HOLD_MAX_MS` (19 min); vencida → `deny` con motivo `"Sin respuesta en 19 min (Quorum)"`. `AskUserQuestion` y `ExitPlanMode` no pasan por este diálogo (AskUserQuestion ya corre su propia carrera).
- **Recap:** ≤ 60 caracteres, español, sin comillas ni punto final; como mucho una generación cada 5 min por sesión y solo si hubo turnos nuevos; modelo `haiku`; timeout 8 s; un fallo deja el recap anterior.
- **Quorum nunca escribe solo en una ticketera:** toda escritura (comentar, cambiar estado) es una propuesta que el dueño aprueba en la app.
- **Credenciales:** el hub no guarda secretos que maneje whoas. Un trabajo puede tener `whoasProfile`; los conectores que usan CLIs corren con `WHOAS_PROFILE=<perfil>` en su entorno. Los tokens propios de conectores (p. ej. Paperclip) se guardan en la base del hub y **nunca** se devuelven por la API (solo `"tieneToken": true`).
- Estados normalizados de ticket, exactos: `por_hacer | en_curso | en_review | hecho | bloqueado`.
- Sincronización de ticketeras: cada 5 min por proyecto (configurable 1–60) + botón "Actualizar". Único polling permitido.
- Resumen de proyecto: Haiku, como mucho cada 30 min por proyecto y solo si hubo cambios (tickets, sesiones, turnos); "Sin actividad desde <fecha>" no gasta modelo. 1–2 líneas, ≤ 200 caracteres.
- Un ticket, una sesión activa: abrir sesión desde un ticket con sesión viva ofrece ir a esa.

## Review Focus

1. **El dueño contesta el permiso en la terminal mientras el celular muestra la tarjeta** → la tarjeta desaparece (`ask_resolved{by:'terminal'}`); si contesta el celular primero, la herramienta corre/se deniega y una respuesta tardía en la terminal se ignora sin romper nada. Tests en Task 2.
2. **Conector caído o con credenciales malas** → el proyecto muestra "Error de sincronización: <mensaje>" y conserva los últimos tickets; nunca borra tickets por un fallo. Test en Task 6.
3. **Conector ejecutable que cuelga o escupe basura** → timeout 30 s, salida > 8 MiB rechazada, JSON inválido = error visible; el hub no se bloquea. Test en Task 6.
4. **Recap con Haiku fallando o lento** → la sesión sigue sin recap o con el anterior; nunca bloquea un turno. Test en Task 3.
5. **Un mismo repo clonado en dos máquinas** → dos checkouts del mismo proyecto (por URL del remoto normalizada: `git@github.com:o/r.git` ≡ `https://github.com/o/r`), sesiones de ambas bajo el mismo proyecto. Test en Task 5.

---

### Task 1: Quitar los modos (away/watch/presencia) de punta a punta

**Files:**
- Modify: `app/src/App.tsx`, `app/src/screens/Session.tsx`, `app/src/lib/live.ts`, `app/src/lib/store.ts`, `app/src/lib/api.ts` (+ tests)
- Modify: `internal/hub/appapi.go`, `internal/hub/live.go`, `internal/hub/machines.go`, `internal/hub/store/store.go`, `internal/hub/store/migrations.go` (+ tests)
- Modify: `internal/daemon/registry.go` (+ tests), `internal/proto/proto.go` (+ `make proto`)
- Modify: `mod/src/control.ts`, `mod/hooks/register.ts` (+ tests)

**Interfaces:**
- Produces: sin `Command{type:'presence'}`, sin `Away/Watching` en `Command`, sin envelopes `away`/`watch`, sin `POST /api/sessions/{id}/presence`, sin tabla `away` en uso (la migración la deja; el código no la lee ni escribe), sin replay de presencia en el daemon, sin checkbox "Fuera" ni mensaje `watch` en la app. `Asks.permission` y la ruta 'watching' del mod se eliminan (Task 2 las reemplaza).

- [ ] **Step 1: Tests que fijan la ausencia:** hub — `POST /api/sessions/x/presence` → 404; un `{"type":"watch"}` por `/api/live` se ignora sin error; daemon — `Subscribe` no reenvía nada al conectar; app — no existe el control "Fuera" (`queryByLabelText('Fuera')` es null); proto — `Command` no tiene `away`.
- [ ] **Step 2: Correr** la suite → FAIL donde aún existen.
- [ ] **Step 3: Eliminar** el código y los tests que lo cubrían (presence tracker, awayMap, RenameAway/AwaySessions/PruneAway, `publishAway`, replay de presencia, `turnStart` de "último prompt de terminal", estado `away` del reducer y de App).
- [ ] **Step 4: Correr** `go test -race ./... && go vet ./... && claude plugin test mod && make typecheck && (cd app && npx vitest run && npm run build)` → PASS.
- [ ] **Step 5: Commit** `refactor: sin modos — fuera la presencia, el modo fuera y el watch`

---

### Task 2: Permisos contestables desde todos lados a la vez

**Files:**
- Create: `mod/src/permission.ts`, `mod/test/permission.test.ts`
- Modify: `mod/hooks/register.ts`, `mod/src/control.ts` (Asks)

**Interfaces:**
- Consumes: `Asks` (`ask`, `resolve`, `withdraw`, `settle`), `hold.ts` (`keepAlive`), `Link.emit`
- Produces: `function permissionRace(deps: { termAsk: (q: string) => Promise<string>; asks: Asks; keepAlive: (until: Promise<unknown>) => Promise<void>; signal?: AbortSignal; now: () => number }, a: { tool: string; summary: string; detail: string }): Promise<{ decision: 'allow' | 'deny'; reason: string }>`

- [ ] **Step 0 (spike, sin commit de producto):** confirmar en una sesión real (`claude --plugin-dir ./mod` en tmux, modo de permisos default, modelo haiku, un solo prompt que pida escribir un archivo) que un mod de prueba puede llamar `$.ui.ask("…", ["Permitir","Denegar"])` **dentro de `tool.check`** y que su espera no consume el presupuesto de 10 s. Anotar el resultado en el reporte. Si no funciona: BLOCKED con la evidencia (el controlador decide).
- [ ] **Step 1: Tests (`permission.test.ts`, con fakes):**
  - el dispositivo resuelve `allow` primero → `{decision:'allow', reason:'Permitido desde Quorum'}`, no se emite `ask_resolved` desde el mod (Ruling L del Plan 1), el `termAsk` pendiente sigue colgado y su respuesta tardía no cambia nada.
  - la terminal responde `Permitir` primero → `{decision:'allow', reason:'Permitido en la terminal'}` y se emite `ask_resolved{askId, by:'terminal'}`.
  - la terminal responde `Denegar` → `deny`, reason `'Denegado en la terminal'`.
  - `termAsk` rechaza (el dueño cerró el diálogo con Esc) → sigue esperando al dispositivo (no deniega solo por cerrar).
  - nadie responde en `HOLD_MAX_MS` → `{decision:'deny', reason:'Sin respuesta en 19 min (Quorum)'}` y `ask_resolved{by:'terminal'}`.
  - `signal` abortado (turno interrumpido) → retira el ask (`ask_resolved{by:'terminal'}`) y devuelve `deny` con reason `'Turno interrumpido'`.
- [ ] **Step 2: Correr** `claude plugin test mod` → FAIL.
- [ ] **Step 3: Implementar** `permissionRace` y cablearlo en `tool.check` (hilo principal; cuando `next(e)` devuelve `ask` y la herramienta no es `AskUserQuestion`/`ExitPlanMode`; rol `service` → devolver el veredicto sin tocar). El diálogo de la terminal: pregunta `"<tool>: <summary>"` (≤ 120 caracteres), opciones `["Permitir","Denegar"]`, `header: "Permiso"`.
- [ ] **Step 4: Correr** la suite del mod + `make typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(mod): permisos en la terminal y en todos los dispositivos a la vez`

---

### Task 3: Recap como nombre de sesión

**Files:**
- Create: `mod/src/recap.ts`, `mod/test/recap.test.ts`
- Modify: `internal/proto/proto.go` (`SessionInfo.Recap string \`json:"recap"\``; `make proto`), `internal/hub/store/{store.go,migrations.go}` (columna `recap`), `mod/hooks/register.ts`, `mod/src/link.ts` (usa `update({recap})`), `app/src/lib/title.ts` (+ test)

**Interfaces:**
- Produces: `class Recap { constructor(deps: { complete: (prompt: string) => Promise<string>; now: () => number; update: (recap: string) => void }); onFirstPrompt(text: string): void; onTurnEnd(lastPrompt: string, answer: string): void }`; `function cleanRecap(raw: string): string` (quita comillas, punto final, saltos de línea; corta a 60 en límite de palabra).
- `sessionTitle(s)` en la app: `recap` → `name` → basename(root|cwd).

- [ ] **Step 1: Tests:** `cleanRecap('"Arreglando el login con OAuth."\n')` → `'Arreglando el login con OAuth'`; corta a ≤ 60; `onFirstPrompt` llama `complete` una vez y `update` con el resultado limpio; dos `onTurnEnd` en < 5 min → una sola generación; `onTurnEnd` sin turno nuevo desde la última generación → ninguna; `complete` rechaza o tarda > 8 s → no `update` y no lanza; app: `sessionTitle({recap:'X', root:'/a/b'})` → `'X'`.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.** Prompt fijo (español): "Resume en una frase de máximo 8 palabras, en español, en qué está trabajando esta sesión de programación. Solo la frase." + último prompt del usuario (≤ 2000 caracteres) + respuesta (≤ 2000). `complete` = `$.model.complete({model:'haiku', prompt, maxTokens:40, timeoutMs:8000})` (verificar la firma en los tipos del build; si no existe en 2.1.325, el recap queda vacío sin error). Solo en rol `work`.
- [ ] **Step 4: Correr** suites de mod, Go y app → PASS.
- [ ] **Step 5: Commit** `feat: recap de la sesión como su nombre`

---

### Task 4: Modelo de proyectos en el hub

**Files:**
- Create: `internal/hub/store/projects.go`, `internal/hub/store/projects_test.go`
- Modify: `internal/hub/store/migrations.go`, `internal/proto/proto.go` (+ `make proto`)

**Interfaces:**
- Produces (proto, camelCase JSON):
  - `Workspace{ID, Name, Color, WhoasProfile string}`
  - `Project{ID, WorkspaceID, Name, RepoURL string; Connector ConnectorConfig; Summary string; SummaryAt int64; Progress Progress; SyncError string; SyncedAt int64}` — `Progress{Done, Total int}`
  - `ConnectorConfig{Kind string /* github|paperclip|exec|none */; Settings map[string]string; HasToken bool; IntervalMin int}`
  - `Checkout{ID, ProjectID, Machine, Root, RepoURL, Branch string; UpdatedAt int64}`
  - `Ticket{ID, ProjectID, ExternalID, Title, Status /* normalizado */, RawStatus, Assignee, URL, Body string; Comments []TicketComment; UpdatedAt int64}` — `TicketComment{Author, Body string; At int64}`
  - `SessionTicket{SessionID, TicketID string; Confirmed bool}`
  - `Proposal{ID, TicketID, Kind /* comment|status */, Body, Status string /* pendiente|aprobada|rechazada|fallida */; Error string; CreatedAt int64}`
- Store: CRUD `CreateWorkspace/ListWorkspaces/UpdateWorkspace/DeleteWorkspace`, `CreateProject/ListProjects/GetProject/UpdateProject/DeleteProject` (token aparte: `SetConnectorToken(projectID, token)`, `ConnectorToken(projectID) (string, error)` — nunca en `GetProject`), `UpsertCheckout`, `ListCheckouts(projectID)`, `CheckoutForRoot(machine, root)`, `ReplaceTickets(projectID string, ts []Ticket) error` (upsert por ExternalID; **no** borra los que faltan: los marca `hecho` solo si el conector lo dice), `ListTickets(projectID)`, `LinkSessionTicket/UnlinkSessionTicket/SessionTickets`, `CreateProposal/ListProposals/SetProposalStatus`, `SetProjectSummary`, `SetSyncResult(projectID, err string, at int64)`.
- `func NormalizeRepoURL(u string) string` → `github.com/o/r` (minúsculas, sin `.git`, sin esquema/usuario, `git@host:o/r` ≡ `https://host/o/r`).

- [ ] **Step 1: Tests:** `NormalizeRepoURL` (ssh, https, con `.git`, mayúsculas); `ReplaceTickets` dos veces con un ticket ausente la segunda → sigue existiendo; `GetProject` no expone el token y `HasToken` es true tras `SetConnectorToken`; borrar workspace con proyectos → error `ErrNotEmpty`; migración sobre una base del Plan 1 abre bien.
- [ ] **Step 2: Correr** `go test ./internal/hub/store/` → FAIL.
- [ ] **Step 3: Implementar** tablas `workspaces, projects, project_tokens, checkouts, tickets, session_tickets, proposals` con índices por `project_id` y `(project_id, external_id)` único.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(hub): modelo de trabajos, proyectos, checkouts, tickets y propuestas`

---

### Task 5: Checkouts y proyectos sugeridos

**Files:**
- Modify: `internal/proto/proto.go` (`SessionInfo.RepoURL, Branch string`; `make proto`), `mod/hooks/register.ts` + `mod/src/link.ts` (enviar repo y rama: `$.session.repo()` si existe en el build, si no `git -C <root> remote get-url origin` y `git -C <root> branch --show-current` vía `$.process.run` con timeout 3 s), `internal/hub/machines.go`, `internal/hub/projects.go` (nuevo), `internal/hub/projects_test.go`

**Interfaces:**
- Produces: en cada `session_upsert` con `RepoURL`, el hub hace `UpsertCheckout(machine, root, repoURL, branch)` y, si `NormalizeRepoURL(repoURL)` coincide con un `Project.RepoURL`, asocia el checkout a ese proyecto. `GET /api/projects/suggestions` → `[{repoURL, roots:[{machine, root}], sessions:int}]` para remotos sin proyecto.
- La sesión expone su proyecto: `SessionInfo` en REST/snapshot gana `projectId` (calculado por el hub, no por el mod).

- [ ] **Step 1: Tests:** dos sesiones en dos máquinas con remotos `git@github.com:o/r.git` y `https://github.com/O/r` → un proyecto con dos checkouts (Review Focus 5); remoto sin proyecto → aparece en sugerencias; aceptar la sugerencia (`POST /api/projects {workspaceId, name, repoURL}`) asocia los checkouts existentes; mod: sin `$.session.repo` cae a `git` y si falla manda vacío sin error.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** suites → PASS.
- [ ] **Step 5: Commit** `feat: checkouts por máquina y proyectos sugeridos por remoto git`

---

### Task 6: Motor de conectores + conector ejecutable + sincronización

**Files:**
- Create: `internal/hub/connectors/connector.go`, `exec.go`, `sync.go`, `connectors_test.go`, `testdata/fake-connector.sh`
- Modify: `internal/hub/server.go` (arranca el sincronizador)

**Interfaces:**
- Produces:
  - `type Connector interface { List(ctx context.Context, since int64) ([]proto.Ticket, error); Comment(ctx context.Context, externalID, body string) error; SetStatus(ctx context.Context, externalID, status string) error }`
  - `func New(cfg proto.ConnectorConfig, token string, env []string) (Connector, error)` — `kind` → implementación; `none` → error `ErrNoConnector`.
  - **Protocolo del conector ejecutable** (documentado en `docs/conectores.md`): se ejecuta `Settings["command"]` (argv separado por espacios, sin shell) con stdin = una línea JSON `{"op":"list"|"comment"|"set_status","since":<ms>,"externalId":"…","body":"…","status":"<normalizado>","settings":{…},"token":"…"}`; stdout = JSON `{"tickets":[…]}` (para list, con los campos de `proto.Ticket` y `rawStatus`) o `{"ok":true}`; código ≠ 0 o `{"error":"…"}` = error. Timeout 30 s, stdout ≤ 8 MiB, stderr se adjunta al error recortado a 500 caracteres.
  - `func StatusMap(raw string, custom map[string]string) string` → normalizado (mapa por defecto: open/todo/backlog→por_hacer; in progress/doing→en_curso; review/in review→en_review; closed/done/resolved→hecho; blocked→bloqueado; custom primero; desconocido → por_hacer).
  - `type Syncer struct` con `Start(ctx)`, `SyncNow(projectID) error`; por proyecto, cada `IntervalMin` (default 5): `List` → `ReplaceTickets` → `SetSyncResult("", now)`; error → `SetSyncResult(msg, now)` sin tocar tickets (Review Focus 2); publica `project_upsert` y `tickets` por `/api/live`.
  - Env del conector: `WHOAS_PROFILE=<workspace.whoasProfile>` si hay, más el entorno del hub.
- [ ] **Step 1: Tests** con `testdata/fake-connector.sh` (modos por settings: ok, sleep 60, basura, exit 1, salida enorme): list ok → tickets guardados y normalizados; sleep → error de timeout en ≤ 31 s (usar timeout inyectable corto en el test); basura → error "respuesta inválida del conector"; exit 1 → error con stderr; enorme → error "respuesta demasiado grande"; error tras un sync bueno → tickets se conservan y `SyncError` se fija; `StatusMap` casos por defecto y custom.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar** + `POST /api/projects/{id}/sync` (202) + `docs/conectores.md` con el protocolo y un ejemplo en bash de 30 líneas.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(hub): motor de conectores, conector ejecutable y sincronización`

---

### Task 7: Conector GitHub

**Files:**
- Create: `internal/hub/connectors/github.go`, `github_test.go`

**Interfaces:**
- Produces: `kind: "github"`, `Settings{"repo":"owner/name", "labelsAsStatus":"true|false"}`. `List` = `gh api --paginate "repos/<repo>/issues?state=all&since=<ISO>&per_page=100"` (excluye PRs: campo `pull_request`), `RawStatus` = `state` + label de estado si `labelsAsStatus` (labels `en curso|in progress|review|blocked`); comentarios: los últimos 5 vía `gh api repos/<repo>/issues/<n>/comments?per_page=5` solo para tickets abiertos actualizados desde el último sync. `Comment` = `gh api -X POST …/comments -f body=…`. `SetStatus(hecho)` = cerrar; `por_hacer` = reabrir; otros estados = label. `gh` se ejecuta vía `exec` (sin shell) con el env del conector (whoas). Runner inyectable para tests.
- [ ] **Step 1: Tests** con runner fake que devuelve JSON grabado (escrito a mano): PRs excluidos; `since` en ISO; mapeo closed→hecho, open+label "in progress"→en_curso; `Comment` arma el argv exacto `["api","-X","POST","repos/o/r/issues/7/comments","-f","body=hola"]`; error de `gh` (exit 1, "HTTP 401") → error legible "GitHub: credenciales inválidas (revisa el perfil de whoas)".
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat(hub): conector de GitHub Issues vía gh`

---

### Task 8: Conector Paperclip

**Files:**
- Create: `internal/hub/connectors/paperclip.go`, `paperclip_test.go`

**Interfaces:**
- Produces: `kind: "paperclip"`, `Settings{"baseURL":"…", "companyId":"…", "projectId":"(opcional)"}`, token del conector (Bearer). `List` = `GET <baseURL>/api/companies/<companyId>/issues` (filtrar por `projectId` si está; paginar si la API pagina — leer `GET <baseURL>/api/openapi.json` en el test de integración manual para confirmar campos; los tests usan `httptest` con respuestas escritas a mano). Mapeo de estados de Paperclip (`todo, in_progress, in_review, done, blocked, cancelled`→hecho). `Comment` = `POST /api/issues/<id>/comments {body}`; `SetStatus` = `PATCH /api/issues/<id> {status}`.
- [ ] **Step 1: Tests** con `httptest`: auth Bearer enviada; mapeo de estados; 401 → "Paperclip: token inválido"; timeout 15 s inyectable.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat(hub): conector de Paperclip`

---

### Task 9: Sesión ↔ ticket (sugerencias, comando y confirmación)

**Files:**
- Create: `internal/hub/links.go`, `internal/hub/links_test.go`, `mod/test/ticketcmd.test.ts`
- Modify: `mod/hooks/register.ts` (`/quorum ticket <id>` y `/quorum ticket -` para desasociar), `internal/proto/proto.go` (nuevo `KindTicket` con data `{ticket:"<externalId>"}`, vacío = desasociar; `make proto`)

**Interfaces:**
- Produces:
  - Sugerencia: al ver `Branch` de una sesión con proyecto, el hub busca `(?i)(?:^|[/_-])(?:gh-|#)?(\d+)(?:[/_-]|$)` y, si hay un ticket con ese `ExternalID` en el proyecto, crea `SessionTicket{Confirmed:false}` (sugerido). También en eventos `turn_end` cuyo texto mencione `#<n>` (solo sugerencia).
  - `POST /api/sessions/{id}/ticket {ticketId, confirmed:true}` confirma/asocia; `DELETE /api/sessions/{id}/ticket` desasocia.
  - Evento `ticket` del mod (por `/quorum ticket 41`) → el hub asocia confirmado si existe el ticket en el proyecto de la sesión; si no, responde con un evento `info` "No encontré el ticket 41 en este proyecto".
  - Nunca se asocia en silencio: lo sugerido se muestra como sugerencia hasta que el dueño confirma (o lo declara Claude con el comando).
- [ ] **Step 1: Tests:** ramas `feat/41-login`, `GH-41`, `fix_41`, `release-2026` (no sugiere 2026 si no existe ticket 2026), sin proyecto → nada; confirmar/desasociar; comando del mod emite el evento correcto.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat: asociar sesiones y tickets (sugerencia, comando y confirmación)`

---

### Task 10: Abrir una sesión desde un ticket

**Files:**
- Modify: `internal/proto/proto.go` (`LaunchRequest.Prompt string`, `TicketID string`; `make proto`), `internal/daemon/launch/launch.go` (+ tests), `internal/hub/appapi.go` (o `projects.go`) (+ tests)

**Interfaces:**
- Produces: `POST /api/tickets/{id}/launch {machine, checkoutRoot, permissionMode}` → si el ticket tiene una sesión no cerrada asociada → 409 `{"error":"ya hay una sesión trabajando este ticket","session":"<id>"}`; si no, arma el prompt `"Ticket <externalId>: <title>\n\n<body (≤ 4000)>\n\nÚltimos comentarios:\n<…>\n\nURL: <url>"` y lanza con `Prompt`. El launcher pasa el prompt como argumento posicional de `claude` (citado con `shellQuote`; en Windows/osascript con el escapado ya existente) y la sesión queda asociada (confirmada) al ticket cuando se registra en ese `checkoutRoot` en los 2 min siguientes (match por máquina+root+reqId pendiente).
- [ ] **Step 1: Tests:** argv con prompt que contiene comillas, `$`, saltos de línea (los tres entornos); 409 con sesión viva; asociación automática al registrarse.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat: abrir una sesión desde un ticket con su contexto`

---

### Task 11: Propuestas de escritura en la ticketera

**Files:**
- Create: `internal/hub/proposals.go`, `internal/hub/proposals_test.go`

**Interfaces:**
- Produces: al `turn_end` de una sesión asociada (confirmada) cuyo `answer` no está vacío, el hub crea como mucho **una** propuesta `comment` pendiente por ticket (si ya hay una pendiente, la reemplaza con el texto nuevo) con cuerpo `"Avance (Quorum, <máquina>):\n<answer recortado a 1500>"`. `POST /api/proposals/{id}/approve {body?}` (cuerpo editable) → conector `Comment`/`SetStatus` → `aprobada` o `fallida` con error; `POST /api/proposals/{id}/reject`. `POST /api/tickets/{id}/proposals {kind:'status', status}` para proponer un cambio de estado manual. Todo publica `proposal_upsert` en vivo.
- [ ] **Step 1: Tests:** dos `turn_end` → una sola pendiente con el texto último; aprobar llama al conector fake con el cuerpo editado; fallo del conector → `fallida` con el mensaje; nada se escribe sin aprobar.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat(hub): propuestas de escritura que el dueño aprueba`

---

### Task 12: Resúmenes y avance de cada proyecto

**Files:**
- Create: `internal/hub/summary/summary.go`, `summary_test.go`
- Modify: `cmd/quorum-hub/main.go` (flags `--ccapi-url`, `--ccapi-token-file`; por defecto `http://127.0.0.1:18787` y `~/.ccapi/token` si existe), `internal/hub/server.go`

**Interfaces:**
- Produces: `type Model interface { Complete(ctx, prompt string) (string, error) }` con dos implementaciones: `ccapi` (`POST <url>/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, model `haiku` (alias que ccapi acepta); max_tokens 120; timeout 20 s) y `claudeCLI` (`claude -p --model haiku --output-format text "<prompt>"`, timeout 60 s, vía shell de login para whoas). Elección: ccapi si responde `GET /v1/models` con el token; si no, CLI.
  - `type Summarizer struct` con `Touch(projectID)` (marca cambio) y un bucle: por proyecto tocado, si pasaron ≥ 30 min desde `SummaryAt` → genera; sin actividad (ni tickets ni turnos) en 7 días → `Summary = "Sin actividad desde <fecha>"` sin modelo.
  - Prompt (español): datos del proyecto (tickets por estado con títulos, sesiones vivas con recap, últimos turn_end recortados) → "En 1 o 2 frases (máx. 200 caracteres): en qué va el proyecto y qué lo frena." Resultado recortado a 200.
  - `Progress{Done, Total}` = tickets `hecho` / total actualizados en los últimos 30 días (o todos si el conector no da fechas).
  - `Touch` se llama en: sync con cambios, `turn_end` de sesiones del proyecto, cambios de asociación.
- [ ] **Step 1: Tests:** con `Model` fake: dos `Touch` en 10 min → una generación; 31 min → otra; inactividad 7 días → texto fijo sin llamar al modelo; error del modelo → `Summary` anterior se mantiene; selección ccapi vs CLI con `httptest`.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat(hub): resumen y avance de cada proyecto (Haiku vía ccapi o claude -p)`

---

### Task 13: API de proyectos para la app

**Files:**
- Create: `internal/hub/projectapi.go`, `internal/hub/projectapi_test.go`

**Interfaces:**
- Produces (requireDevice, errores en español):
  - `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/{id}`
  - `GET/POST /api/projects` (`?workspace=`), `GET/PATCH/DELETE /api/projects/{id}`, `PUT /api/projects/{id}/token {token}` (204; nunca se devuelve)
  - `GET /api/projects/{id}/tickets`, `GET /api/tickets/{id}` (incluye sesiones asociadas y propuestas)
  - `GET /api/projects/suggestions` (Task 5), `POST /api/projects/{id}/sync` (Task 6), `POST /api/tickets/{id}/launch` (Task 10), propuestas (Task 11), `POST/DELETE /api/sessions/{id}/ticket` (Task 9)
  - Live: `project_upsert`, `project_gone`, `workspace_upsert`, `tickets` (lote por proyecto), `proposal_upsert`, `session_ticket`; snapshot inicial incluye workspaces y proyectos.
- [ ] **Step 1: Tests** de cada ruta (incluido que ninguna respuesta contiene el token) y de los envelopes del snapshot.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat(hub): API de proyectos, tickets y propuestas`

---

### Task 14: App — tablero de proyectos

**Files:**
- Create: `app/src/screens/Projects.tsx`, `app/src/screens/Project.tsx`, `app/src/components/{ProjectCard,TicketRow,TicketDetail,ProposalCard,ConnectorForm,WorkspaceForm}.tsx`, tests
- Modify: `app/src/App.tsx` (navegación: Proyectos | Sesiones), `app/src/lib/store.ts` (+ estado de proyectos), `app/src/lib/api.ts`

**Interfaces:**
- Produces:
  - **Proyectos** (pantalla inicial): agrupados por trabajo; cada `ProjectCard` muestra nombre, barra de avance `done/total`, resumen, sesiones vivas (recap + estado con color), "Error de sincronización" si hay, y cuántas propuestas pendientes. En ≥ 1024 px: columnas por trabajo; en celular: lista.
  - **Proyecto:** tickets agrupados por estado normalizado (por_hacer, en_curso, en_review, bloqueado, hecho plegado); cada `TicketRow` muestra el estado combinado ("en curso · <máquina> · trabajando hace 12 min" / "listo, esperando tu review"); detalle con cuerpo, comentarios, sesiones asociadas, botón "Abrir sesión" (máquina + checkout) y propuestas pendientes (editar, aprobar, rechazar). Sugerencias de asociación con "Confirmar". Sección "Checkouts" y botón "Actualizar".
  - **Configuración:** crear/editar trabajos (nombre, color, perfil de whoas) y proyectos (nombre, repo, conector con su formulario por tipo, token solo de escritura, intervalo); sugerencias de proyectos con "Crear proyecto".
  - Sesiones: la lista existente se mantiene como segunda pestaña y cada sesión muestra su proyecto.
- [ ] **Step 1: Tests (vitest + Testing Library):** reducer de proyectos/tickets/propuestas; `ProjectCard` con error de sync; `TicketRow` estado combinado; `ProposalCard` envía el cuerpo editado; `ConnectorForm` nunca precarga el token.
- [ ] **Step 2–4:** FAIL → implementar → PASS; `npm run build`.
- [ ] **Step 5: Commit** `feat(app): tablero de proyectos, tickets y propuestas`

---

### Task 15: E2E funcional del Plan 2

**Files:**
- Modify: `docs/e2e-etapa1.md` → crear `docs/e2e-plan2.md`

- [ ] **Step 1: Escribir `docs/e2e-plan2.md`** con estos pasos y su resultado esperado, y ejecutarlos con el mismo aislamiento del e2e anterior (PC WSL + VPS VPS en `~/quorum-e2e`, hub en 127.0.0.1 por túnel SSH, `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_PLUGIN_DIRS`/`TMUX_TMPDIR` aislados; ≤ 12 prompts cortos con Haiku; limpiar todo al final):
  1. Permiso pedido en una sesión → aparece a la vez en la terminal (diálogo Quorum) y en la app; contestar en la terminal → la tarjeta desaparece; otro contestado en la app → la herramienta corre y el diálogo de la terminal queda sin efecto.
  2. Recap: tras el primer prompt la sesión cambia de nombre a una frase corta.
  3. Crear trabajo + proyecto con conector **exec** (script de ejemplo de `docs/conectores.md`) → tickets aparecen normalizados.
  4. Conector **GitHub** contra un repo de prueba del dueño **solo lectura** (listar issues; no comentar) — si no hay repo de prueba acordado, usar el propio `S-kkipie/quorum` una vez creado o marcar pendiente.
  5. Conector **Paperclip** contra la VPS **solo lectura** (listar issues de ACME usando el token del board sin imprimirlo) — no aprobar propuestas contra Paperclip.
  6. Proyecto sugerido por remoto git → crear → las sesiones existentes quedan bajo el proyecto; mismo repo en PC y VPS → dos checkouts.
  7. Rama `feat/<n>-…` → sugerencia de ticket → confirmar en la app.
  8. Abrir sesión desde un ticket en la VPS → arranca con el contexto del ticket y queda asociada; segundo intento → 409 y la app ofrece ir a la existente.
  9. `turn_end` → propuesta pendiente; aprobarla contra el conector **exec** (que registra en un archivo) → `aprobada`; rechazar otra.
  10. Resumen del proyecto aparece (vía ccapi local si está corriendo; si no, `claude -p`) y no se regenera antes de 30 min.
  11. Conector exec roto (exit 1) → "Error de sincronización" y los tickets se conservan.
  12. UI: smoke con el navegador (skill `agent-browser`) de las pantallas Proyectos, Proyecto, Ticket y Configuración; 3–4 capturas.
- [ ] **Step 2:** registrar OK / FALLA→ARREGLADO (commit) / PENDIENTE por paso; los bugs se arreglan con test de regresión y suite verde.
- [ ] **Step 3: Commit** `docs: e2e del Plan 2`
