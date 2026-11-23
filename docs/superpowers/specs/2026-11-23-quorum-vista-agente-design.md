# Quorum — vista del agente y artifacts locales (celular primero)

Fecha: 2026-11-23 · Estado: borrador para aprobación · Complementa `2026-11-22-quorum-design.md` y `2026-11-23-quorum-herdr-sesiones-design.md`

## 1. Qué y por qué

La vista de una sesión (el chat con Claude) es fea y cuesta leerla en el celular:
- las respuestas salen en texto plano, sin formato;
- cada herramienta es una línea gris apretada;
- no se entiende de un vistazo qué hizo Claude;
- no hay artifacts.

El dueño quiere, en este orden:
1. **Leer la respuesta** bien, con formato.
2. **Ver artifacts locales**, como en pastor: páginas o archivos que Claude crea en el disco de la máquina, abiertos en el celular. Nunca los artifacts de claude.ai. No se le prohíbe nada a Claude: él decide; Quorum solo muestra lo local.
3. **Entender rápido qué hace Claude**: skills, búsqueda web, lecturas, ediciones, comandos y subagentes, contados en lenguaje claro.

Además, los artifacts que hoy hace Claude suelen ser feos. El plugin de Quorum trae una skill propia, **solo para artifacts**, para que salgan bonitos y pensados para el celular. Va en el plugin y no instalada global, para no chocar con las otras skills de diseño de apps del dueño.

Después de esto vienen Tauri y la app Android (otro diseño).

## 2. Objetivos

- **G1. Línea de tiempo (dirección B, elegida por el dueño).** Cada acción de Claude es una fila corta con un ícono SVG y una frase clara. **Todo cerrado por defecto**; un toque abre el detalle.
- **G2. Respuestas con formato:** markdown con títulos, listas, código, tablas y enlaces.
- **G3. Artifacts locales:**
  - una tarjeta en el chat cuando Claude crea un archivo visible;
  - "Abrir" lo muestra a pantalla completa;
  - un HTML carga sus CSS e imágenes de su carpeta.
- **G4. Cabecera con estado:** Trabajando / Esperándote / Necesita permiso / Inactiva / Cerrada, más el nombre (recap), la máquina y la rama. "Interrumpir" solo aparece mientras trabaja; "Cerrar" pasa al menú ⋯.
- **G5. Skill de artifacts en el plugin de Quorum:** guía de diseño para páginas locales que se verán en el celular.

## 3. No-objetivos

- Editar archivos desde el celular, explorador de archivos, git en la app.
- Ver el navegador en vivo de agent-browser (pastor lo tenía; queda para después).
- Detectar archivos que Claude crea por `Bash` (solo `Write` y `Edit`).
- Tauri / APK (siguiente diseño).

## 4. Anti-objetivos

- Emojis como íconos (el dueño los rechazó): solo íconos SVG.
- Que una respuesta o un artifact puedan leer el token del dispositivo o ejecutar algo con permisos de la app.
- Que Quorum sirva cualquier archivo del disco: solo los de la carpeta de una sesión de esa máquina.
- Que la skill de artifacts se active para trabajo que no es un artifact (por ejemplo, diseñar la UI de una app).
- Bloquear el `Artifact` de claude.ai o cualquier herramienta.

## 5. Restricciones

- Hoy el mod manda en `tool_start` solo `summary` (una línea, máx. 120). `tool_end.output` va recortado a 4000.
- El historial rellenado desde el transcript (daemon `transcript.Parse`) tampoco trae la entrada de la herramienta.
- El canal hub↔daemon es el WebSocket con RPC (Plan 3). Un mensaje mide como mucho 8 MiB, y la RPC espera 10 s.
- La app es React 19 + Tailwind v4, sin librerías de UI. Celular primero.
- El repo es público: nada de nombres internos.

## 6. Enfoques

| Enfoque | Resumen | Veredicto |
|---|---|---|
| **Línea de tiempo B, expandible, con datos ricos del mod y archivos servidos por el hub** ✅ | El mod manda la entrada de cada herramienta, recortada. La app arma filas por tipo. El hub trae los archivos de la máquina por RPC en trozos y los sirve con un enlace temporal | La única forma razonable: los servidores no son alcanzables desde el celular, y sin la entrada de la herramienta no hay diffs ni búsquedas |
| A. Respuesta primero, actividad agrupada | Bloques resumidos ("Exploró el código · 6 archivos") | El dueño eligió B |
| Celular directo a la máquina | El daemon sirve los archivos por HTTP | Las máquinas no son alcanzables desde el celular; el hub ya hace de puente |
| Skill `frontend-design` instalada global | Se activaría para todo diseño | El dueño la rechazó: choca con sus otras skills; mejor una skill propia solo para artifacts |

