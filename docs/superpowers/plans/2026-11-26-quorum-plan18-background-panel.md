# Plan 18 — Background Panel and External Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inspector's Background card lists live and ended background work with machine facts (output age,
process state, dead). Opening an item shows its live output or the subagent screen. Artifacts open in the device's
own browser.

**Architecture:**
- The daemon gains a `task_output` RPC: it reads the session's Claude Code task output file and scans `/proc` for
  processes holding it.
- The hub exposes it as a device route.
- The app polls it while the inspector or an output view is open.
- The desktop shell (WebView2) and the Android shell (Capacitor plugin) each gain an "open externally" bridge.

**Tech Stack:** Go (daemon, hub, desktop), React + TypeScript + vitest (app), Java (Android plugin).

**Spec:** `docs/superpowers/specs/2026-11-26-quorum-background-panel-design.md`

## Global Constraints

- **Ids.** The session and task ids must match `^[A-Za-z0-9_-]{1,128}$`, or the request is rejected (400 at the
  hub, an error at the RPC).
- **Output file.** It is `<tmp>/claude-<uid>/<any single dir>/<sessionId>/tasks/<taskId>.output`.
  - `<tmp>` is `$CLAUDE_CODE_TMPDIR` if set, else `os.TempDir()`.
  - The daemon serves it only for a session registered with it.
  - Symlinks are resolved before the `/proc` comparison.
- **Tail.** At most 64 KiB (65536 bytes) from the end, cut forward to a UTF-8 rune start.
- **Facts.** The RPC result is:

  ```json
  {"found": true, "size": 0, "mtime": 0, "tail": "", "procsKnown": true, "procs": [{"pid": 0, "state": "R|S|D|Z|T|…", "cpuMs": 0}]}
  ```

  - `mtime` is Unix ms.
  - `procsKnown` is true only on Linux with a readable `/proc`.
  - `cpuMs` is utime+stime from `/proc/<pid>/stat`, converted with a clock tick of 100.
- **Dead.** An item is dead only when one of these holds:
  - the item is live in `session.background.items` (no end reported), `procsKnown` is true, `found` is true and
    `procs` is empty;
  - the session state is `closed`.
- No inactivity threshold anywhere. No "hung" label.
- **Polling.** Inspector facts refresh every 10 s, only while the inspector is open. An output view refreshes
  every 2 s, only while it is open.
- **Ended list.** `task_end` events of the loaded history, newest first. A synthetic end is replaced by a real end
  of the same task.
- **External open.** It accepts `http:` or `https:` URLs only.
  - `Quorum.exe` binds `quorumOpenExternal(url)`, which runs `rundll32 url.dll,FileProtocolHandler <url>`.
  - Android: the `HubShell.openExternal({url})` plugin method, an `ACTION_VIEW` intent.
  - Web: `window.open` on a tab opened synchronously in the click.
- The initial JS bundle stays at 655 kB or less, and the output view is lazy.
- Repo content in English, with no personal data. Tests use made-up ids and paths.

## Review Focus

1. **A path escape through the ids.** `taskId` "../x" or "a/b" is rejected before any filesystem access. Test in
   Task 1.
2. **A huge or binary output file.** Only the last 64 KiB is read; never the whole file into memory. Invalid UTF-8
   becomes replacement characters, never a JSON error. Test in Task 1.
3. **An output file that does not exist yet.** A task that has written nothing returns `found:false` and is not
   marked dead. Test in Task 1, and in Task 3 for the app.
4. **A popup blocker on the web.** The tab is opened in the click handler before the await. If the link fails,
   the opened tab is closed and an error toast shown. Test in Task 4.
5. **An inspector open for hours.** Polling stops when it closes or unmounts. No interval leaks. Test in Task 3.

---

### Task 1: Daemon `task_output` RPC

**Files:**
- Create: `internal/daemon/taskoutput.go`, `internal/daemon/taskoutput_linux.go` (the `/proc` scan),
  `internal/daemon/taskoutput_other.go` (no scan, `procsKnown=false`) and `internal/daemon/taskoutput_test.go`.

**Interfaces:**
- Produces: `rpcHandlers["task_output"]` with params `{"session": string, "task": string}` and the result above.
  - Helpers: `taskOutputPath(tmpRoot, uid, session, task string) (string, bool)` (glob, first match) and
    `fileHolders(resolved string) ([]procInfo, bool)`.
