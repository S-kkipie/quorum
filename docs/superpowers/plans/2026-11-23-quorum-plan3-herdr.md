# Quorum — Plan 3: sesiones y terminal sobre herdr (celular primero)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desde el celular, en un proyecto: "Nueva sesión" en un toque, "Retomar" una conversación anterior y una terminal real. Todo vive en el herdr de cada máquina, y la app navega sola a la sesión nueva.

**Architecture:**
- `quorumd` habla con el herdr local por su socket, con JSON por líneas: un paquete cliente nuevo, `internal/daemon/herdr`.
- Las sesiones nacen como pestaña nueva en el workspace del proyecto, con `agent.start --kind claude`. Si no hay herdr, se usa el lanzador actual.
- Cada lanzamiento lleva un `reqId`. Viaja como variable de entorno `QUORUM_LAUNCH_REQ` hasta el mod, que lo reporta en `SessionInfo`. Así el hub ata reqId → sesión y avisa a la app (`launch_session`).
- Conversaciones y terminal van por un RPC hub→daemon sobre el WebSocket existente.
- Las fotos de pantalla (`term_frame`) se publican a las apps sin guardarse.

**Tech Stack:** igual que el Plan 2 (Go 1.27 sin cgo, `modernc.org/sqlite`, `coder/websocket`, tygo; mod TS con `claude plugin test`; React 19 + Vite + Tailwind v4 + vitest). Sin dependencias nuevas: el render ANSI de la terminal es propio.

**Spec:** `docs/superpowers/specs/2026-11-23-quorum-herdr-sesiones-design.md` (incluida §7.7).

**Ajustes sobre el spec**, decididos al verificar herdr 0.9.5 en esta PC:
- herdr no tiene un evento de "cambió la pantalla": `pane.updated` solo salta con cambios de título. La terminal usa un poll de `pane.read` acotado, solo mientras alguien mira.
- El lanzamiento se ata por `QUORUM_LAUNCH_REQ`. herdr permite pasar `env` a `tab.create`, y eso sirve igual con y sin herdr. El panel (`HERDR_PANE_ID`) se sigue reportando, para "Ver en terminal".
- La config opcional se llama `herdrSocket` (ruta del socket) en vez de `herdrSession`.
- Los paneles de herdr en Linux son shells interactivos, no de login. Cargan `.bashrc`/`.zshrc`, que es donde están los shims de whoas en la PC con WSL y en el servidor Linux, así que no hace falta envolver `claude`.

## Global Constraints

- Todo lo de los Planes 1 y 2 sigue vigente:
  - textos en español;
  - sin modos;
  - tokens nunca impresos ni devueltos;
  - `claude` nunca por ruta absoluta;
  - commits con autor `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`.
- herdr: protocolo 22 (0.9.5).
  - Socket por defecto `~/.config/herdr/herdr.sock`. Se puede cambiar con `HERDR_SOCKET_PATH` o con `herdrSocket` en `daemon.json`.
  - Peticiones `{"id","method","params"}\n`. Respuestas `{"id","result":{...}}` o `{"id","error":{"code","message"}}`.
- **Nunca** se renombra, cierra ni reordena un workspace o pestaña que Quorum no creó. Quorum cierra solo los paneles de terminal que abrió, y solo con "Cerrar terminal".
- El celular **nunca** redimensiona paneles.
- Siempre "Nueva sesión": no hay tipos (feature/bug) ni nombre al lanzar.
- Flags de claude:
  - "Sin permisos" → `--dangerously-skip-permissions`;
  - si no → `--permission-mode default`;
  - retomar → `--resume <id>`.
  - "Sin permisos" está activado por defecto y deshabilitado si la máquina corre como root (`os.Geteuid()==0`), con el motivo `"Sin permisos no funciona como root"`.
- `term_frame`:
  - solo mientras alguien mira (lease de 15 s que la app renueva cada 5 s);
  - ≤ 8 por segundo por panel (poll de `pane.read` cada 125 ms; solo se manda si cambió el texto);
  - ≤ 256 KiB (si excede, se recortan líneas del principio);
  - descartable en la cola del daemon (`emit(..., droppable=true)`);
  - nunca se guarda en la base.
- Entorno de la sesión lanzada: `QUORUM_LAUNCH_REQ=<reqId>`. En herdr va como `env` de `tab.create`/`workspace.create`; en tmux/wt/osascript, como prefijo de la línea de shell.
- Navegación tras lanzar: timeout de 60 s. Después: `"Claude no se registró en 60 s"` y, si hay panel, el botón "Ver en terminal".
- Teclas permitidas (nombres de herdr): `esc tab enter ctrl+c ctrl+d ctrl+l up down left right`. Cualquier otra → 400.
- Conversaciones:
  - máx. 60, más recientes primero;
  - título: `custom-title` > `ai-title` > `summary` > primer prompt del usuario (recortado a 80 runas);
  - carpeta `~/.claude/projects/<root con todo carácter no [A-Za-z0-9] cambiado por '-'>`.

## Review Focus

1. **El dueño cierra el panel en su herdr mientras el celular mira la terminal** → el daemon manda `term_closed`; la app muestra "La terminal se cerró" con botón "Abrir otra" y nunca deja una foto congelada como si estuviera viva. Test en Task 6 (daemon) y Task 10 (app).
2. **Doble toque en "Nueva sesión"** → una sola sesión: el botón queda deshabilitado mientras hay un lanzamiento pendiente de ese proyecto. Test en Task 9.
3. **Carpeta o nombre de proyecto con espacios, comillas o `;`** → llega intacto a herdr: va como JSON, nunca por un shell. En el respaldo se cita como hoy. Test en Task 3.
4. **"Retomar" donde Claude cambia el id de la sesión** → la app navega igual, porque ata por `launchReq` y no por id. Test en Task 5.
5. **herdr caído o desinstalado después de arrancar `quorumd`:**
   - el siguiente lanzamiento usa el respaldo, sin error;
   - la app deja de ofrecer "Terminal" en ≤ 30 s, porque las capacidades se reevalúan cada 30 s y se mandan si cambian.

   Test en Task 4.