## 7. Diseño

### 7.1 Datos de las herramientas (mod, daemon, proto)
- Comandos, ediciones y contenido escrito (recortados) llegan al hub y se guardan con los eventos, igual que hoy el `summary` y la salida. Quorum es de un solo dueño, así que no hay redacción de secretos *(decisión del autor del diseño)*.
- `proto.ToolStart` gana `Input json.RawMessage "input"`: la entrada de la herramienta como objeto JSON, **recortada**.
  - Cada string queda en ≤ 2000 runas.
  - Los arrays quedan en ≤ 50 elementos.
  - El total va ≤ 16 KiB. Si se pasa, solo se guardan las claves conocidas de esa herramienta (tabla 7.2).
  - El `summary` actual se mantiene, como respaldo y para clientes viejos.
- Mod (`mod/src/events.ts`): emite `input` recortado en `tool_start`. Se sube a `TOOL_OUTPUT_MAX` 8000 para ver la salida de comandos y búsquedas.
- Daemon (`internal/daemon/transcript`): el historial rellenado también trae `input`, con el mismo recorte (función Go equivalente).
- Versión del plugin: 0.1.3.

### 7.2 Filas de la línea de tiempo (app)
Cada herramienta es una fila. Las llamadas seguidas a `Read` se juntan en una sola fila ("Leyó X y N más") que se abre en la lista.

| Herramienta | Fila (cerrada) | Al abrir |
|---|---|---|
| Read (agrupable) | Leyó `archivo` y N más | lista de rutas |
| Grep / Glob | Buscó `patrón` en el código | salida |
| Edit / MultiEdit | Editó `archivo` +A −B | diff (old→new) |
| Write | Creó `archivo` (y tarjeta de artifact si es visible) | contenido (recortado) |
| Bash | `comando` + ✓/✗ | salida |
| WebSearch | Buscó "consulta" | resultados (salida) |
| WebFetch | Leyó `dominio` | URL + salida |
| Skill | Usó la skill **nombre** | argumentos |
| Agent / Task | Subagente: descripción · estado | su respuesta |
| TodoWrite | Actualizó el plan (N tareas, M hechas) | lista de tareas con estado |
| mcp__x__y | Usó `y` (de `x`) | entrada + salida |
| otra | nombre + summary | entrada + salida |

- Íconos SVG de `lucide-react`, uno por tipo. En curso: un spinner; error: en rojo; denegado: "denegado".
- Las filas de un subagente van con sangría bajo su fila de Agent.
- "fin del turno · N tokens" desaparece. El turno se separa con un espacio y, como mucho, con la hora.
- Mensaje del usuario: burbuja a la derecha. Respuesta de Claude: markdown a todo el ancho.
- Las preguntas y los permisos siguen como tarjetas fijas sobre la caja de texto, ya rediseñadas con el mismo estilo.

### 7.3 Markdown
- `react-markdown` + `remark-gfm`, **sin HTML crudo**.
- Los enlaces abren en una pestaña nueva con `rel="noopener noreferrer"`.
- Los bloques de código tienen botón de copiar y scroll horizontal; no llevan resaltado de sintaxis (queda para después).
- Las tablas tienen scroll horizontal.

### 7.4 Artifacts locales
- **Archivos visibles:** los que terminan en `.html .htm .md .svg .png .jpg .jpeg .gif .webp .pdf`.
- **Detección (app):**
  - Muestran una **tarjeta "Abrir"** (nombre, máquina, carpeta), después de su fila:
    - un `Write` con éxito de un archivo visible;
    - un `Edit` con éxito de un `.html`, `.htm` o `.svg`.
  - Un `Edit` de `.md` o de una imagen **no** lleva tarjeta. Editar `README.md` mientras se programa no debe llenar el chat. Su fila abierta muestra un enlace "Abrir".
  - Si el mismo archivo se escribe varias veces, se muestra una sola tarjeta, en su última posición.
  - Archivo fuera de la `root` y del `cwd` de la sesión (por ejemplo `/tmp/x.html`): la tarjeta sale sin "Abrir", con el texto "fuera de la carpeta del proyecto". La app conoce `root` y `cwd` por `SessionInfo`.
  - *(Decisión del autor del diseño, tras la revisión.)*
