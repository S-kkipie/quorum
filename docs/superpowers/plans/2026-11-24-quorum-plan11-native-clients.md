# Native clients: herdr plugin and Android APK — Implementation Plan (Plan 11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Quorum notifies the owner natively. On the PC this happens through a light Go client `quorum` that is
integrated with herdr: a watch service, a board pane, and attach. On the phone it happens through a Capacitor APK with
Firebase push. Both use one notification text built by the hub.

**Architecture:** The hub builds the notification text into each `attention` envelope and sends FCM pushes to devices
that registered a token. `cmd/quorum` is a device client of the hub, using the same `/api/live` WS and REST as the web
app. It runs as a systemd user service (`watch`) and as herdr overlay panes (`board`, `attach`). `android-app/` is a
Capacitor shell. A bundled first-run page stores the hub URL, and the WebView then runs the web app from the hub origin.

**Tech Stack:**
- Go: Bubble Tea and Lip Gloss for the TUI, `golang.org/x/oauth2/google` for FCM auth, and `coder/websocket`
  (already used).
- Capacitor 7 with `@capacitor/push-notifications` and `@capacitor/preferences`.
- Android SDK cmdline-tools and JDK 17.

**Spec:** `docs/superpowers/specs/2026-11-24-quorum-native-clients-design.md` (read it; it is the authority).

## Global Constraints

- All repo content in English; no personal data (machines `vps-1`, `laptop` in tests/fixtures); no emojis.
- **Secrets never in git.** Add `android-app/**/google-services.json`, `*.keystore`, `*.jks` and `fcm.json` to
  `.gitignore`. Device and machine tokens are never printed or logged.
- **Notification text (exact):**
  - Title: `<session name> · <machine>`, or `Session · <machine>` when the session has no name.
  - Body for needs-you:
    - permission ask: `Needs you: permission for <Tool>`;
    - AskUserQuestion: `Needs you: question`;
    - otherwise: `Needs you`.
  - Body for done: `Finished`.
  - The title is cut to 80 runes and the body to 120 runes, with a trailing `…` when cut.
  - The FCM data payload is exactly `{session, kind}`.
- **Notify always:** no suppression by focus or seen state beyond what Plan 7 already does before publishing an
  attention.
- **Go:** no cgo. `quorum` builds for linux/amd64 and linux/arm64. `quorum watch` stays under 20 MB RSS when idle and
  does no polling.
- **Hub:**
  - Works exactly as today without `~/.config/quorum/fcm.json`, logging once that push is off.
  - FCM sends are asynchronous with a 10 s timeout.
  - A token is deleted only on FCM `UNREGISTERED` or HTTP 404.
- **Web app:**
  - Initial JS stays at or under 655 kB.
  - Capacitor code is only loaded through a dynamic import when `window.Capacitor` exists.
  - The web build behaves as today.
- **Commits:**
  - Author and committer: `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`.
  - Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests:**
  - `go test ./...`
  - `claude plugin test mod` (only if the mod changes)
  - `make typecheck`
  - `cd app && npx vitest run`
  - `npm run build`
  - `make proto` after proto changes
  - `make apk` (Task 5)
- **Browser:** subagents never use abw or any browser. The controller does all visual checks.

## Review Focus

1. Hub restarts or a client reconnects: the live snapshot must not re-fire old attentions. Each `(session, kind, at)`
   is notified once per client, including across `quorum watch` restarts. This means a small persisted seen-set.
2. An FCM key that is malformed or has expired credentials: the hub logs and keeps working, no token is deleted, and
   attentions still reach the web app and `quorum watch`.
3. Session names with emoji, CJK or 200 characters: cuts happen on rune boundaries, the herdr and toast commands get
   them as argv (never through a shell), and the toast script escapes them.
4. The APK's hub URL is unreachable (Tailscale off): the fallback page shows, Retry works, and the stored URL is kept.
5. A device is revoked while its phone still holds a push token: no more pushes go to it, and its token row is gone.

---

### Task 1: Hub — notification text, push tokens, FCM sender

**Files:**
- `internal/proto/proto.go` (+ `make proto`): `Attention.Title`, `Attention.Body` with `json:"title,omitempty"` and
  `json:"body,omitempty"`.
