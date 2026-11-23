# Quorum — diseño

Fecha: 2026-11-22 · Estado: borrador para aprobación · Reemplaza a pastor (v1)

## 1. Qué es y por qué

Quorum es el **centro de mando personal** de una sola persona que tiene ~4 trabajos y, en uno de ellos, mantiene muchos proyectos. El trabajo lo hacen sesiones de Claude Code repartidas en varias máquinas (VPS dedicadas, un servidor, laptop, PC con WSL), a veces varias sesiones del mismo proyecto en máquinas distintas.

**El dolor de hoy no es manejar sesiones, es manejar proyectos.** Cada proyecto tiene su contexto, sus features y su propia ticketera, y para saber cómo va algo hay que preguntar: "¿en qué estado está tal ticket?", "¿cómo vamos con el proyecto?". Quorum tiene que tener eso **ya armado**, sin preguntar, y además permitir **dirigir las sesiones remotamente** desde el celular o la compu.

pastor (github.com/S-kkipie/pastor) fue la v1: control remoto de Claude Code desde el móvil (mod + bridge + hub + PWA + agente WhatsApp). Funcionó, pero se escribió en 4 días y se rehace desde cero con otra unidad central (el proyecto, no la sesión) y una arquitectura limpia.

### Quién lo usa
Solo el dueño. Nadie más (clientes, jefes, equipo) ve nada. No hay usuarios, roles ni multi-tenant.

## 2. Objetivos

1. **Proyectos primero.** Jerarquía: Trabajo → Proyecto → (Tickets, Sesiones). El tablero principal muestra todos los proyectos con su avance y un resumen corto de "en qué va y qué lo frena".
2. **Estado sin preguntar.** Cada ticket muestra el estado de su ticketera combinado con el de la sesión que lo trabaja (trabajando / te necesita / terminado / esperando review). Cada proyecto tiene un resumen de 1–2 líneas que se actualiza solo.
3. **Ticketeras genéricas.** Un modelo de ticket propio y conectores. Conectar una ticketera custom debe ser fácil (minutos, o pedírselo a una sesión de Claude).
4. **Control remoto propio** (sin el Remote Control nativo de Claude): ver todas las sesiones de todas las máquinas, abrir sesiones nuevas en cualquier máquina/proyecto (también desde un ticket), mandar prompts (ahora / en cola / interrumpir), responder permisos y `AskUserQuestion`, cerrar sesiones.
5. **Chat en vivo** con cada sesión: streaming de texto, herramientas, subagentes y tareas de fondo.
6. **Terminal remota** en cualquier máquina.
7. **Comunicación entre sesiones** entre máquinas, con la misma forma que la mensajería nativa de Claude Code.
8. **Celular y compu por igual:** una app web adaptable — vista ancha multi-panel en escritorio, vista de pulgar en el celular, instalable como PWA.
9. **Liviano:** los procesos que corren siempre (hub y agente por máquina) deben gastar poca RAM y compilar sin reventar la memoria.

## 2b. Entrega por etapas (decidido por el dueño)

- **Etapa 1 — lo central:** trabajos, proyectos, tickets (conectores GitHub, Paperclip y ejecutable), estado y resúmenes, sesiones de todas las máquinas, abrir/cerrar sesiones, chat en vivo, prompts (ahora/cola/interrumpir), permisos y preguntas. Compatibilidad con whoas y ccapi (§14b) desde esta etapa.
- **Etapa 2:** terminal remota y comunicación entre sesiones de distintas máquinas.
- **Después:** el roadmap (§16), empezando por las apps Tauri.

**Convivencia con pastor:** pastor queda retirado; no hay convivencia.

## 3. No-objetivos (por ahora, van al roadmap)

- Git en la app (diff por archivo, commit, push/pull, PR).
- Explorador de archivos, web en desarrollo por la tailnet, navegador en vivo.
- Rutinas programadas.
- Agente general por WhatsApp.
- Apps nativas (escritorio y APK con Tauri): van justo después de la primera versión (ver §7.2b).

## 4. Anti-objetivos (si pasa esto, fracasó aunque "funcione")