- Consumes: the `Host`'s registry, to check that the session is registered (as other session-scoped RPCs do).

- [ ] **Step 1: Failing tests:**
  - `TestTaskOutputRejectsBadIDs`: "../x", "a/b", "" and a 129-character id are rejected.
  - `TestTaskOutputUnknownSession`: an unregistered session is an error.
  - `TestTaskOutputMissingFile`: `found:false`, no error.
  - `TestTaskOutputTail`:
    - a 200 KiB file gives a tail of at most 65536 bytes ending with the file's last bytes;
    - a multibyte rune split at the cut is dropped forward;
    - `size` and `mtime` are correct.
  - `TestTaskOutputHolders` (Linux only): it opens the file in a child process (`sleep` with stdout redirected to
    the file). The holders include that pid, with a state letter. After the child is killed and reaped, the
    holders are empty.
  - Tests set `CLAUDE_CODE_TMPDIR` to `t.TempDir()`.
- [ ] **Step 2: Run** `go test ./internal/daemon -run TaskOutput`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Read the tail with `Seek` plus `ReadAt`.
  - Scan `/proc/[0-9]*/fd/*` with `os.Readlink`, compared to the `filepath.EvalSymlinks` of the file. Skip
    unreadable pids.
  - Parse `/proc/<pid>/stat` after the last `)`: field 3 is the state, fields 14 and 15 are utime and stime.
- [ ] **Step 4: Run** `go test ./internal/daemon/...`. Expected: PASS.
- [ ] **Step 5: Commit** "daemon: task_output reads a background task's output tail and its holder processes".

### Task 2: Hub device route

**Files:**
- Modify: `internal/hub/appapi.go` (route registration next to the views route) and a new
  `internal/hub/taskoutput.go`.
- Test: `internal/hub/taskoutput_test.go`.

**Interfaces:**
- Produces: `GET /api/sessions/{sid}/tasks/{task}/output`, which returns the RPC result JSON unchanged.
  - 400: bad ids.
  - 404: unknown session.
  - 502: the machine is offline or the RPC failed, with the error text.
- Consumes: `s.hub.call(ctx, si.Machine, "task_output", {"session": sid, "task": task}, &out)`, with a 5 s timeout.

- [ ] **Step 1: Failing tests:** use the existing fake-machine test pattern from the views or file_read tests.
  - The happy path passes the JSON through.
  - Bad ids give 400, with no RPC sent.
  - An unknown session gives 404.
  - An offline machine gives 502.
  - A request without a device token gives 401.
