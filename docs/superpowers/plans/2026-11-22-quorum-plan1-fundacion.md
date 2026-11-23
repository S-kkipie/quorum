# Quorum — Plan 1: Fundación + sesiones en vivo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ver y controlar desde el navegador/celular todas las sesiones de Claude Code de todas las máquinas: lista en vivo, chat en streaming, prompts (ahora/cola/interrumpir), permisos y preguntas, abrir y cerrar sesiones.

**Architecture:** Un mod TS dentro de cada sesión habla con `quorumd` (Go, uno por máquina): sube eventos por HTTP a loopback y recibe órdenes por la salida estándar de un proceso hijo `quorumd attach` (push, sin polling). Cada `quorumd` mantiene un WebSocket saliente con `quorum-hub` (Go + SQLite), que guarda el estado, enruta órdenes y sirve la app React por HTTP + WebSocket.

**Tech Stack:** Go 1.27 (`github.com/coder/websocket`, `modernc.org/sqlite` sin cgo, `net/http` con patrones de Go 1.22+, `github.com/gzuidhof/tygo` para generar tipos TS), TypeScript para el mod (tests con `bun test`), React 19 + Vite + Tailwind v4 para la app (tests con `vitest`).

**Spec:** `docs/superpowers/specs/2026-11-22-quorum-design.md` (este plan cubre la Etapa 1 salvo proyectos/tickets/estado/resúmenes, que van en el Plan 2).

## Global Constraints

- Módulo Go: `github.com/S-kkipie/quorum`. Binarios: `quorumd` (daemon por máquina) y `quorum-hub`.
- Sin cgo en ningún binario (`CGO_ENABLED=0` debe compilar para linux/amd64, linux/arm64, windows/amd64, darwin/arm64).
- Nada compilado en git: `app/dist` y binarios ignorados. El hub embebe la app con `go:embed`; se commitea solo un `internal/hub/web/dist/index.html` de marcador.
- Todo push salvo la sincronización de ticketeras (Plan 2). Prohibido el polling entre mod y daemon.
- El mod nunca bloquea a Claude Code esperando a daemon o hub: toda llamada HTTP del mod tiene timeout ≤ 2 s y los fallos se descartan en silencio (salvo `ask`, que cae a la terminal).
- Hub y daemon escuchan solo en `127.0.0.1` por defecto (`--addr` para cambiarlo). Publicar con `tailscale serve`, nunca `funnel`.
- Tokens: 32 bytes aleatorios en base64url; en la base solo se guarda su SHA-256. Códigos de emparejamiento/enlace: 6 dígitos, un solo uso, vencen a los 10 min.
- Configuración del daemon: `~/.config/quorum/daemon.json` (permisos 0600). Base del hub: `~/.local/share/quorum/hub.db`.
- Los textos visibles para el usuario están en español.
- Las sesiones se lanzan siempre con `claude` resuelto por el PATH de un shell de login (`bash -lc`), para respetar los shims de whoas. Nunca una ruta absoluta a `claude`.
- La sesión de ccapi (`CCAPI_SERVER=1` en su entorno) es un **servicio**: el mod no inyecta prompts, no responde permisos y no reporta subagentes.
- pastor queda retirado (no hay convivencia ni estado pasivo).

## Review Focus

1. **El daemon se reinicia o muere a mitad de una sesión** → el proceso `quorumd attach` termina; el mod debe relanzar `quorumd ensure` + `attach` con backoff (1 s, 2 s, 5 s, 10 s máx) y volver a registrarse, sin perder la sesión. Test en Task 8.
2. **El hub se cae** → el daemon reintenta la conexión con backoff y, al volver, reenvía `MachineHello` con todas las sesiones vivas; la app muestra la máquina "fuera de línea" mientras tanto. Test en Task 6.
3. **Dos dispositivos responden la misma pregunta/permiso**, o el dueño responde en la terminal primero → gana el primero; los demás reciben `ask_resolved` y la tarjeta desaparece. Test en Tasks 7 y 10.
4. **`/clear` o `/resume` cambian el id de sesión sin `session.start`** → el mod adopta el nuevo id (`$.session.id()` tras `session.end` con `reason` `clear`/`resume`) y el hub trata el cambio como la misma tarjeta (campo `previousId`). Test en Task 8.
5. **Ráfaga de texto en streaming** (miles de deltas por segundo) → el mod agrupa deltas cada 150 ms y el hub no persiste deltas, solo el texto final del paso. Test en Tasks 9 y 2.

---

### Task 1: Esqueleto del repo y protocolo compartido

**Files:**
- Create: `go.mod`, `Makefile`, `.gitignore`, `README.md`
- Create: `internal/proto/proto.go`, `internal/proto/tygo.yaml`, `internal/proto/proto_test.go`
- Create: `mod/src/proto.gen.ts`, `app/src/proto.gen.ts` (generados, sí se commitean: son fuente para TS)

