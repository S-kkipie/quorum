# Meetings, Stage 1: upload, transcribe, summarise, feed the project — Implementation Plan (Plan 14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Upload a meeting recording from any Quorum client. The owner's laptop transcribes it on the GPU, the hub
summarises it with the configured provider, and the meeting appears in its project: a meeting page, the briefing's
"From meetings", and one-click GitHub issues from actions.

**Architecture:**
- **Hub:** stores meetings, audio (streamed to disk through a resumable chunked upload) and jobs. It hands
  transcription to a machine that reports the `Transcribe` capability through an async RPC, with progress envelopes
  and results POSTed to a signed URL.
- **Summary:** the hub summarises through an extended model interface (ccapi or openai-compatible). For the `local`
  provider it asks the worker to run Ollama.
- **Worker:** a Python venv the daemon manages, using faster-whisper on CUDA.
- **Projection:** meetings write their decisions and actions into `meeting_notes` (source `quorum`), which the
  briefing already reads.

**Tech Stack:**
- Go: hub, daemon, store.
- Python 3.12: faster-whisper with CUDA 12.8+ and ffmpeg, plus the Ollama HTTP API.
- React 19, with shadcn and AI Elements, and vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-quorum-meetings-design.md`. Read all of it, including "Decisions made
after the builder check", which override the body.

## Global Constraints

- **Repo content.** All in English. No personal data, no real recordings or transcripts, and no employer names. Tests
  use synthetic audio (generated tones, or TTS of made-up text, made at test time and never committed) and made-up
  transcripts.
- **Privacy.** Transcription is always local. Only text goes to a cloud summariser, and only when the owner chose
  one. API keys are write-only in the hub: never logged, never returned, and never sent to a machine.
- **Upload.**
  - Resumable chunked upload with 8 MB chunks and at most 400 MB per meeting.
  - Streamed to disk under `~/.local/share/quorum/audio/` on the hub.
  - New uploads are refused when the hub disk has less than 2 GB free.
  - Audio is deleted 30 days after the meeting is ready.
- **Jobs.**
  - Async RPC `meeting_job_start {jobId, attempt, step, audioURL, resultURL, settings}`, which returns immediately.
  - Progress through `meeting_progress {jobId, attempt, pct, stage}` envelopes.
  - Results are POSTed to `resultURL`.
  - Signed URLs are random, single-job and expire after 2 h.
  - One job at a time per machine.
  - A job is re-queued with `attempt+1` after its machine has been offline for more than 2 min; results from a stale
    attempt are discarded.
- **Steps.**
  - `transcribe` returns `segments[{start_ms, end_ms, speaker, text}]`.
  - `summarize_local` (Ollama) returns the summary JSON.
  - The ccapi and openai-compatible summaries run in the hub.
- **Summary JSON.** `{title, summary, topics[], decisions[{text, ts_ms?}], openPoints[{text, ts_ms?}],
  actions[{text, owner, due, ts_ms?}], attendees[]}`, written in the meeting's language. Never invent owners or
  dates; unknown means "unassigned" or empty. Long transcripts are summarised per 15-minute section, then merged.
- **Two-channel audio.** Files with the metadata `channels: me|others` are transcribed per channel and labelled
  `Me` / `Others`. Otherwise the speaker is empty.
- **Provisional defaults** (the spikes may change them): Whisper `large-v3-turbo` with CUDA float16 and VAD; Ollama
  `gemma3:12b`; language `es`.
- **"Mine."** An action is mine when its owner matches the project person or the global aliases, trimmed and
  case-insensitive. An unassigned owner is never mine.
- **GitHub issues.** Created through `gh` in the hub's login shell, in the project's GitHub connector `repo`. The issue
  URL is stored on the action, so creating twice opens the existing issue.
- **App.**
  - Initial JS stays at 655 kB or less (entry plus modulepreloads), and the meeting UI lives in lazy chunks.
  - Semantic tokens only, 44 px touch targets, 320 px works, and ScrollArea for any new scroll region.
- **Commits:** author and committer are `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, and messages end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests:** `go test ./...` (plus `-race` on `internal/hub/...` and `internal/daemon/...`), `make proto`,
  `make typecheck`, `cd app && npx vitest run`, `npm run build`. Python worker tests run with `pytest` against fake
  engines; the GPU is only used in the controller's spike and E2E.
- **Browsers:** subagents never use a browser. The controller does the visual checks and the real end-to-end run.

## Review Focus

1. **The laptop goes off mid-transcription.** The job is re-queued, the late result from the old attempt is
   discarded, and the meeting finishes when the laptop comes back.
2. **A 2 h, 120 MB upload from the phone over a flaky network.** Chunks resume from the last offset, nothing is
   buffered in memory, and the disk check holds.
