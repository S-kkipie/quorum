# Meetings in Quorum (record, transcribe, summarise, feed the project) — Design

Date: 2026-11-25. Status: approach A chosen by the owner ("A y luego B"). Research notes:
`scratchpad/meet-research.md` (local only).

## Intent

The owner works for several employers. Their meetings hold decisions, open points and tasks that today are lost or
live in other people's tools. They want Granola-style meeting notes without paying for Granola and without
installing a separate app.

Quorum should become the owner's complete work centre: a meeting is recorded or uploaded, transcribed on the
owner's own laptop, summarised, and filed under a project. The result feeds that project's briefing (Plan 13) and
can turn the owner's actions into tickets.

**Where meetings happen:**
- Online meetings (Meet, Teams, Zoom) on the Windows laptop.
- In-person meetings, recorded on the laptop or the phone.

**Hardware:** the laptop has an RTX 5080 (16 GB VRAM) and 32 GB RAM; WSL2 sees the GPU.

## Goals

1. **Stage 1 (Plan 14): the meeting pipeline.**
   - Upload an audio file from any Quorum client (web, Windows app, phone) to a project, or leave it unassigned.
   - The laptop transcribes it locally on the GPU and summarises it.
   - The meeting appears in the project:
     - a list of meetings;
     - a meeting page with summary, decisions, open points, actions, attendees and the searchable transcript;
     - its decisions, open points and the owner's actions in the briefing's "From meetings".
   - An action can become a GitHub issue in one click for GitHub-connected projects.
2. **Stage 2 (Plan 15): the recorders.**
   - Record from `Quorum.exe`: microphone and system audio, kept as separate tracks.
   - Record from the Android app with the screen off: a foreground service with a resumable chunked upload.
3. **Stage 3 (later, approach B): live notes.** The owner types notes during the meeting while a live transcript
   runs; at the end the AI merges the notes and the transcript.

## Non-goals (for Stages 1–2)

- Live transcription and live note-taking (Stage 3).
- Calendar integration and bots that join calls.
- Recognising recurring voices across meetings automatically (a later plan). Stage 1 separates speakers and lets the
  owner name them per meeting.
- Sharing notes with other people.

## Anti-goals

- No paid service is required. Local models are the default, and a cloud API is used only when the owner configures
  their own key or chooses Claude through ccapi.
- Audio never goes to a third party unless the owner explicitly picks a cloud summary provider. Transcription is
  always local, and only text is sent to a cloud summariser.
- No invented facts. Owners, dates and decisions not stated in the transcript stay "unassigned" or "unknown".
- No public repo leaks. Recordings, transcripts and employer names never enter the repo; tests use made-up content.

## Approaches (owner chose A, then B later)

| Approach | Trade-off |
|---|---|
| **A. Record or upload, then process after the meeting** | Simplest and most accurate, fewer moving parts. **Chosen first.** |
| B. A plus live notes and a live transcript | Most Granola-like; needs streaming transcription and a live UI. **Later, on top of A.** |
| C. Run Meetily separately and import its notes | Quickest, but it is the separate app the owner does not want. Rejected. |

## Design — Stage 1

### Components

- **Hub (server):**
  - stores meetings and their audio;
  - queues processing jobs;
  - assigns each job to a machine that reports the `transcribe` capability;
  - serves the API and pushes events.