**Interfaces:**
- Produces (Go, paquete `proto`; los mismos nombres en TS):
  - `type SessionState string` = `"working" | "needs_you" | "waiting" | "idle" | "closed"`
  - `type Role string` = `"work" | "service"`
  - `type SessionInfo struct { ID, PreviousID, Machine, Name, Cwd, Root, Model string; Role Role; State SessionState; ContextPct int; StartedAt, UpdatedAt int64 }`
  - `type Event struct { Seq int64; Session string; TS int64; Kind EventKind; Data json.RawMessage }` con `EventKind` = `user | assistant_delta | assistant | thinking | tool_start | tool_end | ask | ask_resolved | turn_start | turn_end | status | agent_start | agent_end | info`
  - Datos por tipo: `ToolStart{ID, Name, Summary, Agent string}`, `ToolEnd{ID string; OK bool; MS int64; Output string}`, `Ask{AskID string; Kind string /* permission|question */; Tool, Summary, Detail string; Questions json.RawMessage}`, `AskResolved{AskID, By string /* terminal|device:<id> */}`, `TurnEnd{Answer, Reason string; OutputTokens int}`, `AgentStart{ID, Type, Description string}`, `AgentEnd{ID, Status, Answer string}`
  - Órdenes a una sesión: `type Command struct { Type string /* prompt|decide|abort|close|presence */; Text, Mode /* now|queue|interrupt */, AskID, Decision /* allow|deny */, Reason string; Answers map[string]string; Away, Watching bool }`
  - Envoltorio WS daemon↔hub y hub↔app: `type Envelope struct { Type string; Machine, Session string; Payload json.RawMessage }` con `Type` = `hello | session_upsert | session_gone | event | command | launch | launch_result | machine_status | backfill | watch | ack`
  - `type MachineHello struct { Machine, OS, Env, Version string; Sessions []SessionInfo }` (`Env` = `linux|wsl|windows|darwin`)
  - `type LaunchRequest struct { ReqID, Dir string; Continue bool; PermissionMode string }`, `type LaunchResult struct { ReqID string; OK bool; Error string }`
  - `const Version = "0.1.0"`

- [ ] **Step 1: Inicializar repo Go y Makefile**
  `go mod init github.com/S-kkipie/quorum`. Objetivos del Makefile: `proto` (corre `tygo generate` y copia a `mod/src` y `app/src`), `test` (`go test ./...` + `cd mod && bun test` + `cd app && npx vitest run`), `app` (build Vite → `internal/hub/web/dist`), `build` (`app` + `go build ./cmd/...` con `CGO_ENABLED=0`), `cross` (las 4 plataformas). `.gitignore`: `/bin`, `app/dist`, `app/node_modules`, `mod/node_modules`, `internal/hub/web/dist/*` excepto `index.html`.

- [ ] **Step 2: Escribir test de ida y vuelta JSON**
```go
func TestEnvelopeRoundTrip(t *testing.T) {
    ev := Event{Seq: 1, Session: "s1", TS: 10, Kind: KindToolStart, Data: mustJSON(ToolStart{ID: "t1", Name: "Bash", Summary: "ls"})}
    env := Envelope{Type: "event", Machine: "vps1", Session: "s1", Payload: mustJSON(ev)}
    var back Envelope
    require.NoError(t, json.Unmarshal(mustJSON(env), &back))
    require.Equal(t, env, back)
    require.Contains(t, string(mustJSON(ev)), `"kind":"tool_start"`)
}
```
  Tags JSON en camelCase (`json:"previousId"`, etc.).

- [ ] **Step 3: Correr** `go test ./internal/proto/` → FAIL (tipos sin definir).
- [ ] **Step 4: Implementar los tipos de Interfaces en `proto.go`** y `tygo.yaml` apuntando a `internal/proto` con salida `mod/src/proto.gen.ts`.
- [ ] **Step 5: Correr** `go test ./internal/proto/ && make proto` → PASS y aparecen `mod/src/proto.gen.ts` y `app/src/proto.gen.ts`.
- [ ] **Step 6: Commit** `feat: esqueleto del repo y protocolo compartido`

---

### Task 2: Almacén del hub (SQLite)

**Files:**
- Create: `internal/hub/store/store.go`, `internal/hub/store/migrations.go`, `internal/hub/store/store_test.go`

**Interfaces:**
- Consumes: `proto.SessionInfo`, `proto.Event`
- Produces:
  - `func Open(path string) (*Store, error)` (aplica migraciones; `":memory:"` para tests)
  - `UpsertMachine(name, os, env, version string, online bool) error`, `ListMachines() ([]Machine, error)` con `Machine{Name, OS, Env, Version string; Online bool; LastSeen int64}`
  - `UpsertSession(s proto.SessionInfo) error` (si `PreviousID` != "" renombra la fila previa al nuevo id), `ListSessions(includeClosed bool) ([]proto.SessionInfo, error)`, `MarkMachineSessionsClosed(machine string) error`
  - `AppendEvent(e proto.Event) (int64, error)` → asigna `Seq` creciente por sesión; **ignora** `assistant_delta` (devuelve 0 sin guardar); mantiene como máximo 2000 eventos por sesión.
  - `Events(session string, beforeSeq int64, limit int) ([]proto.Event, error)` (más nuevos primero)
  - Dispositivos y códigos: `CreateCode(kind string /* pair|link */) (string, error)`, `ConsumeCode(kind, code string) error` (error si no existe, usado o vencido), `AddToken(kind /* device|machine */, name, token string) error`, `CheckToken(kind, token string) (name string, ok bool)`, `RevokeToken(kind, name string) error`, `ListDevices() ([]Device, error)`