3. **The project's connector sync runs after a meeting is ready.** The meeting's notes survive, because
   `ReplaceMeetingNotes` only replaces connector rows.
4. **Re-summarising with another provider.** Actions that already have issues keep them, and the briefing projection
   is rewritten, not duplicated.
5. **The worker reports a CUDA or model error.** The meeting is `failed` with a readable error and a Retry button. No
   endless retries.

---

### Task 1: Spikes (controller-run, no commits)

- [ ] **Audio.** Use the owner's Spanish recording if they provide one. Otherwise use a public Spanish meeting-like
  recording of 20–30 minutes, kept outside the repo.
- [ ] **Transcription.** In WSL on the RTX 5080, compare faster-whisper `large-v3-turbo` with Parakeet
  `tdt-0.6b-v3`: speed, VRAM, and a by-eye error check on 5 passages.
- [ ] **Summary.** With Ollama, compare `gemma3:12b` and `qwen3:14b` on the transcript. Score the decisions and
  actions against the passages.
- [ ] **Record** the chosen defaults in the ledger. They become the plan's defaults.

### Task 2: Hub — meetings store, chunked upload, audio, retention

**Files:**
- `internal/proto/proto.go`, then `make proto`: `Meeting`, `MeetingSegment`, `MeetingSummary`, `MeetingAction`.
- `internal/hub/store/meetings.go` (new), plus a migration. Tables:
  - `meetings`;
  - `meeting_audio`;
  - `meeting_segments`;
  - `meeting_summary`;
  - `meeting_actions`;
  - `meeting_uploads` (upload id, meeting id, offset, path, expires);
  - and a `source` column on `meeting_notes`, `connector` by default, with `ReplaceMeetingNotes` scoped to connector
    rows.
- `internal/hub/meetings_upload.go` (new): `POST /api/meetings/uploads`, `PUT /api/meetings/uploads/{id}?offset=`,
  `POST /api/meetings/uploads/{id}/complete`. The complete call creates the meeting in status `uploaded` and then
  `queued`.
- `GET /api/meetings`, `GET`, `PATCH` and `DELETE /api/meetings/{id}`, `GET /api/meetings/{id}/audio-url` returning
  a 1 h signed URL, and the signed audio route.
- Retention and the disk check.
- `app/src/lib/api.ts` helpers: `uploadMeeting(file, opts, onProgress)` chunks with fetch and resumes,
  `listMeetings`, `getMeeting`, `patchMeeting`, `deleteMeeting`, `meetingAudioURL`.

- [ ] **Tests first:**
  - chunk sequencing (an offset mismatch gives 409 with the current offset; resume works);
  - the 400 MB cap gives 413;
  - less than 2 GB free gives 507 (fake statfs);
  - the stream never buffers a whole chunk set (bounded memory with a 50 MB synthetic stream);
  - complete creates a queued meeting;
  - the signed audio URL expires;
  - retention deletes audio after 30 days ready (fake clock) and keeps the transcript;
  - `ReplaceMeetingNotes` keeps `quorum` rows;
  - delete cascades.
- [ ] **Commit** `hub: meetings store, resumable upload, audio retention`.

### Task 3: Hub jobs + daemon worker supervision + Python worker

**Files:**
- `internal/hub/meetings_jobs.go` (new):
  - the queue;
  - assignment to online machines with `Transcribe`;
  - signed result URLs (`POST /api/meeting-jobs/{token}/result`);
  - progress envelopes;
  - offline re-queue;
  - attempt checks;
  - `failed` after 3 attempts or a worker error.
- `internal/proto`: `MachineCaps.Transcribe`, plus the envelope and RPC types.
- `internal/daemon/meetings.go` (new):
  - advertises `Transcribe` when `~/.local/share/quorum/meetings/venv` exists and a CUDA check passed;
  - RPC `meeting_job_start` launches `worker.py` as a subprocess, only one at a time;
  - streams progress lines (JSON per line on stdout) as envelopes;
  - uploads the result through `resultURL`;
  - kills the worker on shutdown or cancel.
- `internal/daemon/meetings_setup.go`: the `quorumd meetings setup` command. It creates the venv, pip-installs
  pinned versions, checks ffmpeg, downloads the Whisper model, and runs a CUDA check. Ollama is optional: if
  missing, it prints how to install it.
- `worker/meetings/worker.py` (new, in the repo, deployed with the daemon), plus pytest.
  - It reads a job JSON on stdin and downloads the audio.
  - It converts with ffmpeg and splits channels when `channels_meta` says so.
  - The engine interface: `FasterWhisperEngine` and `FakeEngine` for tests. Transcription emits progress.
  - For `summarize_local`, it calls Ollama `/api/chat` with JSON format and `num_ctx` set, sectioned and merged.
  - It writes the result JSON on stdout.

