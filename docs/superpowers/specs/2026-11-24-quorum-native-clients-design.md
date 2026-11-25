# Native clients: herdr plugin (PC) and Android APK — Design

Date: 2026-11-24. Status: approved in chat (owner), pending the written-doc review.

## Intent

The owner wants Quorum to reach them natively, without a browser tab: on the PC, inside herdr where they already
work, and on the phone as an installed app whose notifications arrive even when the app is closed. Native
notifications are driven by the hub's existing `attention` envelopes (Plan 7: `needs_you`, unread `done`).

The owner's words: "no quiero tauri", "super super liviano", "como herdr", "saca apk para android y en windows binario
con go para herdr", notifications via Firebase (option C, battery first), notification text option 1 (session name,
machine and reason), and "que siempre avise en ambos" (always notify on every client, even when the herdr pane is
focused).

## Goals

- **PC: a herdr plugin backed by one Go binary `quorum`.**
  - It runs inside the owner's herdr: WSL on the Windows PC, and also on the arm64 server.
  - It shows every `attention` from every machine as a herdr notification, plus a Windows toast when running under WSL.
  - It opens a floating board of all sessions across machines and jumps to one.
- **Android: an installed APK with Firebase Cloud Messaging (FCM) push.**
  - Notifications arrive with the app closed or the phone asleep.
  - Tapping one opens that session in the app.
  - The UI is the existing React app.
- **Hub:** sends FCM pushes for `attention`, using the notification text in **Notification text** below.

## Non-goals

- Tauri, Electron, or any desktop webview app. A React Ink or Node TUI is also out, rejected because Node is heavier
  than Go and Ink cannot reuse the DOM components.
- A transcript reader or a composer in the terminal. In herdr, the owner sees the real Claude session; the board only
  lists and jumps.
- iOS, an app-store release, and auto-update of the APK.
- Suppressing notifications based on focus. The owner ruled "always notify on both".

## Anti-goals

- A heavy resident process on the PC. Target: `quorum watch` under 20 MB RSS when idle.
- Notification content beyond what is listed in **Notification text**. No prompts, code, commands or answers ever
  leave the tailnet through Google.
- Secrets in the public repo. This covers the Firebase service-account key, the Android keystore and
  `google-services.json`.

## Approaches considered

