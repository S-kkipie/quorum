# Quorum — Plan 4: vista del agente y artifacts locales

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la vista de una sesión en el celular sea fácil de leer y de entender:
- respuestas con formato;
- una línea de tiempo expandible de lo que hace Claude, con íconos SVG;
- artifacts locales que se abren a pantalla completa;
- una skill del plugin para que esos artifacts salgan bonitos.

**Architecture:**
- El mod manda la entrada de cada herramienta, recortada (`ToolStart.Input`), y el historial del transcript hace lo mismo. Con eso la app arma una fila clara por acción.
- El hub sirve archivos de la máquina por un RPC `file_read` en trozos, detrás de un enlace temporal `/v/<token>/…`. El HTML va aislado por CSP sandbox.
- La skill `artefactos-locales` vive dentro del plugin de Quorum.

**Tech Stack:** el de los Planes 1–3. Dependencias nuevas en la app, solo estas: `react-markdown`, `remark-gfm` y `lucide-react`.

**Spec:** `docs/superpowers/specs/2026-11-23-quorum-vista-agente-design.md`

## Global Constraints

- **Ya vigentes:** todo lo de los Planes 1–3 (textos en español, repo público sin nombres internos, commits con autor `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`).
- **Íconos:** solo SVG de `lucide-react`, **nunca emojis**, en ningún texto ni ícono de la UI nueva.
- **Recorte de `Input`:**
  - cada string ≤ 2000 runas;
  - arrays ≤ 50 elementos;
  - total serializado ≤ 16 KiB;
  - si el total se pasa, solo quedan las claves de la tabla de la Task 1 (cada una recortada).
- **Salida y versión del mod:** `TOOL_OUTPUT_MAX` (mod) = 8000. Versión del plugin `0.1.3`.
- **Archivos visibles:** `.html .htm .md .svg .png .jpg .jpeg .gif .webp .pdf`.
  - Llevan tarjeta: `Write` con éxito de cualquiera de ellos; `Edit` o `MultiEdit` con éxito solo de `.html .htm .svg`.
  - Un archivo fuera de la base de la sesión lleva tarjeta sin "Abrir", con el texto `fuera de la carpeta del proyecto`.
- **Base de la sesión:** `root` si no está vacía; si no, `cwd`.
- **Enlaces `/v/`:**
  - token aleatorio de 128 bits (hex de 32 caracteres), TTL 6 h, atado a `{machine, base}`;
  - archivos ≤ 50 MiB, leídos en trozos de 1 MiB;
  - token vencido o desconocido → 410 con el texto `Ábrelo de nuevo desde Quorum`.