- [ ] **Tests first:**
  - **Hub:** assignment picks a `Transcribe` machine; no capable machine leaves the job queued; a stale attempt is
    discarded; an offline machine for more than 2 min re-queues; 3 failures give `failed` with the error; progress
    updates the meeting status; a bad result token gives 403.
  - **Daemon:** a fake `worker.py` (a shell script echoing JSON lines) shows one job at a time, progress forwarded,
    kill on cancel, and the result posted.
  - **pytest:** channel split and merge order with `Me`/`Others` labels; the section split for long transcripts;
    the summary JSON validated and repaired (a missing field becomes empty, an invented owner is not added); the
    fake engine path end to end.
- [ ] **Commit** `meetings: transcription jobs, daemon worker supervision, Python worker`.

### Task 4: Hub summaries, projection into the briefing, GitHub issues, reprocess

**Files:**
- `internal/hub/summary/model.go`: `Complete(ctx, prompt string, maxTokens int, json bool)` for ccapi and a new
  openai-compatible client (base URL, model, key from a write-only setting). The existing project summary is
  unchanged.
- `internal/hub/meetings_summary.go` (new):
  - section, prompt, merge and validate, with the same rules and JSON as the worker;
  - for the `local` provider, run the worker `summarize_local` step;
  - write the summary and actions, computing "mine" with the person plus the aliases;
  - project into `meeting_notes` with source `quorum`, keyed by meeting id;
  - fire the project briefing event.
- Speaker names: `PUT /api/meetings/{id}/speakers {label: name}` → stored in `meeting_speakers`, applied when serving segments and passed to summaries.
- `POST /api/meetings/{id}/reprocess {provider?}` re-summarises, keeping actions that have an `issue_url`.
- `POST /api/meetings/{id}/actions/{actionId}/issue` creates the issue (or returns the existing URL) through `gh` in
  the connector repo, with a body containing the action, the meeting title and date, and the Quorum meeting link.
- `GET`/`PUT /api/settings/meetings`: provider, model, base URL, key (write-only), language and aliases.
- The briefing's `personActions` accepts aliases.

- [ ] **Tests first:**
  - a fake model returning JSON with an invented owner: the owner is dropped to unassigned unless stated in the
    transcript (owners must appear in the transcript text);
  - sectioning at 15 minutes;
  - "mine" with aliases;
  - the projection appears in the briefing's meetings and is rewritten on reprocess, not duplicated;
  - a connector sync keeps it;
  - issue creation is idempotent (fake `gh`), and a project without a GitHub connector gives 400;
  - the settings key is never returned;
  - the openai-compatible client against `httptest`.
- [ ] **Commit** `meetings: summaries, briefing projection, GitHub issues from actions`.

### Task 5: App — upload, meetings list, meeting page, settings

**Files:**
- `app/src/components/meetings/*` (new): `UploadMeeting.tsx` (picker, progress, resume), `MeetingsList.tsx`,
  `MeetingPage.tsx`, `Transcript.tsx` (meeting transcript with search and click-to-seek), `ActionRow.tsx`.
- `app/src/screens/Project.tsx`: a Meetings section after "From meetings", with an "Upload recording" button.
- Centre or phone route `{kind:'meeting', id}` in `lib/nav.ts`.
- Settings → Meetings: provider, model, base URL, key (write-only "Saved"), language, names I go by, worker status
  per machine (caps), and hub audio disk usage.
- The unassigned meetings inbox in Settings → Meetings.
- Refetch on `meeting_changed`.

- [ ] **Tests first:**
  - **Upload:** progress, resume after a failed chunk, and the 400 MB pre-check.
  - **Meeting page:** status and progress while processing; "failed" shows the error and Retry; a ready meeting
    shows sections in order; mine first in actions; "Create issue" only for GitHub projects and opens the URL once it
    exists.
  - **Speakers:** each speaker label can be renamed inline; all its segments update; "Re-summarise with names" offered after a rename.
  - **Transcript:** search highlights matches, and a click seeks the audio (`currentTime`).
  - **Settings:** the key is never echoed.
  - **Layout:** 320 px with no overflow, and the initial JS budget test.
- [ ] **Commit** `app: meetings upload, list, meeting page and settings`.

### Task 6: Controller — real end-to-end check

- [ ] Run `quorumd meetings setup` on the laptop, then deploy.
- [ ] Upload the spike recording to a test project, watch the progress, and check the meeting page, the briefing
  meetings section and one GitHub issue, in a scratch repo, never an employer repo.
- [ ] Delete the test meeting and project.
- [ ] Report the timings to the owner.