- [ ] **Step 1: Tests**
```go
func TestDeltasAreNotPersisted(t *testing.T) {
    s := openMem(t)
    seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindAssistantDelta})
    require.NoError(t, err); require.Zero(t, seq)
    evs, _ := s.Events("a", 0, 10); require.Empty(t, evs)
}
func TestEventRetention(t *testing.T) { /* 2100 eventos tool_start → Events devuelve 2000 y el más viejo tiene Seq 101 */ }
func TestSessionRenameOnClear(t *testing.T) { /* Upsert {ID:"old"}, Upsert {ID:"new", PreviousID:"old"} → ListSessions tiene 1 fila con ID "new"; eventos de "old" quedan bajo "new" */ }
func TestCodeSingleUseAndExpiry(t *testing.T) { /* ConsumeCode dos veces → segunda falla; con reloj adelantado 11 min → falla */ }
func TestTokenStoredHashed(t *testing.T) { /* AddToken y luego SELECT crudo de la tabla no contiene el token en claro */ }
```
  El reloj del store es inyectable (`Store.now func() time.Time`).
- [ ] **Step 2: Correr** `go test ./internal/hub/store/` → FAIL.
- [ ] **Step 3: Implementar** con `modernc.org/sqlite`, `PRAGMA journal_mode=WAL`, tablas `machines`, `sessions`, `events(session, seq, ts, kind, data)`, `codes`, `tokens(kind, name, hash)`.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(hub): almacén SQLite`

---

### Task 3: CLI del hub y emparejamiento

**Files:**
- Create: `cmd/quorum-hub/main.go`, `internal/hub/auth.go`, `internal/hub/auth_test.go`, `internal/hub/server.go`

**Interfaces:**
- Consumes: `store.Store`
- Produces:
  - Subcomandos: `quorum-hub serve [--addr 127.0.0.1:7420] [--db PATH]`, `quorum-hub pair` (imprime código de dispositivo), `quorum-hub link-code` (imprime código de máquina), `quorum-hub devices`, `quorum-hub revoke <device|machine> <nombre>`.
  - `func NewServer(st *store.Store) *Server` con `Server.Handler() http.Handler`.
  - `POST /api/pair` body `{code, deviceName}` → `{token}`; `POST /api/link` body `{code, machine}` → `{token}`. Errores: 400 `{"error":"código inválido o vencido"}`.
  - Middleware `requireDevice` (header `Authorization: Bearer <t>` o query `token=` solo para WebSocket) y `requireMachine` (header Bearer).
  - `GET /api/ping` sin auth → `{ok:true, version}`.

- [ ] **Step 1: Tests con `httptest`**: pair con código válido devuelve token que luego pasa `requireDevice`; mismo código otra vez → 400; `/api/sessions` sin token → 401; token de máquina no sirve como token de dispositivo.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.** `pair` y `link-code` abren la misma base que `serve` (WAL permite concurrencia).
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(hub): CLI y emparejamiento de dispositivos y máquinas`

---

### Task 4: API local del daemon y registro de sesiones

**Files:**
- Create: `cmd/quorumd/main.go`, `internal/daemon/config.go`, `internal/daemon/localapi.go`, `internal/daemon/registry.go`, `internal/daemon/localapi_test.go`

**Interfaces:**
- Consumes: `proto.*`
- Produces:
  - `type Config struct { Machine, Hub, MachineToken string; Port int; LocalToken string }` con `LoadConfig() (Config, error)` / `SaveConfig(Config) error` en `~/.config/quorum/daemon.json` (0600). `Machine` por defecto = hostname (+ `-wsl` si corre en WSL).
  - `quorumd ensure --json` → si `GET http://127.0.0.1:<port>/v1/health` responde, imprime `{"ok":true,"port":N,"token":"…","machine":"…","version":"…"}`; si no, lanza `quorumd serve` desacoplado (setsid en Unix, `DETACHED_PROCESS` en Windows), espera hasta 5 s a la salud e imprime lo mismo; si falla, `{"ok":false,"error":"…"}` y código 1.
  - API local (todas con `Authorization: Bearer <LocalToken>` salvo `/v1/health`):
    - `POST /v1/sessions/register` body `proto.SessionInfo` → 204
    - `POST /v1/sessions/{id}/events` body `[]proto.Event` → 204 (el daemon asigna `Session` y `TS` si faltan)
    - `POST /v1/sessions/{id}/gone` → 204
  - `type Registry struct` con `Upsert(proto.SessionInfo)`, `Gone(id string)`, `Snapshot() []proto.SessionInfo`, `Subscribe(id string) (<-chan proto.Command, func())`, `Send(id string, c proto.Command) bool`, y un canal `Out() <-chan proto.Envelope` con todo lo que hay que mandar al hub.