- **Que tengas que seguir preguntando** a las sesiones en qué va cada cosa.
- **Que sea un sistema de agentes autónomos** (estilo Paperclip: organigrama, heartbeats, agentes que corren solos). Las sesiones las diriges tú; Quorum informa y facilita.
- **Raspar la terminal** (tmux/screen scraping estilo Collie). Se usan eventos reales.
- **Depender del Remote Control nativo** o de los servidores de Anthropic para el control.
- **Un monolito** como el `bridge.mjs` de 136 KB de v1.
- **Polling** como mecanismo principal (v1 hacía poll cada 1 s / 250 ms).
- Mascotas, animaciones y adornos que no hacen al problema (Clawd queda fuera).

## 5. Restricciones

- Una sola persona, todo dentro de la tailnet (Tailscale/Headscale). Nunca expuesto a internet (`funnel` prohibido).
- Máquinas: Linux (VPS, servidor), WSL2 y Windows nativo (lanzar sesiones en Windows Terminal), posible macOS. Las VPS no tienen pantalla: sesiones en tmux.
- Claude Code con suscripción; la **cuota es compartida** entre todo (otros servicios del dueño). Lo que Quorum gaste en modelo (resúmenes) debe ser mínimo y con Haiku.
- La API de mods de Claude Code es early-access y puede cambiar entre versiones.
- RAM limitada en las máquinas (en particular las VPS chicas y la PC con WSL).

## 6. Enfoques considerados

| Enfoque | Cómo se conecta a cada sesión | A favor | En contra |
|---|---|---|---|
| **A. Mod + agente por máquina + hub** ✅ | Un mod dentro de cada sesión emite eventos reales y recibe prompts/decisiones | Ve y controla **cualquier** sesión, incluso las abiertas a mano; se puede seguir la misma sesión en la PC y en el celular a la vez | Depende de la API de mods (early-access) |
| B. SDK / headless (`stream-json`) | El daemon lanza y posee los procesos | API más estable, control total | Las sesiones abiertas a mano no existen para Quorum; no se puede usar la terminal de la misma sesión a la vez. Va contra cómo trabaja el dueño |
| C. Leer la terminal (tmux) | Scraping | — | Frágil, sin eventos reales; descartado desde v1 |

**Elegido: A.** Para acotar el riesgo de la API de mods, el mod es un paquete chico y tonto (traduce eventos ↔ protocolo) y toda la lógica vive en el agente y el hub.

## 7. Arquitectura

```
 📱 / 💻  App Quorum (PWA, React)
        │  WebSocket + HTTP (tailnet)
        ▼
 ┌──────────────────────┐      conectores ──▶ GitHub · Paperclip · ticketeras custom
 │  quorum-hub (Go)    │      resumidor  ──▶ claude -p (Haiku)
 │  SQLite · sirve app  │
 └──────────────────────┘
        ▲  WebSocket (cada máquina se conecta saliente al hub)
        │
 ┌──────┴──────────┐   ┌─────────────────┐   ┌─────────────────┐
 │ quorumd (Go)   │   │ quorumd · VPS2 │   │ quorumd · PC   │
 │ VPS1            │   │                 │   │ (WSL / Windows) │
 └──────┬──────────┘   └─────────────────┘   └─────────────────┘
        │ socket local (unix / named pipe)
   ┌────┴─────┐
   │ sesión   │ … cada sesión de Claude Code carga quorum-mod (TS)
   │ + mod    │
   └──────────┘
```

### 7.1 Piezas

| Pieza | Lenguaje | Dónde corre | Responsabilidad |
|---|---|---|---|
| `quorum-mod` | TypeScript (lo exige Claude Code) | Dentro de cada sesión | Emitir eventos de la sesión (registro, prompts, texto en streaming, herramientas, permisos, preguntas, subagentes, tareas de fondo, uso de contexto, fin de turno, cierre). Recibir y aplicar: prompts (ahora/cola/interrumpir), decisiones de permiso/pregunta, interrupción, cierre, mensajes de otras sesiones. Nada de lógica de negocio. |
| `quorumd` | Go | Un proceso por máquina (servicio systemd de usuario / tarea de Windows) | Agrupa las sesiones locales, mantiene una conexión saliente persistente al hub, lanza sesiones (tmux / Windows Terminal / WSL), da PTYs para la terminal remota, entrega mensajes entre sesiones, informa repos/proyectos locales y estado de la máquina. Se reconecta solo. |
| `quorum-hub` | Go | VPS siempre encendida | Fuente de verdad: trabajos, proyectos, tickets, sesiones, máquinas, dispositivos. Conectores de ticketeras, resumidor, emparejamiento de dispositivos, enrutamiento de mensajes entre máquinas, sirve la app y su API. |
| `app` | React + Vite + Tailwind (TS) | Navegador (PWA) | UI adaptable escritorio/celular. Se compila y se embebe en el binario del hub. |
| `protocol` | Esquema compartido | — | Definición única de mensajes mod↔daemon↔hub↔app. Tipos Go y TS se generan de ahí (evita los contratos duplicados de v1). |

