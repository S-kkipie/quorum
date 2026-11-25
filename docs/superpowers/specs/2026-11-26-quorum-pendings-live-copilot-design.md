# Pending items, live meetings and the meeting copilot — Design

Date: 2026-11-26. Status: approach A chosen by the owner. The copilot only suggests; the owner ticks pending items
off by hand.

## Intent

During client meetings the owner wants everything that matters for the project at hand:

- the questions they meant to ask (for example the ones an agent wrote into a `.md` in the project's session);
- how the tickets and tasks are going;
- what earlier meetings decided;
- what is being said right now.

They also want to ask questions while the meeting runs. Agents working in the owner's Claude Code sessions should be
able to leave such "pending items" for the owner directly in Quorum, so they are not lost in a file.

The owner explicitly wants suggestions only. Quorum never ticks an item off by itself.

## Goals (three plans, in this order; each is useful on its own)

1. **Plan 15 — pending items.**
   - A per-project list of pending items. They are deliberately generic: a question for the client, a task, a point
     to raise, a reminder. There are no kinds; the owner will find out in practice what they use them for.
   - They are created three ways:
     - by agents, through a Quorum tool in every Claude Code session;
     - by the owner, by hand;
     - from meetings: the owner turns an open point into a pending item with one tap.
   - The list is shown in the project briefing and on the project page.
2. **Plan 16 — live meetings.**
   - A "Record meeting" button in the app records the microphone, plus system audio on the Windows app when available.
     It streams audio chunks every 15 s.
   - The owner's laptop transcribes each chunk as it arrives, and the transcript appears on screen during the meeting.
   - When the owner stops, the normal Plan 14 pipeline (diarization, summary) runs on the whole recording.
3. **Plan 17 — the copilot.**
   - The live meeting page shows the project's open pending items, which the owner ticks by hand.
   - It has a chat with Claude through ccapi. Claude knows the pending items, tickets, recent meetings and the live
     transcript.
   - Every few minutes it gives soft suggestions, for example "this seems to have been discussed at 12:30 — tick it?"
     or "not asked yet: the annual plan price".

## Non-goals

- Automatic ticking, or any automatic change to pending items or tickets by the copilot.
- A copilot that runs as a Claude Code session with repo access (approach B, rejected).
- Bots that join calls; calendar integration.
- Sharing pending items with other people.

## Anti-goals

- **Quota.**
  - Suggestions use the cheapest model (Haiku through ccapi), at most once every 3 minutes while the transcript grows.
  - Chat answers use the model chosen in Settings.
  - Nothing runs when no meeting is live and no one is chatting.
- **Privacy.** Audio still never leaves the owner's machines. Only text goes to ccapi, as today.
- **Silent loss.** If the laptop is off, live chunks are kept and transcribed later, and the page says so.

## Approaches (owner chose A)

| | Trade-off |
|---|---|
| **A. Hub chat through ccapi with hub-built context** | Fast, cheap on quota, works without an open session. It cannot read repo files, but pending items carry what agents found. **Chosen.** |
| B. Copilot as a Claude Code session in the project repo | Full repo access and tools, but more quota, slower, and it mixes the meeting with coding work. |

## Design

### Plan 15 — pending items

- **Store.** `pendings(id, project_id, text ≤ 300, detail ≤ 4000, note ≤ 2000, source: agent|manual|meeting, source_ref, client_key, status: open|done|dropped, created_at, updated_at, done_at)`.
  - Items have no kind and no assignee. Anything else (who, context, a link) goes in `detail` as free text.
  - `note` is an optional free-text note the owner can write when closing an item, for example the client's answer.
    Agents and the copilot see it later.
  - `source_ref` is the session id for agents, or the meeting id plus open-point index for meetings.
- **Device API.**
  - `GET /api/projects/{id}/pendings?status=open|all`
  - `POST /api/projects/{id}/pendings {text, detail?, clientKey?}`
  - `PATCH /api/pendings/{id} {text?, detail?, note?, status?}`
  - `DELETE /api/pendings/{id}`
  - All are validated, with English errors.
  - Changes publish `pending_changed {projectId}` and the project briefing event.
- **Agent tool.** The Quorum plugin ships an MCP server, `quorum`, started as `quorumd mcp` over stdio and declared in
  the plugin manifest. It exposes:
  - `pending_add(text, detail?)` returns `{id}`;
  - `pending_list(status?)` returns the project's items;
  - `pending_done(id)`.
  - **Session and project.** The MCP process finds its session from what Claude Code provides to plugin MCP servers
    (the session id in env or the cwd; the builder confirms from the host types), then asks the local daemon, which
    asks the hub. The hub maps the session to its project.
  - **No project.** The tool returns a clear error: "This session has no Quorum project; link the folder to a
    project in Quorum first".
  - **Skill.** A short skill in the plugin tells agents when to use it: anything the owner must not forget
    (questions for someone, tasks, points to raise), or the owner saying "anota/recuérdame".
    Agents must say what they added.
- **App.**
  - The briefing gains a "Pending" section: open items, each with a checkbox. Ticking it closes the item and offers
    an optional note.
  - The project page has the full list: add, edit, tick (with an optional note), drop, and a filter for open or all.
  - The meeting page shows "Add as pending" on each open point.
  - The phone shows the same in one column.

### Plan 16 — live meetings

- **Start.** "Record meeting" on a project, or unassigned from Settings → Meetings.
  - It creates a meeting in a new status `live`.
  - The app captures audio with `MediaRecorder` (Opus/WebM) in 15 s slices.
  - **Windows app:** the microphone plus system audio. A spike first checks WebView2 `getDisplayMedia({audio})` for
    system audio. If that fails, only the microphone is recorded and the page says "Recording your microphone only";
    the system-audio helper stays in the later Stage 2 recorder.
  - **Phone:** the microphone, with the screen kept on (a wake lock). Screen-off recording is the later Android
    recorder.
- **Upload.** `POST /api/meetings/{id}/live/{seq}` sends each slice in order, and `POST /api/meetings/{id}/live/stop`
  ends the recording.
  - Slices are appended to the meeting's audio on the hub.
  - A lost slice is retried, and the hub accepts out-of-order sequence numbers and assembles them in order.
- **Live transcription.**
  - For each new slice the hub queues a `transcribe_chunk` job on the transcribe machine. The job gets the slice plus
    2 s of the previous slice for context.
  - The worker keeps the Whisper model loaded while a meeting is live, through a resident worker process for the
    duration of the live meeting. It returns segments with absolute times.
  - The hub appends them and pushes `meeting_live {id, segments}` to apps.
  - Target: text on screen within 20 s of being spoken.
- **Machine off.** If the laptop is off or busy, slices queue. The page says "Transcription waiting for <machine>"
  and catches up when the machine is back.
- **Stop.** The whole recording goes through the Plan 14 pipeline: a full transcription, which replaces the live
  segments, then diarization, then summary. Live segments have no speaker labels.

### Plan 17 — copilot

- **Live meeting page.** A three-part layout:
  - the live transcript, auto-scrolling;
  - open pending items, ticked by the owner;
  - the chat.

  On the phone these are tabs.
- **Chat.** `POST /api/projects/{id}/copilot {meetingId?, message, history[]}` returns `{answer}`.
  - The hub builds the context:
    - open pending items;
    - the owner's open tickets and recent changes, from the briefing;
    - the summaries of the last 3 meetings of the project;
    - the live transcript: the last 10 minutes verbatim, with earlier parts summarised.
  - It calls ccapi with the model from Settings → Meetings (default Sonnet), with a context budget of about 30k
    tokens.
  - Answers cite transcript times when they use the transcript.
  - Chat history is kept per meeting, so it can be reopened later.
- **Suggestions.** While a meeting is live and the transcript has grown, the hub runs a Haiku pass every 3 minutes
  (only if there are open items).
  - For each open item it returns `discussed (with a quote and time) | not yet`.
  - The app shows a chip on each item: "Seems discussed at 12:30 — tick?" (one tap ticks it, the owner's action) or
    "Not asked yet".
  - Near the end (stop pressed, or the 45-minute mark of a long meeting), a "Still open" summary lists the items not
    yet discussed.
- **Settings.** Copilot on or off, the chat model, and whether suggestions run.

## Constraints

- All repo content in English, with no personal data and no real employer names.
- Initial JS stays at 655 kB or less (currently about 651). All new UI goes in lazy chunks, and pending items in the
  briefing reuse the lazy Project chunk.
- The hub stays Go with no cgo, and the worker is reused. The MCP server is part of `quorumd`, so there is no new
  binary to install.
- Agent tools never change anything outside Quorum's pending items.
- Use semantic tokens only, 44 px targets, 320 px layouts, and ScrollArea for scroll regions.

## Calls made while writing this up (owner can override)

- **Hub unreachable:** `pending_add` fails fast with "Quorum hub unreachable; the item was not saved". The agent must
  tell the owner. There is no offline queue. The tool sends a client-generated key, so a retry never duplicates.
- **Project resolution:** resolved again on every call, so linking a folder later just works. `pending_list` and
  `pending_done` act only on the session's project; an id from another project is refused.
- **Agent flood guard:** an open item with the same text (case and whitespace-insensitive) in the project returns
  the existing id instead of creating a new one. There is a cap of 50 open agent items per project. Agent items carry
  a "new" dot until the owner opens the project. No push notifications.
- **From meetings:** the item copies the open point's text and keeps `source_ref = meetingId`. Adding the same text
  from the same meeting twice is refused, and the button shows "Added".
- **`pending_list`:** open items by default, `detail` cut to 200 characters, at most 50 items.
- **Order:** oldest first. Done and dropped items are kept, with a "Show done" filter.
- **Tool plumbing (found while planning):** the Quorum mod registers the tools itself (`$.tool.register`, answered
  in `tool.run` hooks), so no MCP server or extra process is needed. The tools still appear as
  `mcp__quorum__pending_*`. The mod calls the local daemon, which forwards to the hub with its machine token.
- **Events:** open items are part of the briefing payload, so `project_briefing_changed` replaces the separate
  `pending_changed` event.
- **Plan 17 fields:** no new fields reserved now.

## Left to the builder

- How the MCP server learns its session; confirm from the host types, with cwd mapping as the fallback.
- MediaRecorder container details per platform, and slice overlap handling.
- The suggestion prompt wording within the rules above.