- **Cabeceras de `/v/`:**
  - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store`
  - `Access-Control-Allow-Origin: *`
- **Iframe del visor:** `sandbox="allow-scripts allow-popups allow-forms allow-modals"`, nunca `allow-same-origin`.
- **Markdown:** `react-markdown` + `remark-gfm`, sin `rehype-raw` (sin HTML crudo). Enlaces con `target="_blank" rel="noopener noreferrer"`. Solo se permiten URLs `http:`, `https:` y `mailto:`; cualquier otra queda como texto.
- **Pastillas de estado:**
  - `working` → "Trabajando", azul con punto animado;
  - `needs_you` → "Necesita permiso", ámbar;
  - `waiting` y `idle` → "Esperándote", gris;
  - `closed` → "Cerrada".
- **Cabecera:**
  - "Interrumpir" visible solo en `working`;
  - el menú ⋯ tiene "Cerrar sesión", "Nueva sesión aquí" y "Ver en terminal" (esta última según las reglas actuales);
  - la fila 2 dice `máquina · modelo · rama`, sin la ruta.
- **Fin de turno:** se elimina la fila "fin del turno · N tokens".

## Review Focus

1. **Una herramienta con entrada enorme** (un `Write` de 2 MB, un `Bash` con un heredoc gigante) → el evento sale recortado (≤ 16 KiB de `input`) y la app no se traba. Tests en las Tasks 1 y 2.
2. **Ruta que intenta salir de la base** (`../../etc/passwd`, `%2e%2e/`, un symlink dentro de la base que apunta afuera) → 403 en el hub y rechazo en el daemon. Tests en las Tasks 3 y 4.
3. **Un HTML de un artifact que intenta leer el token o la app** (`localStorage`, `parent.document`) → no puede: va con la cabecera CSP sandbox y el iframe sin `allow-same-origin`. Tests de cabeceras en la Task 4 y del atributo en la Task 8.
4. **Eventos viejos sin `input`** (sesiones de antes de la actualización, historial previo) → la fila usa `summary` y sigue clara, sin romper. Test en la Task 6.
5. **Markdown malicioso o raro** (`<script>`, `[x](javascript:alert(1))`, una tabla de 30 columnas) → no se ejecuta, el enlace queda como texto y la tabla scrollea. Test en la Task 5.

---

### Task 1: `ToolStart.Input` desde el mod

**Files:**
- Modify: `internal/proto/proto.go` (+ `make proto`), `mod/src/events.ts`, `mod/.claude-plugin/plugin.json`
- Create: `mod/src/trim.ts`
- Test: `mod/test/trim.test.ts`, `mod/test/events.test.ts`

**Interfaces — Produces:**
- `proto.ToolStart.Input json.RawMessage "input,omitempty"`. Sale en TS como `input?: any`.
- `trimInput(tool: string, input: unknown): Record<string, unknown>` en `mod/src/trim.ts`:
  - quita las claves internas `tool`, `tool_use_id` y `agentId`;
  - aplica los recortes de Global Constraints.
- Tabla de claves que se conservan cuando el total se pasa de 16 KiB:

  | Herramienta | Claves |
  |---|---|
  | Bash | `command`, `description` |
  | Read | `file_path`, `offset`, `limit` |
  | Write | `file_path`, `content` |
  | Edit | `file_path`, `old_string`, `new_string`, `replace_all` |
  | MultiEdit | `file_path`, `edits` |
  | Grep | `pattern`, `path`, `glob` |
  | Glob | `pattern`, `path` |
  | WebSearch | `query` |
  | WebFetch | `url`, `prompt` |
  | Skill | `skill`, `args` |
  | Agent / Task | `description`, `subagent_type`, `prompt` |
  | TodoWrite | `todos` |

  Cualquier otra herramienta conserva las 8 primeras claves.
- `tool_start` emite `{id, name, summary, input: trimInput(...)}`. `TOOL_OUTPUT_MAX` pasa a 8000. El plugin pasa a `0.1.3`.

- [ ] **Step 1: Tests que fallan.**
  - `trimInput recorta strings a 2000 runas`, incluido un string con emojis: cuenta runas, no unidades UTF-16.
  - `trimInput deja 50 elementos de un array`.
  - `trimInput de un Write de 2 MB queda en ≤ 16384 bytes serializado y conserva file_path`.
  - `trimInput quita tool, tool_use_id y agentId`.
  - `tool_start lleva input` (events.test).
- [ ] **Step 2:** `claude plugin test mod`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. Correr `make proto`.
- [ ] **Step 4:** `claude plugin test mod && make typecheck && go test ./internal/...`. Esperado: PASS.
- [ ] **Step 5:** Commit `mod: la entrada de cada herramienta, recortada, en tool_start`.

### Task 2: `Input` en el historial del transcript (daemon)

**Files:**
- Modify: `internal/daemon/transcript/transcript.go`
- Create: `internal/daemon/transcript/trim.go`
- Test: `internal/daemon/transcript/trim_test.go`, `transcript_test.go`

**Interfaces:**
- Consumes: `proto.ToolStart.Input` (Task 1).
- Produces: `func TrimInput(tool string, input json.RawMessage) json.RawMessage`, con las mismas reglas y la misma tabla que `trimInput` del mod (Task 1). `parseLine` la usa en cada `tool_use`.

- [ ] **Step 1: Tests que fallan.**
  - `TestTrimInputMatchesModRules`: strings, arrays, un total grande con la tabla, y runas (emojis).
  - `TestParseToolUseCarriesInput`: una línea `tool_use` de `Edit` produce un `ToolStart` con `Input.file_path`, `old_string` y `new_string`.
- [ ] **Step 2:** `go test ./internal/daemon/transcript/`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `go test ./internal/daemon/...`. Esperado: PASS.
- [ ] **Step 5:** Commit `daemon: el historial trae la entrada recortada de cada herramienta`.

### Task 3: Daemon — RPC `file_read`

**Files:**
- Create: `internal/daemon/fileread.go`
- Modify: `internal/daemon/rpc.go` (registrar el método)
- Test: `internal/daemon/fileread_test.go`

**Interfaces:**
- Consumes: `rpcHandlers` y `Host` (Plan 3).
- Produces: método `file_read`.
  - Params `{path, base string; offset int64; length int}`.
  - Resultado `{data string (base64); size int64; eof bool}`.
- Reglas:
  - `path` y `base` deben ser absolutos.
  - A los dos se les aplica `filepath.EvalSymlinks`, y el path resuelto debe quedar dentro de la base resuelta (`filepath.Rel` sin `..`).
  - Debe ser un archivo regular de ≤ 50 MiB.
  - `length` se acota a 1 MiB; un `length` ≤ 0 vale 1 MiB.
  - No depende de herdr ni del interruptor de terminal.
- Errores en español:
  - `"fuera de la carpeta del proyecto"`;
  - `"no existe"`;
  - `"no es un archivo"`;
  - `"archivo demasiado grande"`.

- [ ] **Step 1: Tests que fallan** (todos en `t.TempDir()`):
  - `TestFileReadChunks`: un archivo de 2.5 MiB se lee en 3 trozos y la concatenación es igual al original.
  - `TestFileReadRejectsTraversal`: `base/../secret` da `"fuera de la carpeta del proyecto"`.
  - `TestFileReadRejectsSymlinkOut`: un symlink dentro de la base que apunta afuera es rechazado.
  - `TestFileReadTooBig`: con el límite como variable de test.
  - `TestFileReadNotRegular`: un directorio da `"no es un archivo"`.
- [ ] **Step 2:** `go test ./internal/daemon/ -run FileRead`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `go test ./internal/daemon/...`. Esperado: PASS.
- [ ] **Step 5:** Commit `daemon: file_read para artifacts locales`.

### Task 4: Hub — enlaces de vista y `/v/`

**Files:**
- Create: `internal/hub/views.go`
- Modify: `internal/hub/appapi.go` (rutas)
- Test: `internal/hub/views_test.go`

**Interfaces:**
- Consumes: `h.call(ctx, machine, "file_read", params, &out)` (Plan 3) y `s.st.Session(id)`.
- Produces:
  - `POST /api/machines/{m}/views` (dispositivo) con body `{sessionId, path}`. Responde `{url}`, con `url = "/v/" + token + "/" + rel`, donde `rel` va codificado por segmentos.
    - Errores: sesión inexistente o de otra máquina → 404 `"sesión no encontrada"`; `path` no absoluto o fuera de la base → 403 `"fuera de la carpeta del proyecto"`.
    - Para comparar rutas, usar la normalización de `normRoot` del hub, con pliegue de mayúsculas según el OS de la máquina.
  - `GET /v/{token}/{rest...}` sin auth de dispositivo:
    - Resuelve `base + rest`, después de `path.Clean`. Si sale de la base → 403.
    - Trae el archivo por `file_read` en trozos y escribe cada trozo según llega (`http.Flusher`).
    - `Content-Type` por extensión, con `text/plain; charset=utf-8` para `.md`.
    - Errores del daemon: `"no existe"` → 404; `"fuera…"` → 403; máquina offline → 503.
  - Tokens en un mapa en memoria con barrido de vencidos. Un reinicio del hub los invalida y da 410.
  - Registrar `/v/` en el mux antes de `"/"`.

- [ ] **Step 1: Tests que fallan.** Usar la máquina falsa con RPC de los tests de `terminalapi_test.go`.
  - `TestViewLinkAndServe`: la respuesta trae las cuatro cabeceras de Global Constraints, el body completo de un archivo de 2 trozos y el Content-Type de `.html`.
  - `TestViewRelativeAsset`: con un token de `docs/r.html`, pedir `/v/<t>/img/a.png` resuelve `base/img/a.png`.
  - `TestViewTraversal403`: `/v/<t>/../../x` y `%2e%2e` dan 403.
  - `TestViewOutsideBase403`: el POST con un path fuera de `root` da 403.
  - `TestViewExpired410`: con el reloj inyectable.
  - `TestViewNeedsNoDeviceToken`: el GET funciona sin `Authorization` y el POST sin él da 401.
- [ ] **Step 2:** `go test ./internal/hub/ -run View`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `go test ./internal/hub/...`. Esperado: PASS.
- [ ] **Step 5:** Commit `hub: enlaces /v/ para ver artifacts locales`.

### Task 5: App — Markdown e íconos

**Files:**
- Modify: `app/package.json` (agregar `react-markdown`, `remark-gfm` y `lucide-react` con `npm install`)
- Create: `app/src/components/Markdown.tsx`
- Test: `app/src/components/Markdown.test.tsx`

**Interfaces — Produces:** `<Markdown text={string} />`.
- Usa `react-markdown` + `remark-gfm` sin HTML crudo, con `urlTransform` que deja solo `http`, `https` y `mailto`.
- Los enlaces llevan `target="_blank" rel="noopener noreferrer"`.
- Los bloques `pre` llevan un botón "Copiar" (ícono `Copy` de lucide; `navigator.clipboard.writeText`) y `overflow-x-auto`.
- Las tablas van envueltas en un `div` con `overflow-x-auto`.
- Estilos Tailwind para h1–h4, listas, `code` en línea y citas, dentro del tema zinc oscuro.

- [ ] **Step 1: Tests que fallan.**
  - `renders headings, lists and gfm tables`.
  - `does not render raw <script> or <img onerror>`: el texto queda escapado y no hay elemento `script`.
  - `javascript: link is not a link`.
  - `code block has copy button that writes to clipboard`.
- [ ] **Step 2:** `cd app && npx vitest run src/components/Markdown.test.tsx`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Esperado: PASS.
- [ ] **Step 5:** Commit `app: markdown seguro y lucide-react`.

### Task 6: App — modelo de la línea de tiempo

**Files:**
- Create: `app/src/lib/timeline.ts`
- Modify: `app/src/components/Transcript.tsx` (solo para usar el modelo; las vistas van en la Task 7)
- Test: `app/src/lib/timeline.test.ts`

**Interfaces — Produces:**
- `type Item`:
  - `{t:'user'|'assistant'|'info'; seq; text; agent?}`;
  - `{t:'tool'; seq; id; name; kind: ToolKind; title: string; detail?: string; input?: any; output?: string; state:'running'|'ok'|'error'|'denied'; ms?; agent?; file?: string; diff?: {add:number; del:number}}`;
  - `{t:'reads'; seq; files: string[]; state; agent?}`;
  - `{t:'agent'; …}` (como la actual);
  - `{t:'artifact'; seq; path: string; name: string; inBase: boolean}`.
- `type ToolKind = 'read'|'search'|'edit'|'write'|'bash'|'web_search'|'web_fetch'|'skill'|'agent'|'todo'|'mcp'|'other'`.
- `buildTimeline(events: Event[], base: string): Item[]`:
  - empareja `tool_start` con `tool_end`;
  - junta `Read`s **seguidos** (sin otro ítem en medio, mismo `agent`) en un solo `reads`;
  - crea los `artifact` según las reglas de Global Constraints, sin duplicados: el último gana y la tarjeta anterior se quita;
  - ya no produce `turn_end`.
- Títulos en español, que la Task 7 usa tal cual:
  - read: `Leyó <basename>` / `Leyó <basename> y N más`;
  - search: `Buscó <patrón>`;
  - edit: `Editó <basename>`, con `diff` por líneas de old/new;
  - write: `Creó <basename>`;
  - bash: el `description` si existe; si no, el comando (primera línea);
  - web_search: `Buscó "<query>"`;
  - web_fetch: `Leyó <host>`;
  - skill: `Usó la skill <nombre tras ':'>`;
  - agent: `Subagente: <description>`;
  - todo: `Actualizó el plan (<n> tareas, <m> hechas)`;
  - mcp: `Usó <tool> (<server>)`;
  - other: `<name>`.
- Estados: `denied` si el output coincide con `/deneg|denied|rechaz/i` y `ok` es false.
- `diffLines(a, b): {add, del}`: diff por líneas basado en LCS (sin dependencia).
- `inBase(path, base)`: prefijo con separador; vale false si `base` está vacía.

- [ ] **Step 1: Tests que fallan.**
  - `groups consecutive reads`, `does not group reads across a bash`.
  - `edit item has file and diff counts`, `write of html creates one artifact; second write moves it`.
  - `edit of md creates no artifact; edit of html does`.
  - `artifact outside base has inBase false`.
  - `old event without input falls back to summary for title` (Review Focus 4).
  - `denied state from output`.
  - `todo title counts`.
  - `no turn_end items`.
- [ ] **Step 2:** `cd app && npx vitest run src/lib/timeline.test.ts`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `cd app && npx vitest run`. Esperado: PASS; actualizar los tests de Transcript que dependían de `buildRows`.
- [ ] **Step 5:** Commit `app: modelo de la línea de tiempo del agente`.

### Task 7: App — vistas de la línea de tiempo y cabecera

**Files:**
- Create: `app/src/components/timeline/ToolItem.tsx`, `app/src/components/timeline/ArtifactCard.tsx`, `app/src/components/StatePill.tsx`
- Modify: `app/src/components/Transcript.tsx`, `app/src/screens/Session.tsx`, `app/src/components/AskCard.tsx`, `app/src/components/Composer.tsx`
- Test: `app/src/components/timeline/ToolItem.test.tsx`, `app/src/screens/Session.test.tsx`, `app/src/components/Transcript.test.tsx`

**Interfaces:**
- Consumes: `buildTimeline` y `Item` (Task 6); `Markdown` (Task 5).
- Produces:
  - `<ToolItem item />`: fila cerrada por defecto (ícono lucide por `kind`, título, ✓/✗/spinner como íconos). Al tocar se abre, según el tipo:
    - read: lista de rutas;
    - edit: diff old/new en líneas `-`/`+` coloreadas, a partir de `input`;
    - write: contenido recortado;
    - bash, web_search, web_fetch, mcp, other: la salida, y en mcp y other también la entrada como JSON;
    - skill: los argumentos;
    - agent: la respuesta;
    - todo: la lista con el estado de cada tarea.
  - En un edit de `.md` o de imagen, la fila abierta lleva un enlace "Abrir" (`onOpenFile(path)`).
  - `<ArtifactCard item onOpen(path) />`:
    - nombre, máquina y carpeta (dirname relativo a la base);
    - botón "Abrir";
    - sin base, sale sin botón y con el texto `fuera de la carpeta del proyecto`.
  - `<StatePill state />`, según Global Constraints.
  - En la cabecera de `Session.tsx`:
    - la fila 1 lleva ‹, título, `StatePill` y ⋯;
    - la fila 2 lleva `máquina · modelo · rama`;
    - "Interrumpir" solo en `working`;
    - el menú ⋯ suma "Cerrar sesión", con `confirm`, a lo que ya tenía.
  - Los mensajes del usuario van en burbuja a la derecha; las respuestas, con `<Markdown>` a todo el ancho.
  - `AskCard` y `Composer` se reestilan con los mismos radios y colores, y llevan íconos lucide. No cambia su comportamiento.
  - `Transcript` recibe `onOpenFile(path)` y lo pasa a las tarjetas.

- [ ] **Step 1: Tests que fallan.**
  - `tool row is collapsed by default and expands on tap`.
  - `edit row shows -/+ lines when expanded`.
  - `running tool shows spinner icon, no emoji`: no contiene caracteres de rango emoji.
  - `artifact card outside base has no Abrir`.
  - `Session header: Interrumpir only when working`, `menu has Cerrar sesión`, `subtitle has no cwd path`.
  - `assistant text renders markdown heading`.
- [ ] **Step 2:** `cd app && npx vitest run`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Esperado: PASS.
- [ ] **Step 5:** Commit `app: línea de tiempo expandible, cabecera con estado y markdown`.

### Task 8: App — visor de artifacts

**Files:**
- Create: `app/src/screens/Viewer.tsx`
- Modify: `app/src/lib/api.ts`, `app/src/App.tsx`, `app/src/screens/Session.tsx`
- Test: `app/src/screens/Viewer.test.tsx`, `app/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `POST /api/machines/{m}/views` (Task 4); `onOpenFile` (Task 7).
- Produces:
  - `api.createView(machine, sessionId, path): Promise<{url}>`.
  - Navegación nueva `viewer: {machine, sessionId, path}` en App, con pantalla completa en el celular y el área principal en escritorio.
  - `Viewer`:
    - pide el enlace al montar;
    - cabecera con ✕ (volver), nombre, `máquina · carpeta`, recargar y "abrir en pestaña nueva" (`window.open(hubUrl()+url, '_blank', 'noopener')`).
  - Cuerpo del `Viewer` por extensión:
    - `.html`, `.htm`, `.svg`: `<iframe src={hubUrl()+url} sandbox="allow-scripts allow-popups allow-forms allow-modals">`;
    - `.md`: `fetch(hubUrl()+url)` y después `<Markdown>`;
    - imágenes: `<img>` con zoom (botones +/−) y scroll;
    - `.pdf`: `<iframe>` sin sandbox (el visor de PDF del navegador lo necesita; un PDF no ejecuta código de la app) y un botón "abrir en pestaña nueva".
  - Si falla, muestra el error del hub, por ejemplo `fuera de la carpeta del proyecto`, con "Volver".