---

### Task 1: Protocolo y capacidades de máquina

**Files:**
- Modify: `internal/proto/proto.go`, `mod/src/proto.gen.ts` + `app/src/proto.gen.ts` (con `make proto`)
- Modify: `internal/hub/store/store.go`, `internal/hub/store/migrations.go`, `internal/hub/machines.go`
- Modify: `app/src/lib/api.ts` (interfaz `Machine`)
- Test: `internal/hub/store/store_test.go`, `internal/hub/machines_test.go`

**Interfaces — Produces:**
- `proto.MachineCaps{Herdr bool "herdr"; Terminal bool "terminal"; Root bool "root"}`.
- `proto.MachineHello.Caps MachineCaps "caps"`.
- `store.Machine.Caps proto.MachineCaps "caps"` (columna `caps TEXT NOT NULL DEFAULT '{}'`, migración con `ALTER TABLE` como las de `sessions`).
- `(*store.Store).UpsertMachine(name, os, env, version string, online bool, caps proto.MachineCaps) error`.
- `(*store.Store).SetMachineCaps(name string, caps proto.MachineCaps) error`.
- `proto.SessionInfo` gana `LaunchReq string "launchReq"`, `HerdrPane string "herdrPane"` y `HerdrWorkspace string "herdrWorkspace"`.
- `proto.LaunchRequest` gana:
  - `Resume string "resume"`: id de la sesión de Claude;
  - `Label string "label"`: nombre del proyecto, para el workspace nuevo;
  - `Trust bool "trust"`.
- `proto.LaunchResult` gana `Pane string "pane"` y `Via string "via"` (`herdr|tmux|wt|osascript`).
- `proto.Conversation{ID, Title, FirstPrompt string; Messages int; UpdatedAt int64; Open bool}`. Tags JSON: `id title firstPrompt messages updatedAt open`.
- `proto.RPC{ReqID string "reqId"; Method string "method"; Params json.RawMessage "params"}`.
- `proto.RPCResult{ReqID string "reqId"; Result json.RawMessage "result"; Error string "error"}`.
- `proto.TermFrame{Pane string "pane"; Cols, Rows int; ANSI string "ansi"; Closed bool "closed"}`. Tags `cols`, `rows`.
- Documentar en el comentario de `Envelope` los tipos nuevos:
  - `caps` (daemon→hub: Payload `MachineCaps`);
  - `rpc` / `rpc_result` (hub↔daemon);
  - `term_frame` (daemon→hub→app);
  - `launch_session` (hub→app: Payload `{reqId, sessionId}`).
- Hub:
  - `onHello` guarda `hello.Caps`;
  - el mensaje `caps` de una máquina conectada llama `SetMachineCaps` y `publishStatus`;
  - `machine_status` ya serializa `store.Machine`, así que lleva `caps`.

- [ ] **Step 1: Tests que fallan.**
  - `TestMachineCapsRoundTrip`: `UpsertMachine(..., MachineCaps{Herdr:true,Terminal:true})` y después `ListMachines()[0].Caps.Herdr == true`. Una base creada sin la columna migra con `{}`.
  - `TestHelloAndCapsUpdatePublishStatus`: con el `newFixture` de `machines_test.go`, un hello con `Caps.Herdr=true` publica un `machine_status` con `caps.herdr=true`. Un `caps` posterior con `Herdr=false` publica otro con `false`.
- [ ] **Step 2:** `go test ./internal/hub/...`. Esperado: FAIL (campos inexistentes).
- [ ] **Step 3:** Implementar lo de Produces y adaptar las llamadas existentes a `UpsertMachine` (incluidos los tests). Correr `make proto` y agregar `caps: { herdr: boolean; terminal: boolean; root: boolean }` a `Machine` en `app/src/lib/api.ts`.
- [ ] **Step 4:** `go test ./... && cd app && npx vitest run`. Esperado: PASS.
- [ ] **Step 5:** Commit `proto: capacidades de máquina, launchReq/herdrPane, conversaciones, rpc y term_frame`.

### Task 2: Cliente de herdr y herdr falso para tests

**Files:**
- Create: `internal/daemon/herdr/client.go`, `internal/daemon/herdr/herdrtest/fake.go`
- Test: `internal/daemon/herdr/client_test.go`

**Interfaces — Produces:**
- `type Client struct{ Socket string }`.
- `func SocketPath(override string) string`: override > `$HERDR_SOCKET_PATH` > `~/.config/herdr/herdr.sock`.
- `func (c *Client) Available(ctx) bool`: el socket existe y `workspace.list` responde en < 1 s.
- `func (c *Client) Call(ctx, method string, params, out any) error`: una conexión por llamada. Lee una línea y deserializa `result` en `out`. Un `error` del servidor se convierte en `*Error{Code, Message string}`.
- Tipos:
  - `Workspace{ID "workspace_id", Label, Focused bool, Number int}`;
  - `Pane{ID "pane_id", WorkspaceID "workspace_id", TabID "tab_id", Cwd, Focused bool, Agent string, AgentSession *struct{Value string}}`.