- `internal/hub/notifytext.go` (new): text builder.
- `internal/hub/attention.go`: fill title and body; call the pusher.
- `internal/hub/push.go` (new): FCM sender.
- `internal/hub/store`: migration adding table `push_tokens(device_id, token PRIMARY KEY, platform, at)`, with cascade
  on device revoke.
- `internal/hub/appapi.go`: routes.
- `app/src/lib/api.ts`: `registerPush(token)`, `unregisterPush(token)`.
- Tests.

**Interfaces — produces:**
- `func attentionText(sessionName, machine, kind string, ask *proto.Event) (title, body string)`. The ask is the
  session's open ask event, if any. Its payload's `tool`/`kind` decides the permission or question wording; read the
  existing ask payload shape in proto.
- `POST /api/devices/push {token, platform:"android"}` returns 204. `DELETE /api/devices/push {token}` returns 204.
  Both use device auth. Validation: token 1–4096 printable characters, platform `android`. Anything else is a 400 with
  an English error.
- `type Pusher interface{ Push(ctx, tokens []PushTarget, title, body string, data map[string]string) }`. FCM
  implementation:
  - The key is read from `filepath.Join(os.UserConfigDir(), "quorum", "fcm.json")`.
  - It POSTs to `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send` with `android.priority="high"`,
    `notification{title, body}` and `data{session, kind}`.
  - The base URL is injectable for tests.

- [ ] **Tests first:**
  - `attentionText`: every body wording, the unnamed-session title, rune-safe cuts at 80/120 with `…`, and an emoji or
    CJK name.
  - `publishAttention` carries `title` and `body`.
  - Push routes: store round-trip, validation 400s, and revoking a device deletes its tokens.
  - FCM sender against an `httptest` server:
    - the payload has the exact fields;
    - `UNREGISTERED` deletes the token;
    - 400 `INVALID_ARGUMENT` does not delete it;
    - a 10 s timeout is honoured, using an injectable shorter timeout in the test;
    - a missing key file means no sends and one log line;
    - a malformed key means a log line and the hub keeps publishing.
- [ ] **Implement, then commit** `hub: notification text, push tokens, FCM pushes`.

### Task 2: `quorum` client — pair, live connection, watch service

**Files:**
- `cmd/quorum/main.go`: subcommands.
- `internal/client/`, new:
  - `config.go`: `client.json` load/save, mode 0600;
  - `hub.go`: pair, REST, the `/api/live` WS with reconnect and backoff;
  - `watch.go`;
  - `notify.go`: herdr and toast.
- `scripts/quorum-watch.service`: systemd user unit.
- `Makefile`: target `quorum` builds and installs to `~/.local/bin`.
- Tests.

**Interfaces — produces (Tasks 3–4 use these):**
- `client.Load() (Config, error)`, where `Config{Hub, Token, Device string}`.
- `client.Dial(ctx, cfg) (*Live, error)`. `Live.Envelopes() <-chan proto.Envelope` delivers the snapshot first, then
  updates. `Live` reconnects by itself, with backoff of 1 s, doubling, and a cap of 30 s.
- `client.Sessions(ctx, cfg) ([]proto.SessionInfo, error)`, plus a REST helper for terminal relay calls.

**`quorum pair <hubURL> <code> [--name <device>]`:**
- It POSTs `/api/pair`. The default device name is `quorum-<hostname>`.
- It writes `$XDG_CONFIG_HOME/quorum/client.json`, falling back to `~/.config/quorum/client.json`.
- It prints `Paired as <device>`, never the token.

**`quorum watch`:**
- Single-instance lock with `flock` on `$XDG_RUNTIME_DIR/quorum-watch.lock`, falling back to the config dir. A second
  instance exits with code 0 and a log line.
- For each `attention` envelope:
  - Skip it if `(session, kind, at)` is in the persisted seen-set: `~/.local/state/quorum/watch-seen.json`, keeping the
    last 500 entries.
  - Otherwise run `herdr notification show <title> --body <body>`. Use `$HERDR_BIN_PATH`, else `herdr` from `PATH`. A
    failure, such as no herdr server, is logged.
  - If under WSL, also raise a Windows toast through `powershell.exe -NoProfile -Command <script>`. Values are passed
    via environment variables, never interpolated into the script. Timeout 5 s.