- [ ] **Step 1: Tests**: register + events salen por `Out()` como `session_upsert` y `event` en orden; token incorrecto → 401; `Gone` emite `session_gone`; `Send` a sesión sin suscriptor → false.
- [ ] **Step 2: Correr** `go test ./internal/daemon/` → FAIL.
- [ ] **Step 3: Implementar.** Puerto: el guardado en config si está libre; si no, uno aleatorio que se guarda.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): API local y registro de sesiones`

---

### Task 5: Canal de órdenes al mod (`quorumd attach`)

**Files:**
- Create: `internal/daemon/attach.go`, `internal/daemon/attach_test.go`

**Interfaces:**
- Consumes: `Registry.Subscribe`
- Produces:
  - Endpoint `GET /v1/sessions/{id}/attach` (auth local): respuesta en streaming, una línea JSON `proto.Command` por orden, más una línea `{"type":"ping"}` cada 20 s.
  - Subcomando `quorumd attach --session <id>`: lee la config, abre ese endpoint y copia cada línea a stdout tal cual; sale con código 0 si el servidor cierra y 2 si no puede conectar (el mod reintenta).

- [ ] **Step 1: Test**: con un `Registry` real y `httptest`, un cliente que lee el stream recibe en orden dos `Command` enviados con `Send`; al cancelar el cliente, `Subscribe` se libera (`Send` vuelve a dar false).
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar** con `http.Flusher`; un solo suscriptor por sesión (uno nuevo reemplaza al anterior).
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): canal push de órdenes al mod`

---

### Task 6: Enlace daemon ↔ hub

**Files:**
- Create: `internal/daemon/hublink.go`, `internal/daemon/hublink_test.go`, `internal/hub/machines.go`, `internal/hub/machines_test.go`
- Modify: `cmd/quorumd/main.go` (subcomando `link`)

**Interfaces:**
- Consumes: `Registry.Out()`, `Registry.Send`, `Registry.Snapshot`, `store.*`
- Produces:
  - `quorumd link <hubURL> <código>` → `POST /api/link`, guarda `Hub` y `MachineToken` en la config.
  - Hub: `GET /api/machine/ws` (`requireMachine`), WebSocket. Primer mensaje del daemon: `hello` con `MachineHello`. El hub marca la máquina en línea, hace `UpsertSession` de cada una y marca cerradas las que ya no están. Al cortarse: máquina fuera de línea y sus sesiones `closed`… solo después de 60 s sin reconexión (para no parpadear).
  - Hub: `func (h *Hub) SendToMachine(machine string, env proto.Envelope) bool`.
  - Daemon: `RunHubLink(ctx, cfg, reg)` reconecta con backoff 1 s → 30 s máx; en cada conexión manda `hello` con `Snapshot()`; reenvía `Out()`; los `command` entrantes van a `Registry.Send`.

- [ ] **Step 1: Tests**:
  - `TestHelloRegistersMachineAndSessions` (hub con store en memoria).
  - `TestReconnectResendsSnapshot`: cerrar el servidor WS, volver a levantarlo, el daemon manda un segundo `hello` con las sesiones vivas (Review Focus 2).
  - `TestCommandReachesSession`: el hub hace `SendToMachine(command)` y el `Registry` del daemon lo entrega al suscriptor.
  - `TestOfflineAfterGrace`: con reloj inyectado, a los 59 s la máquina sigue en línea, a los 61 s fuera de línea.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar** con `github.com/coder/websocket` y `wsjson`.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat: enlace daemon-hub con reconexión`

---

### Task 7: API de la app en el hub y difusión en vivo

**Files:**
- Create: `internal/hub/appapi.go`, `internal/hub/live.go`, `internal/hub/appapi_test.go`

**Interfaces:**
- Consumes: `store.*`, `Hub.SendToMachine`
- Produces (todo con `requireDevice`):
  - `GET /api/machines` → `[]Machine`; `GET /api/sessions?closed=1` → `[]proto.SessionInfo`
  - `GET /api/sessions/{id}/events?before=<seq>&limit=<n≤200>` → `[]proto.Event`
  - `POST /api/sessions/{id}/prompt` `{text, mode}`; `/decide` `{askId, decision, answers?, reason?}`; `/abort`; `/close` → 202, o 409 `{"error":"la máquina está fuera de línea"}`
  - `POST /api/sessions/{id}/presence` `{away}` → reenvía `command{type:'presence', away, watching}`.
  - Mientras algún dispositivo tenga abierta una sesión (mensaje `{type:'watch', session}` por `/api/live`, `session:''` al salir), el hub manda `presence{watching:true}` a esa sesión; cuando ya nadie la mira, `watching:false`.
  - `GET /api/live?token=` (WebSocket): manda `machine_status`, `session_upsert`, `session_gone`, `event` (incluye `assistant_delta`) a todos los dispositivos conectados.
  - Primer `decide` gana: el hub recuerda los `askId` abiertos (de eventos `ask`) y los cierra al ver `ask_resolved`; un `decide` sobre un `askId` ya resuelto → 409 `{"error":"ya se respondió"}` (Review Focus 3). El `decide` ganador se reenvía como `command` y el hub emite él mismo `ask_resolved{by:"device:<nombre>"}`.

- [ ] **Step 1: Tests**: un cliente manda `watch` → la sesión recibe `presence{watching:true}`; se desconecta → `watching:false`; prompt a sesión de máquina en línea llega como `command` (mock de `SendToMachine`); máquina fuera de línea → 409; dos `decide` al mismo `askId` → el segundo 409; un cliente `/api/live` recibe un `event` publicado.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(hub): API de la app y difusión en vivo`