### 7.2 Por qué Go para hub y daemon (decisión del autor del diseño)
El dueño pidió rendimiento y ser amigable con la RAM, también al compilar; mencionó Rust o Go. Go: daemons de ~10–30 MB residentes, compilación rápida y de poca memoria, binario estático único, cross-compile trivial a linux/windows/darwin. Rust rendiría algo más pero sus compilaciones son pesadas en RAM. SQLite en Go **sin cgo** (p. ej. `modernc.org/sqlite`) para que el cross-compile siga siendo trivial.

### 7.2b Interfaz: un frontend, tres salidas (decisión del autor del diseño, a pedido del dueño)
El dueño sugirió Tauri para tener web, escritorio y APK desde un mismo código. Decisión:
- **Un único frontend React** que el hub sirve como web/PWA (primera versión).
- **Tauri v2 como envoltura fina** del mismo frontend para escritorio (Windows/macOS/Linux) y Android: aporta notificaciones nativas, bandeja y APK. Sin lógica de negocio en Rust.
- **Los builds de Tauri corren en CI (GitHub Actions)**, no en las máquinas del dueño: la compilación de Rust es pesada en RAM.
- Requisito desde el día uno: el frontend no asume que corre en el mismo origen que el hub (la URL del hub es configurable y se guarda en el dispositivo) y no usa APIs que fallen en un webview de Tauri. Las capacidades nativas se acceden detrás de una capa pequeña (`native`) con implementación web por defecto.

### 7.3 Conexiones
- **mod → daemon:** socket local (unix socket en Linux/mac/WSL, named pipe en Windows), restringido al usuario del SO. Si el daemon no está corriendo, el mod lo arranca (como v1 hacía con el bridge).
- **daemon → hub:** WebSocket saliente sobre la tailnet, autenticado con un token de máquina obtenido al enlazar (`quorumd link <hub> <código>`). Como la conexión es saliente, el hub no necesita alcanzar a cada máquina.
- **app → hub:** HTTP + WebSocket, con token por dispositivo obtenido emparejando con un código de un solo uso.
- **Todo es push.** Nada de polling salvo la sincronización de ticketeras (ver §9).

### 7.4 Funcionamiento sin hub
Si el hub cae, las sesiones siguen funcionando normal (el mod nunca bloquea a Claude Code esperando al daemon o al hub). Cuando el hub vuelve, los daemons se reconectan y reenvían el estado actual.

## 8. Modelo de datos (hub)

- **Trabajo** (workspace): nombre, color. Agrupa proyectos. Ej: "Cliente X", "ACME".
- **Proyecto:** trabajo, nombre, repo remoto (si hay), conector de ticketera + su configuración, resumen actual, avance.
- **Checkout:** un proyecto en una máquina concreta (máquina, ruta, rama actual). Un proyecto puede tener varios checkouts en varias máquinas. Las sesiones se asocian a su proyecto por el checkout donde corren (ruta raíz git → checkout → proyecto). Los checkouts se descubren solos (cada daemon informa los repos donde hubo sesiones) y se asignan a un proyecto con un toque (o automáticamente por URL del remoto git).
- **Ticket:** proyecto, id externo, título, estado (normalizado: `por_hacer | en_curso | en_review | hecho | bloqueado` + el estado original), descripción, asignado, comentarios recientes, URL, actualizado.
- **Sesión:** máquina, checkout, id de sesión de Claude Code, nombre, estado en vivo (`trabajando | te_necesita | esperando | en_reposo | cerrada`), ticket asociado (opcional), modelo, uso de contexto, último turno.
- **Máquina:** nombre, SO, en línea/fuera de línea, versión del daemon.
- **Dispositivo:** teléfono/navegador emparejado, token, último uso.
- **Evento de sesión:** el historial que alimenta el chat (texto, herramientas, permisos, etc.). El transcript real sigue siendo el de Claude Code; el hub guarda lo necesario para mostrar y resumir, con retención limitada.

## 9. Ticketeras