- The title and body come from the envelope. If they are empty (old hub), use `Session · <machine>` and `Needs you` or
  `Finished`.

**`scripts/quorum-watch.service`:** `ExecStart=%h/.local/bin/quorum watch`, `Restart=always`, `RestartSec=5`.

- [ ] **Tests first:**
  - config 0600 and round-trip;
  - pair against an `httptest` hub, checking that the token is not printed;
  - backoff schedule;
  - seen-set dedupe across snapshot replay and across a restart;
  - the second instance exits;
  - notifier argv: exact herdr args, and the toast env vars with no interpolation, using a fake exec runner;
  - WSL detection from a fake `/proc/version`;
  - old-hub fallback text.
- [ ] **Measure:** RSS of `quorum watch` idle for 60 s against a local test hub is under 20 MB. Record it in the report.
- [ ] **Commit** `quorum: pair and watch with herdr and Windows notifications`.

### Task 3: `quorum board` and `quorum attach` (TUI) + herdr plugin

**Files:**
- `internal/client/board/`: Bubble Tea model.
- `internal/client/attach/`: relay viewer.
- `cmd/quorum/main.go`: `board` and `attach`.
- `herdr-plugin/herdr-plugin.toml`: `id="quorum"`, `min_herdr_version="0.9.5"`, `platforms=["linux"]`. It declares:
  - pane `board`, placement `overlay`, command `["quorum","board"]`;
  - action `board`, which opens the pane;
  - no `[[startup]]`.
- `herdr-plugin/README.md`: keybinding and install.
- Tests.

**Board:**
- Sessions from all machines, grouped in this order: needs you, working, background, done-unread, idle. Closed
  sessions are hidden.
- Each row: name (or `Session`), machine, project, state. Live updates from `Live`.
- Keys: ↑/↓ or j/k, `/` filter (substring on name, project, machine), Enter jumps, `q`/Esc quits. Not paired shows
  `Run quorum pair <hub> <code>`.
- **Enter, local session in a herdr pane** (`HerdrPane` set and machine is this one): focus that pane via the herdr CLI.
  Find the exact command in `herdr --skill` / `herdr pane --help`, then exit.
- **Enter, remote session in a herdr pane:** open a new herdr tab running `quorum attach <session>`, then exit.
- **Enter, a session with no `HerdrPane`:** show `Not in a herdr pane on <machine>` in the status line.
- Narrow terminals of 40 columns or fewer: rows truncate on rune boundaries and the state stays visible.

**`quorum attach <session>`:**
- Opens and watches the session's pane through `/api/machines/{m}/terminals/...`, using what the web Terminal screen
  uses (read `app/src/screens/Terminal.tsx` and `internal/hub/terminalapi.go`).
- Draws frames full-screen and sends keystrokes as input.
- Ctrl-] detaches and closes the relay watch.
- An offline machine shows `<machine> is offline` and exits with code 1.

- [ ] **Tests first:**
  - the board model with `teatest` or update-function tests: ordering, filter, Enter routing for the three cases
    (fake herdr runner), the not-paired message, and a 40-column view with CJK and emoji names;
  - attach against an `httptest` relay: frames drawn, input forwarded, Ctrl-] closes the watch, offline message.
- [ ] **Commit** `quorum: board and attach panes; herdr plugin`.

### Task 4: Web app — native layer for the APK

**Files:**
- `app/src/lib/native.ts`: Capacitor branch.
- `app/src/lib/push.ts` (new, lazy).
- `app/src/screens/Config.tsx`: "Change hub", APK only.
- `app/src/App.tsx`: deep link to a session from a notification tap.
- Tests.

**Interfaces — consumes:** `registerPush` / `unregisterPush` (Task 1).

**Behavior:**
- When `window.Capacitor?.isNativePlatform()` is true and the device is paired, lazy-import `push.ts`:
  - request permission (Android 13+);
  - `PushNotifications.register()`;
  - send the token with `registerPush` on `registration`, and again whenever it changes;
  - handle `pushNotificationActionPerformed` by navigating to `data.session`;
  - for a foreground `pushNotificationReceived`, show a local system notification through the existing `notify()`
    path, because the owner wants to be notified always.