- [ ] **Step 1: Tests que fallan.**
  - `html viewer iframe has sandbox without allow-same-origin` (Review Focus 3).
  - `md viewer renders markdown from fetched text`.
  - `image viewer zoom buttons`.
  - `error from createView is shown`.
  - `createView posts sessionId and path`.
- [ ] **Step 2:** `cd app && npx vitest run`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Esperado: PASS.
- [ ] **Step 5:** Commit `app: visor de artifacts locales`.

### Task 9: Skill `artefactos-locales` en el plugin

**Files:**
- Create: `mod/skills/artefactos-locales/SKILL.md`
- Modify: `README.md` (una línea en la sección del plugin)

**Interfaces — Produces:** una skill del plugin `quorum` (carpeta `skills/` en la raíz del plugin).
- Frontmatter `name: artefactos-locales`. La `description` dice:
  - que sirve **solo** para crear una página o documento para que el usuario lo vea (reporte, explicación, comparación, diagrama, resumen visual, presentación);
  - que **no** es para diseñar la UI de una app, componentes ni páginas del proyecto.
- El cuerpo, en español, dice exactamente esto:
  1. Un solo `.html` autocontenido, con CSS y JS en línea, sin CDNs ni fuentes remotas; imágenes como SVG en línea o data URI.
  2. Pensado primero para 390 px de ancho y que escale a escritorio; modo oscuro con `prefers-color-scheme`.
  3. Estética con intención: tipografía y paleta elegidas, jerarquía clara, tablas legibles en el celular, sin "look de IA genérico".
  4. Guardarlo en `<raíz del proyecto>/.claude/quorum/artefactos/<nombre-claro>.html`, salvo que el usuario pida otra ruta, y mencionar la ruta en la respuesta final.
  5. Revisar el resultado leyendo el archivo antes de terminar.