- **Worker (the laptop's `quorumd`, in WSL2):**
  - advertises `transcribe` when its meeting worker is installed and a CUDA GPU is visible;
  - downloads the audio, runs transcription and summarisation, and uploads the result.
  - The worker is a small Python program in a venv that the daemon manages (`quorumd meetings setup`), run by the
    daemon as a subprocess. It must never block the daemon.
- **App:** upload, a project Meetings list, the meeting page, settings, and the briefing integration.

### Processing

1. **Audio.**
   - Accept `m4a`, `mp3`, `wav`, `ogg`/`opus`, `webm`, `flac`, up to 400 MB per file.
   - The worker converts with `ffmpeg` to 16 kHz mono WAV per channel. When the file has 2 channels from a Quorum
     recorder (`channels: me|others` metadata), each channel is transcribed separately and the segments are merged
     by time with the speaker labels "Me" and "Others".
2. **Transcription.**
   - Default engine: faster-whisper with `large-v3-turbo`, CUDA float16, with VAD.
   - Language: Spanish by default; per meeting or auto-detect.
   - The engine sits behind an interface, so Parakeet can replace it if the spike shows it is better on the owner's
     audio.
   - Output: segments `{start, end, speaker, text}`.
3. **Summary.**
   - Providers, chosen in Settings → Meetings:
     - `local`: Ollama on the laptop. The model is chosen after the spike, between `gemma3:12b` and `qwen3:14b`.
     - `ccapi`: Claude through the hub's existing ccapi path.
     - `openai-compatible`: base URL, model and API key, stored write-only in the hub.
   - Summarisation runs after transcription, with GPU memory freed in between.
   - Long transcripts are summarised per 15-minute section, then merged.
   - The output is JSON: `{title, summary (3–5 lines), topics[], decisions[], openPoints[], actions[{text, owner,
     due}], attendees[]}`, written in the meeting's language.
   - Prompt rules: never invent owners or dates; cite transcript timestamps for decisions and actions; use a project
     glossary (names, product terms) when provided.
4. **Mine.** An action is the owner's when its owner matches the project's "You are" person or the owner's
   configured aliases (Settings → Meetings → "Names I go by", e.g. "Adrian", "Adri").

### Hub data and API

- `meetings(id, project_id NULL, title, started_at, duration_s, language, status: uploaded|queued|transcribing|summarising|ready|failed, error, provider, created_at, updated_at)`.
- `meeting_audio(meeting_id, path, bytes, mime, channels_meta, expires_at)`.
  - Audio is stored on the hub disk under `~/.local/share/quorum/audio/`.
  - It is deleted 30 days after the meeting is ready; the transcript and summary are kept.
- `meeting_segments(meeting_id, idx, start_ms, end_ms, speaker, text)`.
- `meeting_summary(meeting_id, json)`.
- **Briefing integration.** A ready meeting with a project writes its decisions, open points and actions into
  `meeting_notes` (source `quorum`). The briefing needs no other change, and "New since" sees it through
  `first_seen_at`.
- **Routes:**
  - `POST /api/meetings` takes multipart audio plus `{projectId?, title?, startedAt?, language?}` (resumable chunked
    upload is Stage 2).
  - `GET /api/meetings?projectId=` and `GET /api/meetings/{id}` (summary + segments).
  - `PATCH /api/meetings/{id}` (title, project, language).
  - `POST /api/meetings/{id}/reprocess` (re-summarise, optionally with another provider).
  - `DELETE /api/meetings/{id}`.
  - `GET /api/meetings/{id}/audio` (streamed, device auth).
  - `POST /api/meetings/{id}/actions/{n}/issue`: creates a GitHub issue in the project's repo through the hub's
    `gh`, with the action text, the meeting title and date, and a link back. It records the issue URL on the action.
- **Jobs.**
  - The hub hands a queued meeting to an online machine with `transcribe` capability through a daemon RPC.
  - The daemon reports progress (`transcribing 40%`, `summarising`).
  - Jobs survive hub restarts. If the machine goes offline mid-job, the meeting is re-queued.
  - One job runs at a time per machine.
- **Events:** `meeting_changed {id, projectId, status}`. A ready meeting also triggers the project briefing event.

### App

- **Project page.**
  - A "Meetings" section after "From meetings": list rows with title, date, duration and status.
  - An "Upload recording" button, which opens a file picker (and the system share target on Android in Stage 2).
- **Meeting page (centre pane on desktop, full screen on phone).**
  - Header: title (editable), date, duration, project (changeable), status with progress.
  - Summary.
  - Decisions and open points.
  - Actions with owner and due date. Mine first. Each action has "Create issue" (GitHub projects) or "Copy".
  - Attendees.
  - Transcript: speaker, time, text; searchable; clicking a time plays the audio there.
  - The ⋯ menu: re-summarise with another provider, delete.
- **Settings → Meetings:**
  - summary provider and its settings;
  - default language;
  - names I go by;
  - the worker status per machine (installed, GPU found, models downloaded).
- **Unassigned meetings** appear in an "Inbox" list under Settings → Meetings, or in the phone's Projects tab,
  until they are assigned to a project.

### Worker setup (laptop)

- `quorumd meetings setup`:
  - creates the venv;
  - installs `faster-whisper` (with a CUDA 12.8+ build for Blackwell, `sm_120`) and `ffmpeg` if missing;
  - downloads the Whisper model;
  - optionally installs Ollama and pulls the chosen model.
- It checks the GPU with a 5-second test. The daemon then advertises `transcribe`.
- No Hugging Face token is needed in Stage 1, because diarization is off.

### Spikes (first task of Plan 14; they decide the defaults)

1. Whisper `large-v3-turbo` against Parakeet `tdt-0.6b-v3`, on about 30 minutes of the owner's real Spanish
   meeting audio: word error rate by eye on sample passages, speed, and VRAM use.
2. `gemma3:12b` against `qwen3:14b` on one transcript: accuracy of decisions and actions, Spanish quality, time.
3. Whether WebView2 in `Quorum.exe` can capture system audio with `getDisplayMedia`. This decides the Stage 2
   desktop recorder.

## Design — Stage 2 (Plan 15, summary)

- **Desktop recorder in `Quorum.exe`.**
  - A Record button in the app (desktop only).
  - The microphone and system audio are recorded as two channels ("me" and "others") to an Opus file, then
    uploaded.
  - If WebView2 cannot capture system audio, a small capture helper (WASAPI loopback, through `malgo`
    cross-compiled, or a tiny native exe) streams PCM to `Quorum.exe`.
- **Android recorder.**
  - A native Kotlin plugin: a foreground service of type `microphone` that records Opus or AAC mono at 32 kbps.
  - It keeps recording with the screen off and shows a persistent notification with the elapsed time and a Stop
    button.
  - A resumable chunked upload (WorkManager) sends the file after recording, and retries on a bad network.
  - Android share target: "Share to Quorum" for audio files.
- **Resumable upload API:** `POST /api/meetings/uploads` → `{uploadId}`, `PUT …/{uploadId}?offset=` for chunks,
  `POST …/{uploadId}/complete`.

## Constraints

- All repo content in English, with no personal data, recordings, transcripts or employer names. Tests use
  synthetic audio (e.g. generated tones, or TTS of made-up text) and made-up transcripts.
- The hub stays Go with no cgo. The daemon's Python worker is optional: machines without it simply don't advertise
  `transcribe`.
- Secrets (API keys) are write-only in the hub, never logged and never returned.
- Initial JS stays at 655 kB or less. The meeting UI lives in lazy chunks.
- Hub disk: audio is capped at 400 MB per file, with 30-day retention; the app shows hub disk usage for meetings in
  Settings.

## Left to the builder

- Exact Python packaging, the model download location, and GPU memory release between steps.
- The section-merge prompt details within the rules above.
- How progress percentages are computed.

## Decisions made after the builder check (designer's calls)

1. **The hub orchestrates; the worker transcribes.**
   - The worker returns segments.
   - The hub runs the summary through an extended `summary` model interface: `Complete(ctx, prompt, maxTokens, json)`
     for ccapi and openai-compatible providers, with a longer timeout.
   - For `local`, the hub asks the worker to run Ollama through a second job step, `summarize_local`, which returns
     JSON. API keys never leave the hub.
2. **Asynchronous jobs.**
   - A short RPC `meeting_job_start {jobId, attempt, step, audioURL, resultURL, settings}` returns immediately.
   - The daemon then sends `meeting_progress {jobId, attempt, pct, stage}` envelopes over the existing link.
   - Large results (segments, summary JSON) are POSTed over HTTP to `resultURL`.
   - Old daemons ignore the new envelope types.
3. **Transfers.**
   - `audioURL` and `resultURL` are per-job signed URLs (random token, 2 h expiry, single job) that need no device
     token.
   - The hub streams uploads to disk, with a per-route 400 MB limit and no buffering, and refuses new audio when
     less than 2 GB is free on the hub disk.
   - **Resumable chunked upload moves into Stage 1:** 8 MB chunks, `POST /api/meetings/uploads` → `PUT …?offset=` →
     `complete`. The app shows progress per chunk. This avoids WebView memory problems and any proxy limits.
4. **`meeting_notes` gains a `source` column** (`connector` by default, `quorum` for meetings).
   - `ReplaceMeetingNotes` replaces only `connector` rows.
   - Quorum rows are keyed by meeting id. Their `first_seen_at` is the time the meeting became ready. They are
     rewritten when a meeting is reprocessed or its project changes, and deleted with the meeting.
   - The meeting page is the source of truth; `meeting_notes` is a projection.
5. **"Mine."**
   - An action is mine when its owner matches the project's "You are" person or one of the global "Names I go by",
     compared case-insensitively.
   - The projection writes mine as `- <person or first alias>: text`, and `personActions` also accepts the aliases.
   - With no person and no aliases nothing is mine. An unassigned owner is never mine.
6. **Capability and supervision.**
   - `MachineCaps` gains `Transcribe`.
   - The daemon supervises one worker subprocess at a time, kills it on shutdown, and stops it when the hub cancels
     the job.
   - Jobs carry `jobId` and `attempt`. A result from an older attempt is discarded.
   - A job whose machine has been offline for more than 2 minutes is re-queued with `attempt+1`.
7. **Spikes.**
   - They run on owner-provided audio when the owner supplies it, otherwise on a public Spanish recording, kept out of
     the repo.
   - Until then the defaults are provisional: `large-v3-turbo` and `gemma3:12b`.
   - Spike 3 (WebView2 system audio) moves to Stage 2.
8. **GitHub issues.**
   - Issues are created in the repo from the project's GitHub connector settings (`repo`), with `gh` run through the
     hub's login shell as the GitHub connector does. Only projects with a GitHub connector show the button.
   - Actions live in a `meeting_actions(meeting_id, id, text, owner, due, mine, ts_ms, issue_url)` table with stable
     ids.
   - On reprocess, actions that have an `issue_url` are kept and the rest are replaced.
   - Creating an issue is idempotent: if `issue_url` is set, the button opens the issue.
9. **Editing.** Title, project and language are editable. The summary, decisions and actions are read-only; to
   change them the owner re-summarises.
10. **Audio playback** uses a short-lived signed URL (`GET /api/meetings/{id}/audio-url` → `{url}`, valid 1 h), so
    the `<audio>` element needs no auth header.

## Owner update (2026-11-25): telling people apart is a Stage 1 feature

- **Diarization.**
  - The transcript separates speakers ("Speaker 1", "Speaker 2", …) for in-person audio.
  - For two-channel recordings, the `Me` channel stays "Me" and the `Others` channel is diarized.
  - The engine is chosen by the spike between pyannote (community-1 or 3.1; needs a free Hugging Face token accepted
    once by the owner, then offline) and sherpa-onnx (no token), on public multi-speaker Spanish audio.
  - `MeetingSegment.speaker` holds a stable label per meeting.
- **Naming speakers.** On the meeting page the owner renames a speaker label, for example "Speaker 2" to "Luis".
  - The rename applies to every segment of that meeting.
  - The rename is passed to a re-summary (owners in actions use the names).
  - Stored as `meeting_speakers(meeting_id, label, name)`, set with `POST /api/meetings/{id}/speakers {label: name}`
    (a PUT on that path would clash with the upload route).
- **Later plan:** voice embeddings per named person, to suggest or auto-apply names in future meetings.