---

### Task 8: Mod — conexión, rol y ciclo de vida

**Files:**
- Create: `.claude-plugin/marketplace.json` (fuente `./mod`), `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json` (`{"modules":["./register.ts"]}`), `mod/hooks/register.ts`, `mod/src/link.ts`, `mod/src/role.ts`, `mod/package.json`, `mod/test/link.test.ts`, `mod/test/role.test.ts`

**Interfaces:**
- Consumes: protocolo (`mod/src/proto.gen.ts`), API local (Task 4), `quorumd attach` (Task 5)
- Produces:
  - `detectRole(env: (k: string) => string | undefined): { role: 'work' | 'service' }` → `service` si `CCAPI_SERVER === '1'`.
  - `class Link` con `constructor(io: LinkIO)`, `start(info: SessionInfo): Promise<void>`, `emit(ev: Omit<Event,'seq'|'session'|'ts'>): void`, `onCommand(fn: (c: Command) => void): void`, `adoptId(newId: string): void`, `stop(): void`.
    `LinkIO` abstrae `$`: `{ run(argv): Promise<{exitCode, stdout}>, fetch(url, init): Promise<{status}>, spawn(argv): AsyncIterable<{stream, text}>, sleep(ms): Promise<void> }`.
  - Comportamiento de `Link`: `start` corre `quorumd ensure --json`, registra la sesión y lanza el bucle `attach`; si el hijo termina, reintenta con backoff 1/2/5/10 s y vuelve a registrar (Review Focus 1). `emit` encola y vacía cada 150 ms en un solo `POST …/events` (fusiona `assistant_delta` consecutivos en uno); timeout 2 s, error → descarta. Las líneas del hijo se parten por `\n` aunque lleguen en trozos; `{"type":"ping"}` se ignora.
  - `register.ts`: en `session.start` arma `SessionInfo` (`$.session.id()`, `$.session.cwd()`, `$.session.root()`, `$.session.model()`), llama `detectRole` (`$.env.get`), arranca `Link`, registra el comando `/quorum` (muestra máquina, estado de conexión). En `session.end` con `reason` `clear`/`resume`, a los 300 ms `adoptId(await $.session.id())` y vuelve a registrar con `previousId` (Review Focus 4).

- [ ] **Step 1: Tests (`bun test`) con un `LinkIO` falso**:
  - `role`: `CCAPI_SERVER=1` → service; vacío → work.
  - `link`: 300 `assistant_delta` emitidos en <150 ms generan un solo POST con un único delta concatenado.
  - `link`: el hijo `attach` termina → hay un nuevo `run(['quorumd','ensure','--json'])` y un nuevo register tras 1 s (reloj falso).
  - `link`: una línea JSON partida en dos chunks produce un solo `Command`.
  - `link`: `fetch` que rechaza no lanza excepción hacia afuera.
- [ ] **Step 2: Correr** `cd mod && bun test` → FAIL.
- [ ] **Step 3: Implementar** `role.ts`, `link.ts`, `register.ts`.
- [ ] **Step 4: Correr** → PASS. Además `claude plugin validate ./mod` (o `claude plugin details ./mod`) sin errores.
- [ ] **Step 5: Commit** `feat(mod): conexión con quorumd, rol y ciclo de vida`

---

### Task 9: Mod — eventos de la sesión

**Files:**
- Create: `mod/src/events.ts`, `mod/test/events.test.ts`
- Modify: `mod/hooks/register.ts`

**Interfaces:**
- Consumes: `Link.emit`
- Produces: hooks que emiten:
  - `turn.start` (sin `agentId`) → `turn_start` + `user {text}` + `status {state:'working'}`.
  - `turn.step` → por cada chunk `text`: `assistant_delta {text}`; `thinking`: `thinking {text}` (solo el primer chunk del bloque, para mostrar "pensando"); `tool`: `tool_start {id, name, summary:''}`. Al cerrar el paso, `assistant {text}` con el texto completo del paso si no está vacío. Con `agentId`, los mismos eventos llevan `agent` y no cambian el estado de la sesión.
  - `tool.call` → envuelve `next(e)`: al volver, `tool_end {id: e.tool_use_id, ok: !r.isError, ms, output: recortado a 4000 chars}`; antes, actualiza el `summary` del `tool_start` con `summarize(tool, input)`.
  - `agent.spawn` → `agent_start {id, type, description}`; `turn.complete` con `agentId` → `agent_end {id, status, answer recortado a 2000}`.
  - `turn.complete` sin `agentId` → `turn_end {answer, reason, outputTokens}` + `status {state:'idle'}`; con `reason:'error'` y `answer` vacío, `answer` = "⚠️ Claude devolvió un error (sesión vencida, límite de uso o fallo de la API). Revísalo en la terminal."
  - `contextPct` en `SessionInfo` se actualiza en cada `turn_end` con `$.session.usage()` y se re-registra.
  - `summarize(tool: string, input: unknown): string` → Bash: `command`; Read/Write/Edit: `file_path`; Grep/Glob: `pattern`; WebFetch: `url`; resto: primeras claves en `k=v` hasta 120 chars.
  - En rol `service`, ningún hook de esta task emite nada salvo `status`.