- La guía de estética se adapta de `frontend-design` (anthropics/skills). Al pie va: `Adaptado de anthropics/skills (frontend-design), Apache-2.0`.
- No menciona ni prohíbe otras herramientas.

- [ ] **Step 1:** Verificar que Claude Code carga la skill: `claude plugin validate mod` si existe; si no, `claude --plugin-dir ./mod -p "lista tus skills" --tools ""` con `QUORUM_DISABLE=1`. Es una sola llamada barata. Esperado: aparece `artefactos-locales`.
- [ ] **Step 2:** `claude plugin test mod`. Esperado: PASS (sin cambios de código).
- [ ] **Step 3:** Commit `plugin: skill artefactos-locales`.

### Task 10: Despliegue y e2e desde el celular

**Files:**
- Create: `docs/e2e-plan4.md` (saneado)

- [ ] **Step 1:** `make test && make cross`. Esperado: PASS.
- [ ] **Step 2: Subir y desplegar.**
  - Subir a GitHub; el dueño ya lo aprobó para este flujo.
  - Actualizar `quorum-hub` y `quorumd` en la .83 y `quorumd` en esta PC.
  - Correr `claude plugin marketplace update quorum && claude plugin update quorum@quorum` en las dos máquinas.
- [ ] **Step 3: e2e con `abw`** en un viewport de 390×844, con un dispositivo de prueba que se revoca al final.
  1. Una sesión nueva en esta PC con el prompt "Lee README.md, busca en la web 'herdr terminal', y hazme un artefacto local con un resumen". Debe:
     - mostrar las filas cerradas con íconos, sin emojis;
     - abrir cada fila con un toque;
     - verse la respuesta con markdown;
     - mostrar la tarjeta "Abrir", que abre el HTML a pantalla completa;
     - haber usado `artefactos-locales` (fila "Usó la skill artefactos-locales").
  2. Un `Edit` de un archivo muestra el diff al abrir su fila.
  3. Con la sesión abierta en el celular, desde DevTools o la consola, el iframe del artifact no puede leer `localStorage` de la app.

  Limpieza: cerrar la sesión (su pestaña se cierra sola) y borrar el artifact de prueba.
- [ ] **Step 4:** Commit de `docs/e2e-plan4.md` y subirlo.