- Métodos:
  - `ListWorkspaces(ctx) ([]Workspace, error)`;
  - `ListPanes(ctx, workspaceID string) ([]Pane, error)`;
  - `CreateWorkspace(ctx, cwd, label string, env map[string]string) (wsID, rootPane string, err error)`;
  - `CreateTab(ctx, wsID, cwd, label string, env map[string]string) (rootPane string, err error)`;
  - `StartAgent(ctx, name, kind, pane string, args []string, timeoutMs int) error`;
  - `ReadPane(ctx, pane, source string, lines int) (text string, err error)`: siempre `format:"ansi"` y `strip_ansi:false`;
  - `PaneSize(ctx, pane string) (cols, rows int, err error)`: el rect del panel en `pane.layout`;
  - `SendText`, `SendKeys(ctx, pane string, keys []string)`, `ClosePane(ctx, pane string) error`.
- Las formas de respuesta están verificadas en esta PC:
  - `workspace.list` → `result.workspaces[]`;
  - `pane.list` → `result.panes[]`;
  - `pane.read` → `result.read.text`;
  - `pane.layout` → `result.layout.panes[].rect.{width,height}`;
  - `workspace.create` → `result.workspace.workspace_id` y `result.root_pane.pane_id`;
  - `tab.create` → `result.root_pane.pane_id`.
- `herdrtest.New(t) *Fake`: escucha en un socket unix temporal. `Fake.Socket`. `Fake.Handle(method string, fn func(params json.RawMessage) (result any, errCode string))`. `Fake.Calls() []Call{Method string; Params json.RawMessage}`.

- [ ] **Step 1: Tests que fallan.**
  - `TestCallDecodesResult`.
  - `TestCallServerError`: el fake responde el código `not_found`, y `errors.As` da `*Error` con `Code=="not_found"`.
  - `TestCreateTabSendsEnvAndCwd`: con cwd `/tmp/a b;c` y env `{QUORUM_LAUNCH_REQ:"r1"}`, el fake recibe esos params exactos.
  - `TestAvailableFalseWithoutSocket`.
- [ ] **Step 2:** `go test ./internal/daemon/herdr/...`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. Plazo por llamada: el del ctx, con 10 s por defecto si no tiene. `StartAgent` usa `timeout_ms` + 5 s.
- [ ] **Step 4:** Mismo comando. Esperado: PASS.
- [ ] **Step 5:** Commit `daemon: cliente del socket de herdr`.

### Task 3: Lanzar en herdr (y respaldo con reqId, retomar, confiar)

**Files:**
- Create: `internal/daemon/launch/herdr.go`, `internal/daemon/launch/trust.go`
- Modify: `internal/daemon/launch/launch.go`
- Test: `internal/daemon/launch/herdr_test.go`, `internal/daemon/launch/trust_test.go`, `internal/daemon/launch/launch_test.go`

**Interfaces:**
- Consumes: `herdr.Client` (Task 2).
- Produces:
  - `type Workspaces struct{ Path string }`: memoria `root → workspaceID` en `<ConfigDir>/herdr-workspaces.json`, con escritura atómica. Métodos `Get(root) string` y `Set(root, id string) error`.
  - `func ResolveWorkspace(ctx, c *herdr.Client, ws *Workspaces, root, label string, env map[string]string) (wsID, freshPane string, err error)`: los pasos 3a–3c del algoritmo. `freshPane` no está vacío solo si creó el workspace. La Task 6 la reusa para la terminal.
  - `func RunHerdr(ctx, c *herdr.Client, ws *Workspaces, req proto.LaunchRequest) proto.LaunchResult`.
  - `func TrustDir(home, dir string) error`.
  - `claudeArgs` agrega `--resume <id>` (con `Resume` que valide `^[0-9a-fA-F-]{8,64}$`; si no valida, error `"id de conversación inválido"`).
  - `claudeLine` antepone `QUORUM_LAUNCH_REQ=<reqId saneado [A-Za-z0-9]> `.
  - `Run` rechaza `PermissionMode=="bypass"` cuando `geteuid()==0`, con el texto de Global Constraints (`geteuid` es una variable para tests).

**Algoritmo de `RunHerdr`, el orden importa:**
1. Validar como `Run`: modo, ruta absoluta, carpeta existe, root.
2. Si `req.Trust`, llamar `TrustDir`. Si falla, se registra en el log y se sigue.
3. Elegir el workspace:
   - (a) `ws.Get(root)`, si sigue en `ListWorkspaces`;
   - (b) si no, entre los paneles de `ListPanes("")` cuyo `Cwd == root`, el workspace enfocado o, si no hay, el de menor `Number`;
   - (c) si no, `CreateWorkspace(root, label, env)`. `label` es `req.Label` o el basename. Su panel raíz **es** el de la sesión, sin pestaña extra.
4. En (a) y (b): `CreateTab(wsID, root, "claude", env)`. `env = {QUORUM_LAUNCH_REQ: reqId}`. Guardar `ws.Set(root, wsID)`.
5. `StartAgent("q"+suffix(reqId), "claude", pane, args, 60000)`. Un error `agent_not_ready` cuenta como OK: Claude quedó en un diálogo de arranque y la app ofrecerá "Ver en terminal". Cualquier otro error → `OK=false` con el mensaje.
6. Resultado: `OK`, `Pane=pane`, `Via="herdr"`.

