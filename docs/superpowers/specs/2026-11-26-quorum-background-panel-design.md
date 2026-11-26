# Inspector: background work and artifacts in the browser — Design

Date: 2026-11-26. Status: the owner approved the approach in conversation, with option 1 for stalled work.

## Intent

The session inspector (the right panel) is where the owner checks on work they are not watching:

- usage stays as it is;
- changed files are gone;
- artifacts are HTML pages only (both already shipped).

Two gaps remain:

1. Artifacts open inside Quorum's own window. The owner wants them in the device's own browser, like any URL.
2. Background tasks and background subagents are listed with only a label and a start time. The owner wants to:
   - open each one and see its output, or what a subagent is doing;
   - notice when one is dead.

## Goals

1. **Artifacts in the device browser.**
   - A click mints a fresh view link through `POST /api/machines/{m}/views`, then opens it outside Quorum:
     - `Quorum.exe`: the system default browser.
     - Android: an `ACTION_VIEW` intent.
     - A plain browser tab: a new tab.
   - A stale `/v/` token never reaches the owner.
2. **Background card.**
   - It lists the live items: commands, monitors, subagents, loops and crons.
   - It also lists the background tasks that ended in the loaded history, newest first: status (completed,
     failed, killed, …) and exit code.
   - The list scrolls inside a maximum height, so it never pushes Artifacts off the panel.
3. **Facts per item, never guesses.**
   - Running commands and monitors show:
     - when the output was last written ("last output 3 min ago");
     - the process state read from the OS: running, sleeping, disk wait or zombie;
     - the CPU time used.
   - An item is **dead** when, and only when, one of these is true:
     - the machine finds no live process holding its output file, and Claude Code never reported its end;
     - the session's Claude Code instance has exited.
   - Dead is shown in the danger colour.
   - There is no "hung" label and no inactivity threshold. The owner reads the facts and decides.
   - When the OS gives no process data (not Linux), the process line is omitted and nothing is marked dead on
     that basis.
4. **Open an item.**
   - **A subagent** opens the existing subagent screen: its task, steps and answer, live. On a desktop it is a
     wide side sheet; on a phone, full screen.
   - **A command or monitor** opens its output, live: the tail of its output file, refreshed every 2 s while open,
     with the same facts. It is a dialog on a desktop and full screen on a phone.
   - **An ended task** shows the output tail its `task_end` event carried.

## Non-goals

- Stopping a single task from the panel.
- Reading output files of other sessions or arbitrary paths.
- Windows/macOS process inspection. Both machines run Linux; elsewhere the facts degrade as described above.

## Constraints

- The daemon reads only `<tmp>/claude-<uid>/*/<sessionId>/tasks/<taskId>.output`:
  - `<tmp>` is `$CLAUDE_CODE_TMPDIR` when set, else the OS temp dir;
  - the session must be registered with that daemon;
  - both ids must match `^[A-Za-z0-9_-]{1,128}$`.
- An output tail is at most 64 KiB, cut at a UTF-8 boundary.
- Polling runs only while the inspector or an output view is open. The facts refresh every 10 s.
- Initial JS stays at 655 kB or less. The output view goes in a lazy chunk.
- Repo content in English, with no personal data.

## Approaches

- **Chosen:** facts from the machine (output file mtime, `/proc` holders of the file) plus Claude Code's own end
  reports.
- **Rejected:** an inactivity threshold that marks items "hung". The owner rejected heuristics.

## Left to the builder

The exact copy of the fact lines, the icons, and the layout of the output view.