### 9.1 Conectores
Interfaz común: `listar(proyecto, desde)`, `obtener(id)`, `cambiar_estado(id, estado)`, `comentar(id, texto)`, y un mapa de estados externos → normalizados.

- **GitHub Issues** (incluido): usa `gh` / API de GitHub con el login existente.
- **Paperclip** (incluido): API REST de la instancia en la VPS (`/api/companies/{id}/issues`), para ver lo de ACME como un proyecto más sin migrar nada.
- **Conector ejecutable (genérico):** cualquier programa que hable JSON por stdin/stdout con la interfaz de arriba. Es el camino para ticketeras custom: un script de 50 líneas en el lenguaje que sea, o se le pide a una sesión de Claude que lo escriba a partir de la doc de la ticketera. Vive en el hub, se configura por proyecto.
- Jira/Linear quedan como conectores ejecutables de ejemplo o integrados más adelante.

### 9.2 Sincronización
- Poll por proyecto cada N minutos (configurable, default 5) más refresco manual. Webhooks después.
- Quorum **no** es dueño de los tickets: la ticketera manda. Quorum solo escribe cuando el dueño lo pide (o una sesión, al terminar un ticket, comenta / mueve estado — opcional por proyecto).
- **Un ticket, una sesión activa a la vez** (idea tomada de Paperclip): al abrir una sesión desde un ticket que ya tiene una sesión viva, se ofrece ir a esa en vez de abrir otra.

### 9.2b Asociar sesión ↔ ticket (decisión del autor del diseño)
- Si la sesión se abrió desde un ticket, queda asociada.
- Si se abrió a mano, Quorum **sugiere** el ticket por nombre de rama (`feat/41-…`, `GH-41`) o mensajes de commit, y el dueño confirma con un toque en la app. Nunca se asocia en silencio.
- Claude también puede declararlo con un comando del mod (p. ej. `/quorum ticket 41`).
- El dueño puede asociar o desasociar a mano en cualquier momento.

### 9.2c Escritura en la ticketera (decisión del autor del diseño)
En la primera versión Quorum **nunca escribe solo** en una ticketera: propone el comentario o el cambio de estado (p. ej. al terminar una sesión asociada) y el dueño lo aprueba en la app. Motivo: las ticketeras de clientes son visibles para terceros.
"Esperando tu review" = la ticketera dice `en_review`, **o** la sesión asociada terminó su turno y el dueño la marcó como lista.

### 9.2d De dónde salen trabajos y proyectos (decisión del autor del diseño)
Quorum sugiere proyectos a partir de los repos donde hubo sesiones (por URL del remoto git) y de lo que exponen los conectores (repos de GitHub, empresas de Paperclip). El dueño acepta la sugerencia o crea el proyecto a mano. Los trabajos se crean a mano (son pocos).

### 9.3 Abrir sesión desde un ticket
Elegir máquina + checkout (o clonar si esa máquina no tiene el repo — roadmap), y la sesión arranca con el ticket como primer mensaje (título, descripción, comentarios relevantes, URL). El dueño sigue dirigiendo desde ahí.

## 10. Estado y resúmenes

- **Resumen por turno:** es el último mensaje de Claude del turno, recortado. No gasta modelo. (Decisión del autor del diseño.)
- **Estado de ticket mostrado** = estado normalizado de la ticketera + estado de la sesión asociada (si hay). Ej: "en curso · sesión vps-2 · trabajando hace 12 min", "listo, esperando tu review".
- **Resumen de proyecto:** 1–2 líneas ("en qué va y qué lo frena") generadas por el hub con **Haiku** (vía ccapi si está disponible, si no `claude -p`; ver §14b), a partir de: tickets y sus cambios, resúmenes de fin de turno de las sesiones del proyecto, actividad reciente. Se regenera con debounce (p. ej. como máximo cada 30 min por proyecto y solo si hubo cambios). "Sin actividad desde X" no gasta modelo.
- **Avance:** tickets hechos / total del período o hito activo (lo define el conector; si no hay hito, abiertos vs. cerrados recientes).

## 11. Control remoto y chat