- [ ] **Step 1: Tests** de `summarize` (los 5 casos de arriba) y de un turno simulado: secuencia de llamadas a los manejadores con `Link` falso → lista exacta de `kind` emitidos: `turn_start, user, status, assistant_delta, assistant_delta, tool_start, tool_end, assistant, turn_end, status`.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar** en `events.ts` funciones puras `makeHandlers(link, role)` y cablearlas en `register.ts` (patrón de `turn.step` como generador asíncrono que reenvía cada chunk con `yield`).
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(mod): eventos de turnos, herramientas y subagentes`

---

### Task 10: Mod — órdenes, permisos y preguntas

**Files:**
- Create: `mod/src/control.ts`, `mod/test/control.test.ts`
- Modify: `mod/hooks/register.ts`

**Interfaces:**
- Consumes: `Link.onCommand`, `Link.emit`
- Produces:
  - Órdenes: `prompt` con `mode:'queue'` → `$.prompt.submit({text, asUser:true})`; `'interrupt'` → `$.turn.abort({turnId})` y luego submit; `'now'` → si hay turno en curso, se guarda y se agrega como `context` al resultado del próximo `tool.call` del hilo principal (`{...r, context:[...(r.context ?? []), text]}`); si al terminar el turno quedó sin entregar, se manda con submit. `abort` → `$.turn.abort`. `close` → `TaskStop` de las tareas de fondo conocidas y luego `$.command.run({command:'exit'})`. `presence` → actualiza `away`/`watching`.
  - El texto de un prompt que vino del dispositivo no se re-emite como `user` duplicado (lista `fromDevice` como en v1).
  - `class Asks` con `ask(a: Omit<Ask,'askId'>, waitMs: number): Promise<Decision | undefined>`, `resolve(askId, decision)`, `withdraw(askId)`; emite `ask` + `status{state:'needs_you'}` y, al resolverse por cualquier vía, `ask_resolved {by}` + `status{state:'working'}`.
  - `tool.check` (hilo principal, `decision==='ask'`, tool no está en `AskUserQuestion|ExitPlanMode`): si `away` → `ask(…, 30 min)`; si `watching` → `ask(…, 2 min)`; si no, devuelve el veredicto (terminal). Con decisión: `{decision:'allow', reason:'Permitido desde Quorum'}` o `{decision:'deny', reason: d.reason || 'Denegado desde Quorum'}`. Sin decisión a tiempo → veredicto original (terminal).
  - `tool.call` de `AskUserQuestion` (hilo principal): carrera entre la terminal (`next(e)`) y el dispositivo (`ask(kind:'question', questions)`); si gana la terminal, `withdraw` + `ask_resolved{by:'terminal'}`; si gana el dispositivo, devuelve las respuestas como resultado de la herramienta con el mismo formato que la terminal.
  - En rol `service`, ninguna orden se aplica (se responde con un evento `info` "Sesión de servicio: Quorum no la controla").

- [ ] **Step 1: Tests** con `$` falso:
  - `prompt now` durante un turno → el siguiente `tool.call` devuelve `context` con el texto; no se llama `submit`.
  - `prompt interrupt` → `abort` antes de `submit`.
  - `tool.check` con `away=false, watching=false` → devuelve el veredicto sin emitir `ask`.
  - `tool.check` con `away=true` y `resolve(allow)` → `{decision:'allow'}` y se emite `ask_resolved{by:'device:…'}`.
  - `AskUserQuestion`: la terminal resuelve primero → se emite `ask_resolved{by:'terminal'}` (Review Focus 3).
  - rol `service` + orden `prompt` → no se llama `submit`.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat(mod): prompts, permisos y preguntas desde Quorum`

---

### Task 11: Lanzar sesiones en cualquier máquina

**Files:**
- Create: `internal/daemon/launch/launch.go`, `internal/daemon/launch/launch_test.go`
- Modify: `internal/daemon/hublink.go` (manejar `launch`), `internal/hub/appapi.go` (`POST /api/launch`)

**Interfaces:**
- Consumes: `proto.LaunchRequest`, `proto.LaunchResult`
- Produces:
  - `func Argv(env Env, req proto.LaunchRequest, hasDisplay bool) (bin string, args []string)` con `Env` = `Linux | WSL | Windows | Darwin`. La línea de Claude es `claude` + `--continue` si `Continue` + `--permission-mode <m>` si viene (o `--dangerously-skip-permissions` si `m == "bypass"`), citada para shell.
    - Linux sin pantalla (o siempre en servidores): `tmux new-session -d -s quorum-<base36(now)> -c <dir> bash -lc '<línea>'`.
    - WSL: `wt.exe wsl.exe -d <distro> --cd <dir> -- bash -lic '<línea>'` (distro de `WSL_DISTRO_NAME`).
    - Windows: `wt.exe -d <dir> claude …` con `;` escapado como `\;`.
    - Darwin: `osascript -e 'tell app "Terminal" to do script "cd <dir> && <línea>"'`.
  - `func Run(ctx, req) proto.LaunchResult` (valida que `Dir` existe; error "la carpeta no existe: <dir>").
  - `POST /api/launch` `{machine, dir, continue, permissionMode}` → 202 `{reqId}`; el resultado llega como `launch_result` por `/api/live`.