- [ ] **Step 2: Run** `go test ./internal/hub -run TaskOutput`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./internal/hub/...`. Expected: PASS.
- [ ] **Step 5: Commit** "hub: device route for a background task's output and facts".

### Task 3: App — Background card, facts and output view

**Files:**
- Create:
  - `app/src/lib/taskOutput.ts`: the `getTaskOutput(sessionId, task)` API call, the `TaskFacts` type,
    `isDead(...)` and `factLine(...)`.
  - `app/src/components/inspector/TaskOutputView.tsx`: lazy.
  - `app/src/lib/endedTasks.ts`: `endedTasksOf(events: Event[]): TaskEnd[]`.
- Modify:
  - `app/src/components/inspector/BackgroundCard.tsx`
  - `app/src/components/inspector/Inspector.tsx`
  - `app/src/screens/Session.tsx`
  - `app/src/components/Transcript.tsx`: a prop `openAgent?: { id: string; n: number }` that pushes that
    subagent's screen, the same way a click on its card does.
- Test: `app/src/lib/taskOutput.test.ts`, `app/src/lib/endedTasks.test.ts`, and additions to
  `app/src/components/inspector/Inspector.test.tsx`.

**Interfaces:**
- Consumes: the Task 2 route, plus the existing `session.background.items`, `session.state` and `task_end`
  events.
- Produces:
  - `isDead(item: BackgroundItem, facts: TaskFacts | undefined, sessionState: string): boolean`, following the
    Global Constraints "Dead" rule exactly.
  - `factLine(facts, now)`, for example "last output 3 min ago · sleeping · 2.1 s CPU".

- [ ] **Step 1: Failing tests:**
  - `isDead`:
    - a closed session gives true;
    - `procsKnown` with `found` and no procs gives true;
    - `found:false` gives false;
    - `procsKnown:false` gives false;
    - procs present gives false.
  - `endedTasksOf`: newest first, and a real end replaces a synthetic end of the same id.
  - Inspector:
    - with 3 live items, the card shows them inside a scroll region with a max height;
    - a dead item shows "Dead" in the danger tone;
    - clicking a subagent row calls `onOpenAgent` with its id;
    - clicking a command opens the output view showing the fetched tail;
    - closing the inspector stops the fetch interval (fake timers: no fetch after close);
    - ended tasks show their status and exit code, and clicking one shows its `outputTail`.
- [ ] **Step 2: Run** `cd app && npx vitest run src/lib/taskOutput.test.ts src/lib/endedTasks.test.ts src/components/inspector`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Card layout:**
    - Running rows first, then an "Ended" group.
    - The list scrolls inside `max-h-80`.
    - Each row: kind icon, label, fact line, and a "Dead" badge in `text-danger`.
    - Loops and crons are not clickable.
  - **Output view:**
    - Desktop: a `Dialog` about 720 px wide and up to 80 dvh tall.
    - Phone: a full-screen `Sheet`.
    - A monospace `pre` that sticks to the bottom, with the fact line in the header.
  - **Session wiring:**
    - Session passes `onOpenAgent` down to the inspector and sets Transcript's `openAgent`.
    - An overlay or sheet inspector closes when an agent opens.
- [ ] **Step 4: Run** `cd app && npx tsc --noEmit -p . && npx vitest run && npm run build`. Expected: all PASS;
  the initial JS is 655 kB or less.
- [ ] **Step 5: Commit** "app: background card with machine facts, live output and subagent screens".

### Task 4: Artifacts in the device browser

**Files:**
- Modify:
  - `app/src/lib/native.ts`: `openExternal(url: string): void` and
    `openExternalAsync(get: () => Promise<string>): Promise<void>`.
  - `app/src/screens/Session.tsx`: `onOpenArtifact` uses `artifactPath` plus `createView`, then opens the link
    externally. It no longer uses the in-app Viewer.
  - `cmd/quorum-desktop/main_windows.go`: bind `quorumOpenExternal`.
  - `android-app/android/app/src/main/java/dev/quorum/app/HubShellPlugin.java`: `openExternal`.
- Test: `app/src/lib/native.test.ts`, plus `cmd/quorum-desktop/hub_test.go` for the URL validation helper, if one
  is extracted to a non-Windows file.

**Interfaces:**
- Produces: `openExternalAsync(get)`.
  - With `window.quorumOpenExternal`, or on the Capacitor native platform, it awaits `get()` and calls the bridge.
  - Otherwise, it opens `window.open('', '_blank')` synchronously, then sets the tab's location to the awaited URL,
    with `opener = null`. On a rejection it closes that tab and rethrows.
- The desktop's `quorumOpenExternal` rejects anything that is not `http(s)`. Factor out
  `externalURLOK(raw string) bool` into a file that builds on every OS, with a test.

- [ ] **Step 1: Failing tests:**
  - `native.test.ts`:
    - the web path opens the tab before the promise resolves;
    - a rejected promise closes the tab;
    - the desktop path calls `quorumOpenExternal` with the full URL;
    - a `javascript:` URL is refused.
  - Go: `externalURLOK` accepts http and https, and rejects `file:`, `javascript:` and empty.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Android: `new Intent(Intent.ACTION_VIEW, Uri.parse(url))` with `FLAG_ACTIVITY_NEW_TASK`, after the scheme
    check.
  - The app's Android path calls `registerPlugin('HubShell').openExternal({ url })` the way other HubShell calls
    are made.
- [ ] **Step 4: Run**:
  - `cd app && npx vitest run && npx tsc --noEmit -p .`
  - `go test ./cmd/quorum-desktop/...`
  - `GOOS=windows go vet ./cmd/quorum-desktop`

  Expected: PASS.
- [ ] **Step 5: Commit** "app, desktop, android: open artifacts in the device browser".

### Task 5: End-to-end (controller)

- [ ] Deploy:
  - the hub on oracle83;
  - quorumd on both machines;
  - `make desktop`, copied to Windows;
  - `make apk`, sent to the owner.
- [ ] In a scratch session, start a background `sleep 600; echo hi` and one background subagent. The card shows
  both, with facts.
- [ ] Kill the sleep's process from outside Claude Code. The item turns Dead within 10 s.
- [ ] Open the subagent: the subagent screen appears.
- [ ] Open a command: the live tail updates.
- [ ] Click an artifact in a browser tab: a new tab opens with the page.