| Approach | RAM / weight | Reuses UI | Android | Verdict |
|---|---|---|---|---|
| Tauri desktop + Android | 150–250 MB (WebView2) | yes | yes (third-party FCM plugin, Rust Android builds in CI) | Rejected by the owner: too heavy |
| New binary with React Ink | 60–100 MB (Node/Bun) | no | no | Rejected: heavier than Go and a full UI rewrite anyway |
| **herdr plugin in Go (PC)** | ~10–15 MB, static binary | no (a small TUI) | — | **Chosen** for the PC |
| ntfy app for the phone | tiny | — | via the ntfy app | Offered; the owner chose an own APK |
| **Capacitor APK (Android)** | system WebView | yes | official `@capacitor/push-notifications` (FCM) | **Chosen** (designer's call): official FCM plugin, almost no native code, Gradle only (no Rust) |
| Tauri Android / hand-written Kotlin WebView | system WebView | yes | third-party plugin / hand-written FCM | Rejected: Rust Android build, or more native code to own |

## Design

### 1. `quorum` binary (Go, `cmd/quorum`)

It is a device client of the hub, like the web app, authenticated with a device token. It shares `internal/proto` and
whatever client code fits.

- `quorum pair <hubURL> <code> [--name <device>]` pairs it as a device through the existing `POST /api/pair`. It stores
  `{hub, token}` in `$XDG_CONFIG_HOME/quorum/client.json` with mode 0600. The token is never printed.
- `quorum watch` holds the hub's app live connection (the same WS the web app uses) and reconnects with backoff.
  - It runs as a systemd user service `quorum-watch` (like `quorumd`), not as a herdr startup hook.
    - Startup hooks run once per herdr server start, and processes that outlive the server are not protected from
      cleanup.
    - A single-instance lock (`flock` on `$XDG_RUNTIME_DIR/quorum-watch.lock`) prevents duplicate notifications.
    - If no herdr server is running, the herdr notification is skipped and only the toast is shown.
  - It is installed on the PC only (designer's call), so the owner never gets the same attention twice from two
    herdrs.
  - For every `attention` envelope it runs `herdr notification show "<title>" --body "<body>"` through
    `$HERDR_BIN_PATH` when it is set, else `herdr`.
  - Under WSL (`/proc/version` contains `microsoft`, with interop available), it also raises a Windows toast through
    `powershell.exe`. This is best effort: it times out after 5 s and failures are logged, never fatal.
  - It uses the `title` and `body` the hub puts in the envelope (see **Notification text**). The client never builds
    the text itself.
  - Each attention is notified once, deduplicated by `(session, kind, at)` across reconnects. The live snapshot after a
    reconnect does not replay old attentions.
- `quorum board` is a full-screen TUI (Bubble Tea + Lip Gloss) for a herdr overlay pane.
  - It lists sessions from all machines, grouped by state in Plan 7 order: needs you, working, background,
    done-unread, idle.
  - Each row shows name, machine, project and state, and the list updates live.
  - Keys: ↑/↓ or j/k, `/` to filter, Enter to jump, `q`/Esc to close.
  - **Jump to a session on this machine** that runs in herdr (`HerdrPane` is set, and the machine is this one): focus
    that pane through the herdr CLI.
  - **Jump to a session on another machine:** open a new herdr tab running `quorum attach <session>`.
  - **A session not in a herdr pane** (`HerdrPane` empty) is listed but not jumpable. Enter shows
    "Not in a herdr pane on <machine>". The terminal relay is keyed by machine and pane.
- `quorum attach <session>` mirrors the session's pane through the hub's existing terminal relay
  (`/api/machines/{m}/terminals/...`: watch/read frames, send input). It needs no ssh and works over the tailnet like
  the phone terminal. Ctrl-] detaches.
- Footprint: idle `watch` under 20 MB RSS, with no polling. Everything is push, as in the original design (§7.3).

### 2. herdr plugin (`herdr-plugin/` in the repo)

`herdr-plugin.toml` with these keys:

- `id = "quorum"`, `min_herdr_version = "0.9.5"`, `platforms = ["linux"]`. WSL and the server are both Linux.
- no `[[startup]]` (watch is a systemd service, see §1).
- `[[panes]] id = "board"`, `placement = "overlay"`, `command = ["quorum", "board"]`, with a keybinding documented in
  the README.
- `[[actions]] id = "board"` opens the pane.
- If `quorum` is not paired, `watch` exits with a clear log line and `board` shows "Run quorum pair <hub> <code>".

Install: `make quorum` builds and installs `~/.local/bin/quorum`, then `herdr plugin link <repo>/herdr-plugin`.
The server gets the arm64 build through the usual deploy.

### 3. Android APK (Capacitor, `android-app/`)

- **What the app loads.** A bundled first-run page asks only for the hub URL and stores it in native preferences.
  The activity then starts with that URL as its server URL (Capacitor runtime config in `MainActivity`).
  - From then on the WebView runs the web app on the hub origin, so pairing is the web app's own Pair screen and the
    device token is the usual Bearer token in that origin's localStorage.
  - The Capacitor bridge must be available on that origin: the hub host is the configured server URL. The builder
    verifies this.
  - The hub is plain `http://` over the tailnet (`tailscale serve --http`), so cleartext is required.
  - Loading the UI from the hub rather than from bundled assets is the designer's call. Every hub deploy updates the UI without a new APK, which is the designer's call. The APK is rebuilt only when
  the native side changes.
  - A bundled fallback page shows "Can't reach the hub. Is Tailscale connected?" with a Retry button.
  - A "Change hub" entry in the app's Settings clears the stored URL (only inside the APK).
- **Cleartext http on the tailnet.** The Android network security config allows cleartext only for the hub's host,
  which is configurable and must be on the tailnet. `androidScheme` and mixed-content settings must let the page talk to
  `http://` without errors.
- **Push.**
  - On launch after pairing, the app requests notification permission (Android 13+), registers with FCM and sends the
    token to the hub (§4). It does this again whenever the token changes.
  - Notifications use one high-importance channel named "Sessions".
  - Tapping a notification opens the app on that session, using the session id from the push data.
- **App code.** It goes through `app/src/lib/native.ts`, which gets a Capacitor implementation when
  `window.Capacitor` exists. The web build is unchanged otherwise.
  - In-app notifications stay as they are.
  - When the app is in the foreground, it shows the push as a system notification too ("always notify").
- **Package and build.**
  - Package id: `dev.quorum.app`. This is the designer's call and the owner may change it before the Firebase setup.
  - Built on the owner's PC with `make apk`, which uses the Android SDK command-line tools and JDK 17 (already at
    `~/.jdk17`). This is the designer's call: there is no Rust, so RAM is fine, and no Firebase or signing secrets go to
    GitHub.
  - The keystore and `google-services.json` live outside the repo, in `~/.config/quorum/android/`.
  - The APK is installed by hand.