- [ ] **Step 1: Tests de tabla para `Argv`**: Linux con `Continue` → contiene `bash -lc` y `claude --continue`; nunca contiene una ruta absoluta a `claude`; Windows con `dir` que contiene `;` → escapado; WSL usa `bash -lic` y la distro de la variable; `bypass` → `--dangerously-skip-permissions`. Test de `Run` con carpeta inexistente → `OK:false` y el mensaje exacto.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat: lanzar sesiones en cualquier máquina respetando whoas`

---

### Task 12: Historial desde el transcript

**Files:**
- Create: `internal/daemon/transcript/transcript.go`, `internal/daemon/transcript/transcript_test.go`, `internal/daemon/transcript/testdata/sample.jsonl`
- Modify: `mod/src/link.ts` (incluir `transcriptPath` de `$.session.info()` en el register), `internal/proto/proto.go` (`SessionInfo.TranscriptPath string`), `internal/daemon/hublink.go`, `internal/hub/appapi.go`

**Interfaces:**
- Produces:
  - `func Parse(r io.Reader, limit int) ([]proto.Event, error)`: lee el JSONL de Claude Code y devuelve como máximo los últimos `limit` eventos de tipo `user` (texto del usuario, sin bloques `tool_result`), `assistant` (bloques de texto), `tool_start` (bloques `tool_use`: id, name, summary). Las líneas que no entiende se saltan sin error (el formato es interno).
  - Hub: si `GET /api/sessions/{id}/events` no tiene eventos guardados, pide `{"type":"backfill"}` a la máquina (`Envelope.Type = "backfill"`), el daemon parsea `TranscriptPath` (límite 500) y responde con `event`s que el hub guarda con `Seq` negativos ascendentes (para quedar antes de los eventos en vivo).

- [ ] **Step 1: Test** con `testdata/sample.jsonl` (armado a mano con 1 user, 1 assistant con text + tool_use, 1 user con tool_result, 1 línea basura) → exactamente `[user, assistant, tool_start]` con los textos esperados.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** `feat: historial de sesiones desde el transcript`

---

### Task 13: App — base, emparejamiento y lista de sesiones

**Files:**
- Create: `app/` (Vite React TS + Tailwind v4), `app/src/lib/api.ts`, `app/src/lib/live.ts`, `app/src/lib/store.ts`, `app/src/lib/native.ts`, `app/src/screens/Pair.tsx`, `app/src/screens/Sessions.tsx`, `app/src/App.tsx`, `app/src/lib/store.test.ts`

**Interfaces:**
- Consumes: API de Task 7, `app/src/proto.gen.ts`
- Produces:
  - `api.ts`: `hubUrl()` / `setHub(url, token)` guardados en `localStorage` (la app **no** asume mismo origen: requisito de Tauri); `apiFetch(path, init)`.
  - `live.ts`: `connectLive(onEnvelope)` con reconexión 1 s → 15 s.
  - `store.ts` (reducer puro): `reduce(state: AppState, env: Envelope): AppState`. `AppState = { machines: Record<string, Machine>; sessions: Record<string, SessionInfo>; order: string[]; events: Record<string, Event[]>; live: Record<string, string> /* texto en streaming por sesión */; asks: Record<string, Ask> }`. Reglas: `assistant_delta` concatena en `live[session]`; `assistant` lo vacía y agrega el evento; `ask` agrega a `asks`; `ask_resolved` lo quita; `session_upsert` con `previousId` mueve eventos y posición; `order` agrega las nuevas al final y **nunca reordena por cambio de estado**.
  - PWA: `public/manifest.webmanifest` (nombre "Quorum", `display: standalone`) y un service worker mínimo que solo cachea el shell de la app.
  - `native.ts`: `notify(title, body)` con implementación web (Notification API) por defecto.
  - `Pair.tsx`: campos dirección del hub + código → `POST /api/pair` → guarda token. Error visible "código inválido o vencido".
  - `Sessions.tsx`: sesiones agrupadas por máquina (máquina fuera de línea en gris con "fuera de línea"), estado con color (`working` azul, `needs_you` ámbar, `idle` gris, `closed` atenuada), sesiones `service` en una sección aparte "Servicios" (ej. ccapi).

- [ ] **Step 1: Tests (vitest) del reducer**: deltas concatenados y vaciados por `assistant`; `ask_resolved` quita la tarjeta; cambio de estado no altera `order`; `previousId` conserva la posición.
- [ ] **Step 2: Correr** `cd app && npx vitest run` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS. `npm run build` sin errores.
- [ ] **Step 5: Commit** `feat(app): base, emparejamiento y lista de sesiones`

---

### Task 14: App — chat, prompts, permisos, lanzar; embebido en el hub

**Files:**
- Create: `app/src/screens/Session.tsx`, `app/src/components/Transcript.tsx`, `app/src/components/Composer.tsx`, `app/src/components/AskCard.tsx`, `app/src/components/LaunchDialog.tsx`, `app/src/components/Composer.test.tsx`
- Create: `internal/hub/web/web.go` (`//go:embed all:dist`), `internal/hub/web/dist/index.html` (marcador "Compila la app con `make app`")
- Modify: `internal/hub/server.go` (servir la app en `/` con fallback a `index.html`)