**`TrustDir`:**
- Lee `<home>/.claude.json`. Si `projects[dir].hasTrustDialogAccepted` ya es true, no escribe nada.
- Si no, lo pone en true (crea la entrada si falta) y escribe con tmp + rename en el mismo directorio y el mismo modo de archivo.
- Antes de renombrar, si el mtime cambió desde la lectura, reintenta hasta 3 veces.
- Nunca borra ni reordena otras claves: usa `map[string]json.RawMessage`.

- [ ] **Step 1: Tests que fallan**, usando `herdrtest.Fake`:
  - `TestRunHerdrReusesRememberedWorkspace`: crea pestaña con env y cwd y llama `agent.start` con args `["--dangerously-skip-permissions"]` para `PermissionMode:"bypass"`.
  - `TestRunHerdrPicksWorkspaceByCwd`.
  - `TestRunHerdrCreatesWorkspaceAndUsesItsRootPane`: no hay `tab.create`; el label es `req.Label`.
  - `TestRunHerdrResumeArgs`: `["--permission-mode","default","--resume","<id>"]`.
  - `TestRunHerdrAgentNotReadyIsOK`.
  - `TestRunHerdrOddPath`: root `/tmp/x "y";z` llega igual en los params.
  - `TestTrustDirPreservesOtherKeys`.
  - `TestTrustDirNoopWhenTrusted`: el mtime no cambia.
  - `TestClaudeLineCarriesLaunchReq`.
  - `TestBypassRejectedAsRoot`.
- [ ] **Step 2:** `go test ./internal/daemon/launch/...`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mismo comando. Esperado: PASS.
- [ ] **Step 5:** Commit `daemon: lanzar sesiones en herdr; retomar; confiar carpeta; reqId en el entorno`.

### Task 4: Daemon — elegir lanzador, capacidades y RPC

**Files:**
- Modify: `internal/daemon/config.go`, `internal/daemon/hublink.go`, `internal/daemon/run.go`
- Create: `internal/daemon/rpc.go`
- Test: `internal/daemon/hublink_test.go`, `internal/daemon/rpc_test.go`

**Interfaces:**
- Consumes: Tasks 2 y 3.
- Produces:
  - `Config` gana `HerdrSocket string "herdrSocket"` y `Terminal *bool "terminal"`. `nil` equivale a true; helper `cfg.TerminalOn() bool`.
  - `type Host struct{ Herdr *herdr.Client; WS *launch.Workspaces; TerminalOn bool }`. Se crea en `Serve` y se pasa a `RunHubLink` (cambia la firma: `RunHubLink(ctx, cfg, reg, host *Host)`).
  - `func (h *Host) Caps(ctx) proto.MachineCaps`: `Herdr` es `Available()`, `Terminal` es `Herdr && TerminalOn`, `Root` es `geteuid()==0`.
  - El hello lleva `Caps`. Mientras el enlace vive, un ticker de 30 s recalcula `Caps` y, si cambió, emite el envelope `caps`.
  - En `readLoop`, `launch` usa `launch.RunHerdr` si `host.Herdr.Available()`; si no, `launch.Run`. Si `RunHerdr` falla porque herdr no responde (error de conexión, no un error de herdr), reintenta con `launch.Run`.
  - `rpc`: `go handleRPC(ctx, host, reg, env)` responde `rpc_result` con el mismo `reqId`. Despacha por `Method` a `rpcHandlers map[string]func(ctx, *Host, json.RawMessage) (any, error)`, que se llenan en las Tasks 5 y 6. Un método desconocido da el error `"método desconocido"`.

- [ ] **Step 1: Tests que fallan.**
  - `TestHelloCarriesCaps`: con un fake de herdr disponible, `caps.herdr=true` y `terminal=true`.
  - `TestCapsReemittedOnChange`: se cierra el fake, se acorta el ticker (variable `capsEvery`) y llega `caps` con `herdr=false`.
  - `TestLaunchPrefersHerdr`: `launchRun` no se llama y el `launch_result` trae `via:"herdr"`.
  - `TestLaunchFallsBackWithoutHerdr`.
  - `TestRPCUnknownMethod`.
- [ ] **Step 2:** `go test ./internal/daemon/...`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mismo comando. Esperado: PASS.
- [ ] **Step 5:** Commit `daemon: herdr como lanzador por defecto, capacidades y rpc`.

### Task 5: Mod reporta reqId/panel y el hub ata el lanzamiento a la sesión

**Files:**
- Modify: `mod/hooks/register.ts`, `mod/.claude-plugin/plugin.json` (versión `0.1.2`) y `.claude-plugin/marketplace.json` si repite la versión
- Modify: `internal/hub/ticketlaunch.go`, `internal/hub/appapi.go`, `internal/hub/machines.go`
- Test: `mod/test/register.test.ts`, `internal/hub/ticketlaunch_test.go`, `internal/hub/appapi_test.go`

**Interfaces — Produces:**
- Mod: `link.start` envía `launchReq`, `herdrPane` y `herdrWorkspace`, leídos con `optional(() => $.env.get('QUORUM_LAUNCH_REQ' | 'HERDR_PANE_ID' | 'HERDR_WORKSPACE_ID'), '')`.
- Hub:
  - `pendingLaunch` gana `reqID string`; `ticketID` pasa a ser opcional.
  - `addPending` deduplica por ticket solo si `ticketID != ""`.
  - `matchPending(si)`:
    - primero busca coincidencia exacta `si.LaunchReq == reqID` en la misma máquina (vale también para sesiones con `PreviousID` aplicado y para las ya existentes);
    - si no hay, aplica la regla actual por carpeta, **solo** para pendientes con ticket.
    - Al consumir: si tiene ticket, `confirmLink` como hoy. **Siempre** publica `launch_session {reqId, sessionId}`.
  - `matchPending` ahora se llama en todo `session_upsert` con `LaunchReq != ""`, no solo en sesiones nuevas. Un pendiente se consume una sola vez.
  - `POST /api/launch`:
    - body `{machine, dir, permissionMode, resume, label, projectId}`;
    - si `projectId` viene y `label` no, el label es el nombre del proyecto;
    - `trust` siempre es true;
    - registra `addPending(reqId, pendingLaunch{machine, root: dir})`;
    - responde `{reqId}`.
  - `handleTicketLaunch` pasa también `Trust:true` y `Label`.