- **Enlace (hub):** `POST /api/machines/{m}/views {sessionId, path}` → `{url}`.
  - El hub busca la sesión y comprueba que `path` (absoluto) esté **dentro de la `root` de esa sesión**, o del `cwd` si no hay `root`. Esa carpeta es la **base**.
  - Crea un token aleatorio de 128 bits, válido 6 h, atado a `{machine, base}`.
  - Devuelve `/v/<token>/<ruta del archivo relativa a la base>`. Así los enlaces relativos del HTML (`img/a.png`, `../assets/x.css`) funcionan mientras no salgan de la base.
- **Servir (hub):** `GET /v/<token>/<ruta relativa a la base…>`.
  - No necesita el token del dispositivo, porque el token del enlace es la autorización; así lo puede cargar un iframe.
  - Resuelve dentro de la base y rechaza las rutas que salen de ella. El daemon vuelve a comprobarlo; las dos capas cuentan.
  - `Access-Control-Allow-Origin: *`, para que la página aislada (origen opaco) pueda hacer `fetch` de sus datos y cargar fuentes de su carpeta. Hace falta el token igual.
  - Trae el archivo por RPC `file_read {path, base, offset, length}` en trozos de 1 MiB, hasta 50 MiB, y lo manda al navegador a medida que llega.
  - Content-Type según la extensión.
  - Cabeceras:
    - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'`. Origen opaco: el HTML no puede leer el `localStorage` de la app.
    - `X-Content-Type-Options: nosniff`.
    - `Cache-Control: no-store`.
  - Un token vencido da 410 con una página corta que dice "Ábrelo de nuevo desde Quorum".
- **Daemon, `file_read`:**
  - Params `{path, base, offset, length}`. `EvalSymlinks` del path y de la base; el path debe quedar dentro de la base; debe ser un archivo regular de ≤ 50 MiB.
  - Devuelve `{data: base64, size, eof}`.
  - No depende del interruptor de terminal ni de herdr: es solo lectura.
- **Visor (app):** pantalla completa con cabecera (✕, nombre, máquina, carpeta) y los botones recargar y abrir en pestaña nueva.
  - HTML y SVG: `<iframe sandbox="allow-scripts allow-popups allow-forms allow-modals">`.
  - Markdown: se trae el texto y se dibuja con el mismo render de 7.3.
  - Imágenes: `<img>` con zoom.
  - PDF: `<iframe>` (visor del navegador) y un botón "abrir en pestaña nueva".

### 7.5 Cabecera de la sesión
- Fila 1: ‹ · nombre (recap) · pastilla de estado · ⋯.
- Fila 2: máquina · modelo · rama (sin ruta completa).
- Pastillas:
  - `working`: azul con punto animado, "Trabajando";
  - `needs_you`: ámbar, "Necesita permiso";
  - `waiting` / `idle`: gris, "Esperándote";
  - `closed`: "Cerrada".
- "Interrumpir" es un botón visible solo en `working`. El menú ⋯ tiene "Cerrar sesión", "Nueva sesión aquí" y "Ver en terminal".

### 7.6 Skill de artifacts en el plugin
- `mod/skills/artefactos-locales/SKILL.md`. La `description` restringe el uso a crear **una página o documento para que el dueño lo vea** (reporte, explicación, comparación, diagrama, resumen visual, presentación). La misma `description` dice explícitamente que **no** es para diseñar la UI de una app ni componentes del proyecto.
- El contenido de la skill indica cómo hacer la página:
  - **Archivo:** un solo `.html` autocontenido, con CSS y JS en línea; sin CDNs ni fuentes remotas (debe funcionar sin red y en un iframe aislado); imágenes en línea (data URI/SVG) o en la misma carpeta.
  - **Pantalla:** diseño para 390 px de ancho primero, que también escale a escritorio; modo oscuro con `prefers-color-scheme`.
  - **Estética y legibilidad:** tipografía y paleta con intención; tablas legibles en el celular; nada de "look de IA genérico".
  - **Dónde guardarlo:** en `<raíz del proyecto>/.claude/quorum/artefactos/<nombre-claro>.html`, salvo que el usuario pida otra ruta. La respuesta final menciona la ruta.
- La guía de estética se adapta de `frontend-design` (anthropics/skills, Apache-2.0), con atribución en el archivo. Queda **acotada a artifacts**.
- Quorum no bloquea nada: si Claude decide usar otra cosa, la usa.

## 8. Lo que queda al constructor
- Diseño visual fino de cada fila y del visor, dentro del estilo actual (zinc oscuro).
- El recorte exacto de `input` por herramienta, respetando los límites de 7.1.
- Cómo se juntan las lecturas seguidas (ventana, cortes por otra herramienta).
- Si el diff se calcula por líneas (old/new de Edit) con una librería chica o con un diff propio de líneas.
