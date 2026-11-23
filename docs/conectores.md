# Conectores de tickets

Cada proyecto de Quorum trae sus tickets de un gestor mediante un conector. Los tipos son
`github`, `paperclip`, `exec` y `none`. El conector `exec` sirve para cualquier gestor propio:
es un script que habla JSON por stdin/stdout.

## Configuración

En el proyecto: `kind = "exec"` y `settings.command` con el comando, separado por espacios y
sin shell (p. ej. `/home/yo/bin/mi-conector.sh` o `python3 /ruta/conector.py`). Opcional:
`settings.statusMap`, un objeto JSON con estados propios (`{"waiting":"bloqueado"}`). El resto de
`settings` se pasa tal cual al script. El token del proyecto (si lo hay) llega en el campo `token`.

Si el trabajo (workspace) tiene perfil whoas, el script recibe `WHOAS_PROFILE` en su entorno,
además del entorno del hub. Cada sincronización se hace cada `intervalMin` minutos (5 por defecto,
de 1 a 60) o al instante con `POST /api/projects/{id}/sync`.

Cambiar el origen del conector (el `kind` o `repo`, `baseURL`, `companyId`, `projectId`, `command`)
borra los tickets del proyecto con sus vínculos a sesiones, deja como fallidas ("el conector cambió") las
propuestas pendientes y vuelve a importar todo desde el origen nuevo. Cambiar solo el intervalo, el
`statusMap` u otras opciones conserva los tickets.

## Abrir una sesión desde un ticket

El prompt de la sesión nueva lleva los datos del ticket entre marcas y precedidos de un aviso: vienen de
una ticketera externa y se tratan como información, no como instrucciones. Si el prompt es largo, el
daemon lo escribe en `<carpeta>/.claude/quorum/ticket-<id>.md` (0600; se borran a las 24 h) dentro del
checkout, para que claude lo lea sin pedir permiso fuera de su carpeta. Quorum no toca tu `.gitignore`:
añade `.claude/quorum/` si no quieres verlos como ficheros sin seguimiento.

## Protocolo

El hub ejecuta el comando una vez por operación y escribe una línea JSON en stdin:

```json
{"op":"list|comment|set_status","since":0,"externalId":"A-1","body":"texto","status":"hecho","settings":{},"token":""}
```

- `list`: `since` es la última sincronización correcta en ms (0 si no hay). Responde
  `{"tickets":[{"externalId":"A-1","title":"…","rawStatus":"open","assignee":"","url":"","body":"","comments":[{"author":"","body":"","at":0}],"updatedAt":0}]}`.
  `externalId` es obligatorio. El estado crudo va en `rawStatus` y el hub lo normaliza.
  `updatedAt` y el `at` de los comentarios son **epoch en milisegundos** (p. ej. `1764000000000`;
  en bash, `$(date +%s)000`). Un valor que no parece ms reales (0, 1, 2… o segundos) se trata como
  fecha desconocida: para el avance cuenta como reciente y no se usa para "Sin actividad desde".
- `comment`: usa `externalId` y `body`. Responde `{"ok":true}`.
- `set_status`: usa `externalId` y `status` ya normalizado. Responde `{"ok":true}`.

Errores: código de salida distinto de 0, o `{"error":"mensaje"}`. El stderr se añade al error
(500 caracteres como máximo). Límites: 30 s de tiempo y 8 MiB de stdout.

No dejes procesos hijos en segundo plano que conserven el stdout abierto: el hub espera a que
se cierre (con un margen de 2 s tras terminar el script). Al agotarse el tiempo se mata el
grupo de procesos entero en Linux y macOS. El hub quita el token de los mensajes de error, pero
no imprimas el stdin completo (p. ej. con `set -x`).

## Estados

Normalizados: `por_hacer`, `en_curso`, `en_review`, `hecho`, `bloqueado`. Por defecto:
open/todo/backlog → por_hacer; in progress/doing → en_curso; review/in review → en_review;
closed/done/resolved → hecho; blocked → bloqueado. Primero se mira `statusMap` (las claves no distinguen mayúsculas y tratan `_` y `-` como espacio); lo desconocido
es `por_hacer`.

## Ejemplo en bash