- [ ] **Step 1: Tests que fallan.**
  - Mod: `register sends launchReq and herdr pane from env`.
  - Hub, `TestLaunchSessionPublishedByLaunchReq`: `POST /api/launch` y después un `session_upsert` con `launchReq` igual → se publica `launch_session{reqId, sessionId}`.
  - Hub, `TestLaunchSessionAfterIDChange`: la primera sesión con `launchReq` ya existía con otro id; aun así se publica una sola vez. Un segundo upsert no publica de nuevo.
  - Hub, `TestTicketLaunchStillLinksByReq`.
  - Hub: la regla por carpeta sigue igual para los ticket launches de antes (los tests existentes siguen pasando).
- [ ] **Step 2:** `claude plugin test mod && go test ./internal/hub/...`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `make test`. Esperado: PASS.
- [ ] **Step 5:** Commit `hub+mod: atar cada lanzamiento a su sesión (launch_session)`.

### Task 6: Daemon — conversaciones y terminal

**Files:**
- Create: `internal/daemon/convos/convos.go`, `internal/daemon/terminal.go`
- Modify: `internal/daemon/rpc.go` (registrar los métodos)
- Test: `internal/daemon/convos/convos_test.go` (con testdata JSONL), `internal/daemon/terminal_test.go`

**Interfaces:**
- Consumes: Tasks 2 y 4; `Registry.Snapshot()` para saber qué sesiones están vivas.
- Produces:
  - `convos.Dir(home, root string) string`.
  - `convos.List(dir string, live map[string]bool, max int) ([]proto.Conversation, error)`. Si la carpeta no existe → `[]` sin error. Ordena por mtime y toma `max`.
    - Lee cada `.jsonl`, de hasta 200 MiB; las líneas de más de 1 MiB se saltan.
    - Cuenta las líneas `type` `user`/`assistant` que tienen texto.
    - El título sigue la precedencia de Global Constraints.
    - `FirstPrompt`: el primer `user` cuyo contenido es string y no es sintético. Reusa el criterio de `transcript.skipUserText`, exportándolo como `transcript.SkipUserText`.
    - Caché en memoria por `(path, size, mtime)`.
  - Métodos RPC (params → result):
    - `conversations` `{root}` → `[]Conversation`.
    - `term_open` `{root, label, new bool}` → `{pane, cols, rows}`:
      - reusa el panel de terminal recordado de ese root si sigue en `ListPanes` y `new` es false;
      - si no, `launch.ResolveWorkspace(..., root, label, nil)`: si devolvió `freshPane`, ese es el panel; si no, crea `CreateTab(ws, root, "terminal", nil)`;
      - recuerda `root → pane` en `<ConfigDir>/herdr-terminals.json`.
    - `term_watch` `{pane}` → `{}`: arranca o renueva un lease de 15 s.
    - `term_input` `{pane, text, keys []string}` → `{}`: `text` → `SendText`; `keys` (validadas contra la lista de Global Constraints) → `SendKeys`.
    - `term_read` `{pane, lines}` → `{ansi}`: `source:"recent"`, `lines` acotado a 2000.
    - `term_close` `{pane}` → `{}`: solo cierra paneles que **Quorum** abrió (los de `herdr-terminals.json`). Cualquier otro → error `"Quorum solo cierra terminales que abrió"`.
    - Todos los `term_*` → error `"la terminal está desactivada en esta máquina"` si `!host.TerminalOn` o no hay herdr.
  - El vigilante es una goroutine por panel mientras el lease está vigente:
    - cada 125 ms, `ReadPane(visible)`;
    - cada 2 s, `PaneSize`;
    - si el texto o el tamaño cambian, emite `term_frame` descartable;
    - si `ReadPane` devuelve `not_found`, emite `term_frame{Closed:true}` y termina;
    - si el lease vence, termina.
  - Cotas: los intervalos (`termPoll`, `termSize`, `termLease`) son variables para tests. Recorte a 256 KiB por el principio, en un límite de línea.

- [ ] **Step 1: Tests que fallan.**
  - `TestListTitlesAndOrder`: testdata con ai-title, custom-title, summary, solo prompt y un `<command-name>` sintético.
  - `TestListMissingDirEmpty`.
  - `TestListMarksOpen`.
  - `TestDirEncoding`: `/home/u/work/proj-x` → `-home-u-work-proj-x`; `/a/b.c_d` → `-a-b-c-d`.
  - `TestTermOpenReuses`.
  - `TestTermOpenNewCreatesTab`.
  - `TestTermWatchEmitsOnlyOnChange`: el fake devuelve el mismo texto 3 veces y después otro, y llegan 2 frames.
  - `TestTermWatchClosed`.
  - `TestTermWatchLeaseExpires`.
  - `TestTermFrameTruncated`: 300 KiB → ≤ 256 KiB y conserva el final.
  - `TestTermInputRejectsUnknownKey`.
  - `TestTermCloseOnlyOwn`.
  - `TestTermDisabled`.