Hereda lo que funcionó en v1, reimplementado:
- **Panel de sesiones** dentro de cada proyecto y una vista global por máquina. Estados en vivo; el orden no salta cuando cambia el estado.
- **Nueva sesión:** máquina + checkout (o carpeta), continuar última conversación opcional, modo de permisos.
- **Prompts mientras trabaja:** enviar ahora (mismo turno), en cola (al terminar), interrumpir y enviar.
- **Permisos y preguntas:** se enrutan según dónde está el dueño (lógica híbrida de v1: si la sesión está abierta en un dispositivo o se usó uno hace poco, va al dispositivo; si escribió en la terminal hace poco, va a la terminal). Con modo "fuera" explícito. Sin respuesta en el dispositivo en X minutos, se resuelve en la terminal.
- **Chat en vivo:** texto en streaming, herramientas resumidas con detalle al tocar, plan de tareas, uso de contexto, resumen por turno, subagentes y tareas de fondo (ver, escribirles, detenerlos).
- **Cerrar sesión** (como `/exit`, deteniendo antes tareas de fondo).
- **Vista multi-sesión** en escritorio (mosaico, como Mission control de v1).
- **Historial previo:** al abrir una sesión que empezó antes de que el hub la viera (hub caído, o sesión anterior a instalar Quorum), el daemon reconstruye el chat leyendo el transcript de Claude Code (como hacía v1). El parser va aislado porque el formato es interno y puede cambiar. (Decisión del autor del diseño.)
- **PC con WSL:** Windows y WSL2 son entornos distintos (un unix socket de WSL no habla con un named pipe de Windows), así que cada uno corre su propio `quorumd`. En la app se agrupan como **una PC con dos entornos**. (Decisión del autor del diseño.)
- **Lanzadores por plataforma** aislados en un módulo del daemon: tmux (servidores sin pantalla, con `bash -lc` para PATH/nvm), Windows Terminal (`wt.exe`, con escape de `;`), WSL desde Windows.

## 12. Terminal remota
PTY real por el daemon (no comandos sueltos): `xterm.js` en la app ↔ WebSocket ↔ hub ↔ daemon ↔ PTY. Varias terminales por máquina; se puede abrir en la carpeta de un checkout.

## 13. Comunicación entre sesiones
- **Misma máquina:** la nativa de Claude Code (sockets por sesión, `SendMessage`/`ListAgents`) funciona sola; Quorum no la toca.
- **Entre máquinas:** la nativa solo funciona vía Remote Control, que no se usa. El mod expone las sesiones de otras máquinas como destinos y entrega sus mensajes como mensajes de otra sesión (envoltorio claramente marcado como "no es tu usuario", como hacía v1 con `<pastor-message>`). El hub enruta daemon→daemon. Con freno anti-bucles.
- Los mensajes nunca aprueban permisos ni ejecutan comandos (misma regla que la nativa).

## 14. Seguridad
Quorum da control remoto total de las máquinas por diseño.
- Hub y daemons escuchan solo en loopback/IP de tailnet; publicar con `tailscale serve`, nunca `funnel`.
- Dispositivos: emparejamiento con código de un solo uso → token propio revocable desde la app.
- Máquinas: enlace con código de un solo uso → token de máquina revocable.
- Socket local mod↔daemon restringido al usuario del SO.
- Secretos de conectores (tokens de ticketeras) guardados en el hub, nunca enviados a la app.

## 14b. Compatibilidad total con whoas y ccapi (requisito del dueño)

### whoas (identidades por proyecto)
whoas guarda un token sellado por `proveedor@alias` y elige el alias por proyecto con `.whoas.yaml` + perfiles; los shims hacen que `claude`, `gh`, etc. pasen por whoas.
- **Lanzar sesiones respetando whoas:** el daemon lanza `claude` en un shell de login de la carpeta del checkout, de modo que los shims de whoas están en el PATH y aplican el `.whoas.yaml` del repo (cuenta de Claude, gh, etc. correctas por proyecto). Nunca invoca un binario absoluto que se salte el shim.
- **Credenciales de conectores vía whoas:** cada Trabajo de Quorum puede tener un perfil de whoas asociado. Los conectores que usan CLIs (GitHub por `gh`) corren a través de whoas con ese perfil (p. ej. `WHOAS_PROFILE` / contexto del checkout), así cada trabajo usa su propia cuenta. Las MCP que whoas expone (`whoas mcp proxy mcp-linear@…`) pueden servir de conector. Quorum **no guarda ni ve secretos** que ya maneje whoas; solo guarda secretos propios para ticketeras que whoas no cubra.
- **Mostrar la identidad:** la app muestra qué cuenta usa cada sesión/proyecto (lo que diría `whoas which claude` / `gh` en ese checkout), para notar al instante si una sesión corre con la cuenta equivocada.
- No hacer nunca `/login` ni tocar logins globales; respetar las reglas del skill whoas-setup.