**Interfaces:**
- Consumes: `store.ts`, `api.ts`
- Produces:
  - `Transcript`: eventos en orden con el texto en streaming al final; `tool_start`/`tool_end` como una fila plegable (nombre + summary, detalle con output al tocar); subagentes como filas con su estado; carga hacia atrás con `?before=` al llegar arriba.
  - `Composer`: textarea + tres acciones: "Enviar" (`queue` si la sesión está idle, si no `now`), "En cola" (`queue`), "Interrumpir y enviar" (`interrupt`). Deshabilitado con "Sesión de servicio" o "Sesión pasiva" según el rol.
  - `AskCard`: permiso (herramienta, summary, detalle, botones Permitir/Denegar) o preguntas (opciones de cada pregunta, envío de `answers`); en 409 muestra "ya se respondió" y se cierra.
  - `LaunchDialog`: máquina (solo en línea) + carpeta (texto, con las carpetas de las sesiones conocidas de esa máquina como sugerencias) + "continuar la última conversación" + modo de permisos.
  - Botones en la cabecera de la sesión: Interrumpir, Cerrar (con confirmación) y un interruptor "Fuera" (`POST …/presence`).
  - Al abrir una sesión la app manda `{type:'watch', session}` por `/api/live`, y `session:''` al salir.
  - Layout: en pantallas ≥ 1024 px, lista a la izquierda y sesión a la derecha; en celular, navegación lista → sesión con el botón atrás del navegador.

- [ ] **Step 1: Test (vitest + Testing Library)** del `Composer`: con sesión `working`, "Enviar" llama a `POST …/prompt` con `mode:'now'`; con `idle`, con `mode:'queue'`; con rol `service` el botón está deshabilitado.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar** componentes, embebido y servido.
- [ ] **Step 4: Correr** `make test && make build` → PASS; `./bin/quorum-hub serve` sirve la app en `http://127.0.0.1:7420/`.
- [ ] **Step 5: Commit** `feat(app): chat, prompts, permisos y lanzador`

---

### Task 15: Instalación y prueba de punta a punta

**Files:**
- Create: `scripts/install-hub.sh`, `scripts/install-daemon.sh`, `docs/e2e-etapa1.md`
- Modify: `README.md`

**Interfaces:**
- Produces:
  - `install-hub.sh`: copia `quorum-hub` a `~/.local/bin`, crea la unidad systemd de usuario `quorum-hub.service` (`serve --addr 127.0.0.1:7420`), `loginctl enable-linger`, e imprime cómo publicarlo con `tailscale serve --bg 7420`.
  - `install-daemon.sh`: copia `quorumd` a `~/.local/bin` y agrega el marketplace + plugin: `claude plugin marketplace add S-kkipie/quorum && claude plugin install quorum@quorum`.
  - `docs/e2e-etapa1.md`: lista de verificación manual con resultado esperado en cada paso.

- [ ] **Step 1: Escribir `docs/e2e-etapa1.md`** con estos pasos y su resultado esperado:
  1. Hub en la VPS, `quorum-hub pair` → emparejar el celular → la app muestra "sin máquinas".
  2. `quorumd link` en la PC (WSL) y en una VPS → ambas aparecen en línea.
  3. Abrir `claude` a mano en la PC → la sesión aparece en <2 s con estado "en reposo".
  4. Mandar un prompt desde el celular → streaming visible, herramientas como filas, estado vuelve a "en reposo".
  5. `/quorum` en la terminal → muestra máquina y "conectado".
  6. Activar "fuera" (presence) y pedir algo que requiera permiso → tarjeta en el celular; Permitir → la herramienta corre.
  7. `AskUserQuestion` respondida en la terminal → la tarjeta del celular desaparece.
  8. Matar `quorumd` (`pkill -x quorumd`) → en ≤10 s la sesión vuelve a estar conectada.
  9. Detener el hub 30 s y levantarlo → todo vuelve sin cerrar sesiones.
  10. Lanzar una sesión en la VPS desde la app → aparece; `tmux ls` muestra `quorum-…`; `whoas which claude` en esa carpeta coincide con la cuenta de la sesión.
  11. Con ccapi corriendo → aparece en "Servicios" y el Composer está deshabilitado.
  12. (No aplica: pastor retirado.)
  13. `/clear` en una sesión → la tarjeta conserva su lugar y el chat sigue.
  14. Cerrar la sesión desde la app → desaparece y el proceso termina.
- [ ] **Step 2: Escribir los scripts y el README** (instalar, emparejar, enlazar, seguridad: solo tailnet).
- [ ] **Step 3: Correr** `make test && make cross` → PASS y 4 pares de binarios en `bin/`.
- [ ] **Step 4: Ejecutar la lista e2e** en la PC + una VPS y anotar el resultado de cada paso en el mismo documento.
- [ ] **Step 5: Commit** `docs: instalación y verificación de punta a punta de la etapa 1`