- [ ] **Step 2:** `go test ./internal/daemon/...`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mismo comando. Esperado: PASS.
- [ ] **Step 5:** Commit `daemon: conversaciones anteriores y terminal sobre herdr`.

### Task 7: Hub — RPC, conversaciones, terminal, frames y auditoría

**Files:**
- Create: `internal/hub/rpc.go`, `internal/hub/terminalapi.go`
- Modify: `internal/hub/machines.go` (mensajes `rpc_result`, `term_frame`), `internal/hub/appapi.go` (rutas), `internal/hub/store/migrations.go`, `internal/hub/store/store.go`
- Test: `internal/hub/terminalapi_test.go`

**Interfaces:**
- Consumes: los métodos RPC de la Task 6.
- Produces:
  - `func (h *Hub) call(ctx, machine, method string, params any, out any) error`:
    - `reqId` aleatorio; espera `rpc_result` en un mapa de waiters con un timeout de 10 s;
    - máquina desconectada → `errOffline`;
    - un `Error` no vacío vuelve como error con ese texto.
  - Rutas (todas `dev(...)`; `{pane}` llega con `:` sin codificar o codificado, y se usa `r.PathValue`):
    - `GET /api/machines/{m}/conversations?root=` → `[]Conversation`;
    - `POST /api/machines/{m}/terminals` `{root, label, new}` → `{pane, cols, rows}` y auditoría `open`;
    - `POST /api/machines/{m}/terminals/{pane}/watch` → 204;
    - `POST /api/machines/{m}/terminals/{pane}/input` `{text, keys}` → 204;
    - `GET /api/machines/{m}/terminals/{pane}/read?lines=` → `{ansi}`;
    - `DELETE /api/machines/{m}/terminals/{pane}` → 204 y auditoría `close`.
  - Códigos de error:
    - offline → 409 `"la máquina está fuera de línea"`;
    - error del daemon → 409 con su texto;
    - timeout → 504 `"la máquina no respondió"`.
  - `term_frame` desde la máquina → `h.publish` tal cual, con `Machine` = nombre autenticado. No se guarda.
  - `rpc_result` → despierta al waiter y no se difunde.
  - Tabla `terminal_audit(id INTEGER PRIMARY KEY, at INTEGER, device TEXT, machine TEXT, pane TEXT, action TEXT)`.
  - `(*store.Store).AuditTerminal(device, machine, pane, action string) error`. El dispositivo sale de `AuthName(r.Context())`.

- [ ] **Step 1: Tests que fallan.** Usar el fixture de máquina falsa (`newFixture` + `sendHello`) respondiendo `rpc`:
  - `TestConversationsProxied`.
  - `TestRPCTimeout504`: con `rpcTimeout` como variable.
  - `TestTerminalOpenAudited`: hay una fila `open` con el dispositivo.
  - `TestTermFrameRelayedNotStored`: no hay evento en la base.
  - `TestTerminalOffline409`.
  - `TestRPCResultFromOtherMachineIgnored`: un `reqId` de otra máquina no despierta al waiter.
- [ ] **Step 2:** `go test ./internal/hub/...`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mismo comando. Esperado: PASS.
- [ ] **Step 5:** Commit `hub: rpc a máquinas, conversaciones y terminal con auditoría`.

### Task 8: App — API, preferencias por proyecto y "Arrancando…"

**Files:**
- Modify: `app/src/lib/api.ts`, `app/src/App.tsx`, `app/src/components/LaunchDialog.tsx`, `app/src/components/TicketDetail.tsx`
- Create: `app/src/lib/launch.ts`, `app/src/screens/Starting.tsx`
- Test: `app/src/lib/launch.test.ts`, `app/src/App.test.tsx`

**Interfaces — Produces:**
- api:
  - `launch(b: {machine; dir; permissionMode?; resume?; label?; projectId?}): Promise<{reqId}>`;
  - `listConversations(machine, root): Promise<Conversation[]>`;
  - `openTerminal(machine, root, label, fresh=false): Promise<{pane; cols; rows}>`;
  - `watchTerminal(machine, pane)`;
  - `sendTerminal(machine, pane, {text?, keys?})`;
  - `readTerminal(machine, pane, lines): Promise<{ansi}>`;
  - `closeTerminal(machine, pane)`.
  - Todas codifican `pane` con `encodeURIComponent`.
- `launch.ts`:
  - `loadPrefs(projectId): {machine?: string; bypass: boolean}`, con `bypass` true por defecto. `savePrefs(projectId, p)` usa la clave `quorum.launch.<projectId>`.
  - `type Pending = {reqId; machine; label; startedAt; pane?; error?}`.
  - `pendingReducer(p: Pending|null, env: Envelope, now: number): {pending: Pending|null; open?: string}`:
    - `launch_session` con el mismo reqId → `open = sessionId`, `pending = null`;
    - `launch_result` con `!ok` → `error`;
    - `launch_result` con `ok` → guarda `pane`.
  - `timedOut(p, now)` vale `now - p.startedAt > 60000`.
- App: nuevo estado de navegación `starting: true` y `Pending` en el estado. Al llegar `open`, `openSession(id)` reemplaza la entrada de historial "Arrancando…" (`go(..., true)`).
- `Starting.tsx`:
  - muestra "Arrancando Claude en <machine>…";
  - si hay error, lo muestra con el botón "Volver";
  - con timeout, muestra "Claude no se registró en 60 s" y "Ver en terminal" si hay `pane`, que abre la Terminal de la Task 10 en ese panel.