- On unpair, call `unregisterPush(token)` before clearing local state.
- The web build is unchanged. The Capacitor packages are only reachable through the dynamic import. Check that
  initial JS is at or under 655 kB.
- "Change hub" (APK only) calls the shell's `Preferences.remove({key:'hubUrl'})` and reloads, which brings back the
  first-run page.

- [ ] **Tests first**, with Capacitor mocked:
  - the web path never imports `push.ts`;
  - native path: register is called, `registerPush` gets the token, a tap navigates to the session, foreground receive
    calls notify, unpair calls unregister;
  - "Change hub" is hidden on the web.
- [ ] **Commit** `app: native push layer for the Android app`.

### Task 5: Android shell (Capacitor) + build + Firebase guide

**Files:**
- `android-app/`:
  - `package.json` with `@capacitor/core`, `@capacitor/android`, `@capacitor/push-notifications`,
    `@capacitor/preferences`, `@capacitor/cli`;
  - `capacitor.config.ts` with `appId:"dev.quorum.app"` and `appName:"Quorum"`;
  - `www/`: a bundled first-run page and an offline fallback, using the Plan 9 tokens and both themes;
  - the generated `android/` project;
  - `MainActivity` (runtime server URL from Preferences);
  - `res/xml/network_security_config.xml` (cleartext allowed; see below);
  - notification channel `sessions`, "Sessions", high importance.
- `Makefile` target `apk`.
- `docs/android.md`: the Firebase guide and the install steps.
- `.gitignore` entries.

**Behavior:**
- **First run:** the bundled page asks for the hub URL, which must start with `http://` or `https://`. It checks
  reachability (`GET <hub>/api/health`, or `/` if no health route exists), saves the URL to Preferences, and restarts
  the activity with that server URL. Pairing then happens in the web app.
- **Hub unreachable on start:** the fallback page shows `Can't reach the hub. Is Tailscale connected?` with Retry and
  Change hub, and keeps the stored URL.
- **Cleartext:** allowed for the hub host. The host is only known at runtime, so allow cleartext globally and say in a
  comment that this is a personal tailnet-only app. Ruling recorded in the spec: designer's call.
- **Bridge:** the Capacitor bridge works on the hub origin. Verify on an emulator or a real device that
  `window.Capacitor.isNativePlatform()` is true on the hub page.
- **`make apk`:**
  - Builds a release APK signed with `~/.config/quorum/android/release.keystore`, with the password from
    `~/.config/quorum/android/keystore.properties`.
  - Uses `~/.config/quorum/android/google-services.json`, copied into the build at build time and never tracked.
  - The output is `android-app/quorum.apk`, which is git-ignored.
  - If a secret file is missing, it fails with a clear message pointing to `docs/android.md`.
- **`docs/android.md`:** a step-by-step Firebase console guide:
  1. create the project;
  2. add the Android app `dev.quorum.app`;
  3. download `google-services.json` to `~/.config/quorum/android/`;
  4. create a service account with the Firebase Cloud Messaging API Admin role and download its key to `~/.config/quorum/fcm.json` on the hub host;
  5. enable the FCM HTTP v1 API.

  It also covers generating the keystore with a `keytool` command, sideloading, and pairing.

- [ ] **Checks:** the Android SDK is installed with sdkmanager into `~/Android/sdk` if it is missing. `make apk`
  succeeds with throwaway test secrets generated in a temporary directory. Never commit them, and never use the
  owner's real ones. `aapt dump badging` shows `dev.quorum.app` and the POST_NOTIFICATIONS permission.
- [ ] **Commit** `android: Capacitor shell, first-run hub page, push, build`.

### Task 6: Controller — E2E and deploy prep

- [ ] **Hub (local):** with a fake FCM server, check that a needs-you attention produces the exact payload.
  `quorum watch` against the local hub shows a herdr notification in a scratch herdr session, then a Windows toast.
  Check the board and attach on a scratch tmux/herdr session the controller created. Never touch the owner's
  tabs.
- [ ] **APK:** if an emulator is available, run the first run, the fallback, and push token registration against the
  local hub. Otherwise defer to the owner's phone after their Firebase setup.
- [ ] **Report for the owner:** what they must do, which is the Firebase guide, then installing the APK.