### 4. Hub: push tokens and FCM sender

- `POST /api/devices/push {token, platform:"android"}` (device auth) stores the token on the calling device.
  `DELETE` removes it. Revoking a device drops its token.
- On every published `attention`, the hub sends one FCM HTTP v1 message per device with a token.
  - It authenticates with the service-account key at `~/.config/quorum/fcm.json` on the hub host. The key is optional:
    without it, push is off and a log line says so once.
  - It signs the OAuth2 JWT with the key and caches the access token until expiry. It uses `golang.org/x/oauth2/google`
    or an equivalent small dependency, not the Firebase Admin SDK.
  - Messages use Android priority `high` and carry the session id as `data`.
  - A token is deleted only when FCM reports `UNREGISTERED` (or 404 NOT_FOUND). A bad payload must never delete
    valid tokens.
  - Sends are asynchronous, never block the hub's hot path, and time out after 10 s.
- CORS is not needed, because the APK loads the UI from the hub origin.

### Notification text (owner's option 1)

- **Title:** `<session name> · <machine>`. The session name is the recap name the app shows.
- **Body when the session needs you:**
  - an ask: `Needs you: permission for <Tool>`, or `Needs you: question`;
  - otherwise: `Needs you`.
- **Body when it is done:** `Finished`.
- **Limits:** the title is cut at 80 characters and the body at 120. Nothing else is sent. The data payload holds only
  `{session, kind}`.
- **Built once, by the hub.** `proto.Attention` gains optional `title` and `body` fields. This is additive: old apps
  ignore them. `quorum watch` and the FCM push both use these fields.
  - If the session has no name yet, the title is `Session · <machine>`.
  - The needs-you reason comes from the open ask the hub already tracks: tool name for a permission ask, `question`
    for an AskUserQuestion.

## Constraints

- All repo content in English. Never commit secrets: add the keystore, `google-services.json` and `fcm.json` to
  `.gitignore`.
- Go with no cgo, for the existing cross-compile: linux/amd64 for WSL and linux/arm64 for the server.
- Initial JS of the web app stays at or under 655 kB. Capacitor's JS loads only inside the APK, through a dynamic
  import guarded by `window.Capacitor`.
- The hub works exactly as today when no FCM key is present.
- Follow the standing deploy rules: hub DB backup, noreply author, never push `historial*` branches.

## Owner actions (one-time)

1. **Firebase project.** Following a short guide that will live in `docs/android.md`:
   - create the project;
   - add an Android app with package `dev.quorum.app`;
   - download `google-services.json`;
   - create a service-account key with FCM send rights.
2. Install the APK on the phone and pair it with a code from `quorum-hub pair`.
3. On the PC: `quorum pair`, then `herdr plugin link`. These can be done by Claude in this session.

## Left to the builder

- How `board` renders the frame stream for `attach`: draw full frames, or diff them.
- The exact herdr CLI calls for focusing a pane and opening a tab. Read them from `herdr --skill` and the CLI reference.
- The Windows toast mechanism from WSL. Any built-in mechanism works; no extra PowerShell modules.
- Capacitor plugin versions, and whether the fallback page is a Capacitor `errorPath` or a small native check.