- `LaunchDialog` y el lanzamiento desde un ticket pasan a usar este flujo: navegar a "Arrancando…" en vez de "Aparecerá en la lista".

- [ ] **Step 1: Tests que fallan.**
  - `pendingReducer opens session on launch_session`.
  - `ignores other reqId`.
  - `keeps pane from launch_result`.
  - `timedOut after 60s`.
  - `prefs default bypass true and persist machine`.
  - App: con un live falso, lanzar desde LaunchDialog muestra "Arrancando Claude en vps-1…", y un `launch_session` abre la sesión.
- [ ] **Step 2:** `cd app && npx vitest run`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Esperado: PASS.
- [ ] **Step 5:** Commit `app: lanzar y navegar sola a la sesión nueva`.

### Task 9: App — pantalla de proyecto: Nueva sesión, Terminal, Conversaciones

**Files:**
- Create: `app/src/components/NewSessionCard.tsx`, `app/src/components/Conversations.tsx`
- Modify: `app/src/screens/Project.tsx`, `app/src/screens/Session.tsx`
- Test: `app/src/components/NewSessionCard.test.tsx`, `app/src/components/Conversations.test.tsx`

**Interfaces:**
- Consumes: Task 8 (`launch`, `loadPrefs`/`savePrefs`, `listConversations`, el `Pending` de App).
- Produces:
  - `NewSessionCard({state, projectId, pending: boolean, onLaunched(reqId, machine, label), onTerminal(machine, root)})`:
    - **Máquinas candidatas:** los checkouts del proyecto (`projectCheckouts`). El chip de máquina muestra la elegida: primero la de las preferencias si está en línea; si no, la primera en línea. El selector es nativo.
    - **"Sin permisos":** casilla con el valor de las preferencias. Queda deshabilitada, con el motivo, si `machines[m].caps.root`.
    - **Botón grande "Nueva sesión":** deshabilitado si `pending` o si no hay máquina en línea. Lanza con `dir = checkout.root`, `permissionMode = bypass ? 'bypass' : 'default'` y `projectId`. Guarda las preferencias.
    - **"Terminal":** solo si `caps.terminal`; si no, muestra el texto "Terminal no disponible en esta máquina (falta herdr)".
    - **Sin checkouts:** el texto "Este proyecto todavía no tiene carpeta en ninguna máquina" y un enlace "Otra carpeta…" que abre el LaunchDialog.
  - `Conversations({machine, root, liveIds, onOpen(sessionId), onResume(convId)})`:
    - carga `listConversations`;
    - muestra 6, y "Ver todas (n)" las expande con un buscador por título;
    - cada fila: título, `since(updatedAt)` y `· N msj`;
    - una conversación abierta lleva el punto verde y abre la sesión;
    - una cerrada llama `onResume`, que lanza con `resume`.
  - Orden en `Project.tsx`: tarjeta, Sesiones abiertas, Conversaciones y después lo existente (sugerencias, tickets, checkouts).
  - En la cabecera de `Session.tsx`, menú `⋯` con:
    - "Nueva sesión aquí": lanza en `machine` + `root` de la sesión con las preferencias de su proyecto;
    - "Ver en terminal": solo si `herdrPane` y `caps.terminal`; abre la Terminal en ese panel.

- [ ] **Step 1: Tests que fallan.**
  - `NewSessionCard`: un toque llama `launch` con `{machine:'vps-1', dir:'/srv/repo', permissionMode:'bypass', projectId}`; queda deshabilitada con `pending`; con `root` muestra "Sin permisos" deshabilitado y el motivo; sin terminal muestra el texto de falta herdr.
  - `Conversations`: muestra 6 de 10 y "Ver todas (10)"; una abierta llama `onOpen`, una cerrada `onResume(id)`; con lista vacía muestra "Sin conversaciones anteriores en esta máquina".
- [ ] **Step 2:** `cd app && npx vitest run`. Esperado: FAIL.
- [ ] **Step 3:** Implementar con el estilo actual (Tailwind, zinc, botones `rounded`). El botón grande ocupa todo el ancho y mide ≥ 48 px de alto (un pulgar).
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Esperado: PASS.
- [ ] **Step 5:** Commit `app: nueva sesión, terminal y conversaciones en el proyecto`.

### Task 10: App — pantalla Terminal

**Files:**
- Create: `app/src/lib/ansi.ts`, `app/src/lib/frames.ts`, `app/src/screens/Terminal.tsx`
- Modify: `app/src/App.tsx` (nav `terminal: {machine, pane, root?}` y despacho de `term_frame` a `frames`)
- Test: `app/src/lib/ansi.test.ts`, `app/src/lib/frames.test.ts`, `app/src/screens/Terminal.test.tsx`

**Interfaces — Produces:**
- `ansi.ts`:
  - `type Span = {text: string; fg?: string; bg?: string; bold?; dim?; italic?; underline?; inverse?}`;
  - `parseAnsi(s: string): Span[][]`: una lista por línea. Divide en `\r\n`/`\n` e ignora `\r` sueltos.
  - SGR soportados: 0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 30–37, 39, 40–47, 49, 90–97, 100–107, `38;5;n`, `48;5;n`, `38;2;r;g;b` y `48;2;r;g;b`.
  - Las secuencias no SGR se descartan.
  - Paleta xterm de 256 colores.
- `frames.ts`:
  - `frames.set(machine, pane, f: TermFrame)`;
  - `frames.get(machine, pane)`;
  - `frames.subscribe(key, fn) → unsubscribe`;
  - guarda solo la última foto por clave.