### ccapi (la suscripción como API compatible con Anthropic)
ccapi corre una sesión de Claude Code en tmux con sus propios mods y sirve `/v1/messages` en `127.0.0.1:18787`; cada request es un subagente de esa sesión.
- **Coexistencia:** el mod de Quorum también se cargará en la sesión de ccapi. Quorum debe **detectar la sesión de ccapi** (sus mods / su carpeta / su sesión tmux `ccapi`) y mostrarla como un **servicio** de la máquina (estado, cola, uso), no como una sesión de trabajo: sin inyectar prompts, sin responder permisos, sin notificaciones, y sin listar sus subagentes uno por uno.
- **Uso de ccapi:** el resumidor del hub habla con un endpoint compatible con Anthropic configurable; si hay un ccapi alcanzable (local o por la tailnet/túnel), lo usa con Haiku; si no, cae a `claude -p`. Así Quorum no lanza un proceso de Claude por resumen.
- Cualquier otro consumidor de Quorum que necesite modelo (p. ej. el futuro agente) usa la misma vía.

## 15. Lecciones de v1 que aplican
- Nada de artefactos compilados en git (v1 versionaba 13 MB de `bridge/web`). La app se embebe en el binario al compilar.
- Tests desde el inicio en daemon y hub (v1 tenía un solo test en el bridge).
- Un solo lugar para los tipos del protocolo.
- Versión única para todas las piezas; el daemon avisa si el mod o el hub no coinciden.

## 16. Roadmap (después de la primera versión)
1. Git: estado, diff por archivo, commit, push/pull, PR.
2. Explorador de archivos y "mencionar en el mensaje".
3. Notificaciones push (web push / ntfy) cuando una sesión te necesita.
4. Rutinas programadas.
5. Web en desarrollo por la tailnet y páginas HTML locales.
6. Navegador en vivo (CDP).
7. Agente general (WhatsApp) que responde con el estado ya armado.
8. Apps nativas con Tauri (escritorio + APK), compiladas en CI.
9. Webhooks de ticketeras; clonar repo en una máquina desde la app.

## 17. Lo que queda a criterio del constructor
- Formato del esquema compartido y la herramienta de generación de tipos (JSON Schema, protobuf, o tipos Go como fuente).
- Estructura del monorepo, librerías Go concretas (WebSocket, PTY, router), y componentes de UI (puede reutilizar AI Elements / shadcn de v1).
- Retención exacta de eventos y tamaño de los resúmenes.
- Cómo se instala y actualiza el daemon en cada máquina (script, binario autoactualizable).
- Detalles visuales, siempre que el escritorio muestre varios paneles y el celular sea usable con una mano.

## 18. Cambios decididos tras la Etapa 1 (2026-11-22)

- **Sin modos.** Desaparecen el modo "Fuera", la presencia (`watch`/`away`) y todo enrutamiento según dónde esté el dueño. Todo se controla desde todos lados siempre: cada permiso y cada pregunta aparece **a la vez** en la terminal y en todos los dispositivos; gana la primera respuesta y las demás se retiran.
- **Permisos con diálogo propio (decidido por el dueño).** Claude Code no deja responder su diálogo nativo de permisos desde fuera. Quorum lo reemplaza: cuando el motor pediría permiso, el mod muestra en la terminal su propio diálogo (Permitir / Denegar, vía `$.ui.ask`) y la misma tarjeta en los dispositivos, y corre la carrera. Costos aceptados: se pierde el "permitir siempre" del diálogo nativo, y si gana un dispositivo el diálogo de la terminal queda abierto hasta que se cierre (su respuesta tardía se ignora). Límite de espera: el que permita el motor (~19 min con `quorumd hold`); vencido, deniega con motivo.
- **Recap como nombre de sesión.** Cada sesión se muestra con un recap corto de en qué anda (≤ 60 caracteres, español), generado por el mod con Haiku (`$.model.complete`) tras el primer prompt y al terminar turnos (como mucho cada 5 min y solo si hubo turnos nuevos). Si no hay recap, la carpeta. `/rename` (nombre puesto por el dueño) tiene prioridad si el mod puede leerlo.
- **Pastor retirado**: no hay convivencia ni sesiones "pasivas".