```bash
#!/bin/bash
# Conector de ejemplo: dos tickets fijos; comment/set_status se anotan en $LOG.
LOG=${LOG:-/tmp/mi-conector.log}
in=$(cat)
op=$(printf '%s' "$in" | sed -n 's/.*"op":"\([a-z_]*\)".*/\1/p')
now=$(date +%s)000   # epoch en ms
case "$op" in
  list)
    printf '%s\n' '{"tickets":['
    printf '%s\n' '{"externalId":"1","title":"Arreglar login","rawStatus":"open","updatedAt":'"$now"'},'
    printf '%s\n' '{"externalId":"2","title":"Escribir docs","rawStatus":"in progress","assignee":"ana","updatedAt":'"$now"'}'
    printf '%s\n' ']}'
    ;;
  comment|set_status)
    printf '%s\n' "$in" >> "$LOG"
    printf '%s\n' '{"ok":true}'
    ;;
  *)
    echo "operación desconocida: $op" >&2
    exit 1
    ;;
esac
```

Con `jq` se lee mejor cada campo: `op=$(jq -r .op <<<"$in")`. Hay otro script de pruebas en
`internal/hub/connectors/testdata/fake-connector.sh`.

## Conector GitHub

`kind = "github"` trae los issues de un repositorio con la CLI `gh`. Fuera de Windows se lanza por un
shell de login (`bash -lc 'exec gh "$@"' gh <args>`, los argumentos nunca se interpolan) para que los
shims de whoas apliquen también con el hub bajo systemd; en Windows se ejecuta `gh` del PATH. El log del
hub dice una vez por dónde se resolvió. La cuenta la elige whoas mediante `WHOAS_PROFILE` del workspace.

Settings:

- `repo`: `owner/nombre` (obligatorio).
- `labelsAsStatus`: `true` para leer el estado de las labels. Con el issue abierto, `en curso`/`in progress`
  da en_curso, `review`/`in review` en_review y `blocked`/`bloqueado` bloqueado (sin distinguir mayúsculas).
  `rawStatus` es `open` o `open:<label>`; los cerrados son hecho. Sin la opción, solo cuenta open/closed.

Los pull requests se ignoran. De cada issue abierto se traen los últimos 5 comentarios (como máximo 30
issues con comentarios por sincronización). Cambiar el estado desde Quorum cierra o reabre el issue; para
en_curso, en_review y bloqueado añade la label `en curso`, `review` o `blocked`. Errores: credenciales
inválidas (HTTP 401), repositorio no encontrado (HTTP 404) o `gh` ausente.

Notas del conector GitHub: la primera sincronización trae solo los issues abiertos; las siguientes traen
los cambiados desde la última (abiertos y cerrados). Los comentarios se piden completos y se guardan los 5
más recientes. Un issue transferido a otro repositorio deja de aparecer y se queda como estaba en Quorum.
Cambiar el estado quita las otras labels de estado (`en curso`, `review`, `blocked`).

## Conector Paperclip

`kind = "paperclip"` trae los issues de una company de tu instancia de Paperclip por su API REST
(`GET <baseURL>/api/companies/<companyId>/issues`). El token del proyecto se envía como
`Authorization: Bearer <token>`. Usa un token de board o de agente con acceso de lectura; Quorum solo
escribe (comentarios y cambios de estado) a través de propuestas aprobadas.

Settings:

- `baseURL`: URL de la instancia, `http` o `https` (obligatorio).
- `companyId`: id de la company (obligatorio).
- `projectId`: opcional; solo se importan los issues de ese proyecto de Paperclip (el filtro es local). Los issues ocultos se omiten.

Estados: todo/backlog → por_hacer; in_progress → en_curso; in_review → en_review; blocked → bloqueado;
done/cancelled → hecho. Al cambiar el estado desde Quorum se envía `todo`, `in_progress`, `in_review`,
`blocked` o `done` (`PATCH /api/issues/<id>`). Los comentarios se publican con
`POST /api/issues/<id>/comments`. De cada issue no terminado se traen los últimos 5 comentarios (máximo 30
issues por sincronización). Si el issue tiene `identifier` (p. ej. ACME-12) el título lleva el prefijo
`[ACME-12]`. Cada petición tiene 15 s de límite y 8 MiB de respuesta; las redirecciones a otro host no se siguen.
Errores: token inválido (401/403), no encontrado (404) u otro HTTP con el cuerpo recortado.