- `Terminal({machine, pane, root?, label?, onBack})`:
  - mientras está montada, `watchTerminal` cada 5 s;
  - dibuja la última foto con `parseAnsi` en `<pre>` monoespaciado;
  - fuente = `clamp(8, 15, anchoContenedor / (cols * 0.6))` px, con botones `A−`/`A+` (±1 px) y scroll horizontal;
  - barra de teclas: `Esc Tab Ctrl-C ↑ ↓ ← → Ctrl-D Ctrl-L`;
  - campo de texto + `⏎`, que manda `{text}` y después `{keys:['enter']}`; si el campo está vacío, `⏎` solo manda Enter;
  - "Historial" pasa a vista estática con `readTerminal(…, 400)`, y "En vivo" vuelve;
  - con `Closed`, muestra "La terminal se cerró" con "Abrir otra" (`openTerminal(machine, root, label, true)`) si hay `root`;
  - el menú `⋯` tiene "Cerrar terminal", con `confirm`, que llama `closeTerminal` y vuelve;
  - sin frames en 3 s muestra "Conectando con la terminal…".
- Entrada desde la tarjeta: `onTerminal` llama `openTerminal(machine, root, label)` y navega con el `pane` devuelto.

- [ ] **Step 1: Tests que fallan.**
  - `parseAnsi`: colores 8, 256 y truecolor, reset, bold e inverse; una cadena con `\x1b[2J\x1b[H` las descarta; el texto del ejemplo real (`\u001b[1m\u001b[38;5;2muser@host \u001b[0m…`) da spans con `bold` y el color de índice 2.
  - `frames keeps only latest`.
  - Terminal:
    - una foto se ve;
    - tocar `Ctrl-C` llama `sendTerminal` con `{keys:['ctrl+c']}`;
    - escribir `ls` + `⏎` manda text y después enter;
    - `Closed` muestra "La terminal se cerró";
    - renueva `watch` a los 5 s (fake timers).
- [ ] **Step 2:** `cd app && npx vitest run`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Esperado: PASS.
- [ ] **Step 5:** Commit `app: terminal en vivo sobre herdr`.

### Task 11: Instalación de herdr, despliegue y e2e real desde el celular

**Files:**
- Create: `scripts/install-herdr.sh`, `docs/e2e-plan3.md`
- Modify: `README.md` (sección herdr), `scripts/install-daemon.sh` (aviso si falta herdr)

**`install-herdr.sh` (idempotente, POSIX sh, sin root):**
- Si falta `herdr` en PATH ni en `~/.local/bin`, lo instala con `curl -fsSL https://herdr.dev/install.sh | sh`. Después exige `herdr --version` ≥ 0.9.5.
- `herdr integration install claude`, si `~/.claude` existe.
- Si el socket por defecto ya responde (por ejemplo, el herdr del dueño en su PC), **no toca nada más** y lo dice.
- Si no, crea `~/.config/systemd/user/herdr-server.service`:
  - `ExecStart=%h/.local/bin/herdr server`;
  - `Restart=on-failure`;
  - `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`.
  - Después `systemctl --user daemon-reload && systemctl --user enable --now herdr-server`.
  - Avisa si `loginctl show-user $USER -p Linger` no es `yes`. No lo activa solo.
- Solo toca `~/.local/bin`, `~/.config/systemd/user/herdr-server.service` y lo que escriba `herdr integration`.

- [ ] **Step 1:** `sh -n scripts/install-herdr.sh` y `shellcheck` si está disponible. Esperado: sin errores.
- [ ] **Step 2:** `make test && make cross`. Esperado: PASS.
- [ ] **Step 3: Desplegar.**
  - **Servidor Linux arm64**, con su usuario de servicio, sin tocar nada fuera de lo nuestro:
    - correr `install-herdr.sh`;
    - actualizar el binario de `quorum-hub` y `quorumd` y reiniciar sus servicios de usuario;
    - `claude plugin update quorum@quorum`.
  - **La PC con WSL:** actualizar `quorumd` y el plugin. El herdr del dueño no se toca.
  - Verificar que en un panel de herdr del servidor, `command -v claude` resuelve como en un shell interactivo del dueño (whoas por `.bashrc`).
- [ ] **Step 4: e2e con agent-browser (`abw`) en un viewport de celular (390×844) contra la URL del hub.** Guardar evidencia y resultados en `docs/e2e-plan3.md`, saneado como los anteriores, sin datos internos. Casos:
  1. Un proyecto del servidor → "Nueva sesión" (servidor, Sin permisos):
     - la app pasa a "Arrancando…" y abre el chat solo;
     - en `herdr pane list` del servidor hay una pestaña nueva en el workspace del proyecto, con Claude y `--dangerously-skip-permissions`;
     - un prompt desde el celular responde.
  2. "Retomar" una conversación cerrada → abre en una pestaña nueva y la app navega a ella.
  3. "Terminal": se ve la pantalla. Con `git status` + `⏎` aparece la salida. Ctrl-C funciona. Cerrar la vista y volver reusa el mismo panel.
  4. Cerrar el panel de terminal desde herdr en el servidor → la app muestra "La terminal se cerró".
  5. La PC con WSL (herdr del dueño): "Nueva sesión" en un proyecto aparece como pestaña en el workspace ya existente del dueño para esa carpeta, sin renombrarlo.
  6. Doble toque rápido en "Nueva sesión" → una sola sesión.

  Al terminar: cerrar las sesiones y pestañas de prueba que abrió Quorum, con `herdr tab close` solo sobre las que creó la prueba.
- [ ] **Step 5:** Commit `herdr: instalación, despliegue y e2e desde el celular`.
