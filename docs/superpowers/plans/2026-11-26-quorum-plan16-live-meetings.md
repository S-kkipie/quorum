# Plan 16 — Live Meetings (Microphone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Record meeting" records the microphone in every app (web, `Quorum.exe`, Android) and streams 15 s
Opus/WebM slices to the hub. The owner's transcribe machine turns each new stretch into text within about 20 s.
On stop, the normal Plan 14 pipeline runs on the whole recording.

**Architecture:**
- The app runs one continuous `MediaRecorder` and PUTs each slice to the hub. The hub writes the slices in order
  to the meeting's single audio file, which is also the file the final pipeline reads.
- Each accepted slice makes sure the meeting has one queued `transcribe_chunk` job. The job's settings are built
  at dispatch time, so a backlog is caught up in one job.
- On the machine, the daemon keeps one resident `worker.py --live` process with Whisper loaded and feeds it chunk
  jobs on stdin. The worker mirrors the growing file with HTTP Range requests and decodes only the new part plus
  2 s of context. It returns segments with absolute times.
- The hub appends the segments and pushes `meeting_live` to the apps.

**Tech Stack:** Go (hub, daemon), Python 3.12 + ffmpeg + faster-whisper (worker), React + TypeScript + vitest
(app), Java (Android shell).

**Spec:** `docs/superpowers/specs/2026-11-26-quorum-live-recording-design.md` (binding: microphone only; PC
loopback is Plan 16b) and the "Plan 16 — live meetings" section of
`docs/superpowers/specs/2026-11-26-quorum-pendings-live-copilot-design.md`.

## Global Constraints

- Audio never leaves the owner's machines except through the owner's own hub. Only text goes to ccapi, as today.
- Repo content is in English, with no personal data. Tests use made-up ids, titles and synthetic audio.
- Initial JS stays at 655 kB or less. The recorder (`liveRecorder.ts`) is loaded only when "Record meeting" is
  pressed, and the live view lives in the lazy meeting chunk.
- Capture: `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true,
  autoGainControl: true}})`, then `new MediaRecorder(stream, {mimeType: 'audio/webm;codecs=opus',
  audioBitsPerSecond: 48000})` and `start(15000)`. It is one recorder for the whole meeting, never restarted.
- Slices: `seq` is 0-based and below 100000. A slice is at most 2 MiB (`liveSliceMax = 2 << 20`). At most 64
  slices may be held beyond the next expected one (`liveMaxAhead = 64`). The whole recording is at most 400 MB
  (the existing `meetingMaxSize`), and the existing `meetingMinFree` disk rule applies.
- Context: 2000 ms (`ContextMs`). Hold-back: a segment ending within 1000 ms of the decoded end is not emitted
  yet, unless that would leave nothing new.
- The hub auto-stops a live meeting after 10 minutes without a slice (`liveIdleStop = 10 * time.Minute`). It
  checks on the existing 15 s job ticker.
- "Waiting": a live meeting is waiting when no connected machine has Transcribe, or when its oldest queued chunk
  job is more than 30 s old (`liveWaitAfter = 30 * time.Second`).
- The resident worker exits 5 minutes after its last chunk (`liveIdle = 5 * time.Minute`) and before any other
  meeting job starts on that machine.
- App retries: network errors, 5xx, 408 and 429 are retried for as long as the page is open. The wait starts at
  1000 ms, doubles, and is capped at 15000 ms. Any other 4xx stops the upload with the hub's message.
- Copy (exact): status `live` reads "Recording". Other copy:
  - "Transcription waiting for <machine>";
  - "Recording needs the hub over HTTPS.";
  - "Microphone access was denied. Allow it in the browser or app settings.";
  - "This browser cannot record Opus audio.";
  - "Nothing was recorded.";
  - "Recording on another device, or interrupted. Stop it to process what arrived.";
  - "Stop and process".
- Commands:
  - Go: `go test ./internal/...`.
  - App: `cd app && npx tsc --noEmit -p . && npx vitest run && npm run build`.
  - Worker: `<venv>/bin/python -m pytest -q worker/meetings/tests`, where `<venv>` is a test venv made with
    `uv venv --python 3.12 <venv> && uv pip install --python <venv>/bin/python -r worker/meetings/requirements-test.txt`
    (ffmpeg with libopus must be on PATH).

## Decisions

1. **One continuous stream, assembled in order on the hub.**
   - A `MediaRecorder` stream is one WebM file: only slice 0 carries the EBML header and Tracks, and slice
     boundaries can fall mid-cluster.
   - Each slice is kept as `<audioDir>/live/<meetingId>/<seq>.part` until every earlier one has arrived. Then it is
     appended to `<audioDir>/<meetingId>.webm`, the `meeting_audio` path that the Plan 14 job reads unchanged.
   - Restarting the recorder every 15 s was rejected: it drops audio at each restart and makes N files to
     concatenate.
2. **The worker cuts by WebM clusters.**
   - The worker keeps a local mirror of the file and fetches only the new bytes with `Range`.
   - It indexes the top-level clusters with a minimal EBML scanner that handles Chrome's unknown-size clusters.
     For each chunk it decodes `header + clusters from the last cluster at or before (fromMs − 2000)`, trimmed
     with an output `-ss`.
   - It decodes only up to the end of the last complete block. Times are absolute because cluster timecodes count
     from the recorder's start.
   - This keeps each chunk's decode small, about 17 s, however long the meeting is.
3. **The chunk jobs are coalesced.**
   - A meeting has at most one queued `transcribe_chunk` job, plus one running.
   - Its settings (`FromMs` = the transcribed-through time, `LiveBytes` = the assembled bytes) are computed at
     dispatch time by the existing `jobStep.settings` hook. A machine that was off catches up in one job.
4. **One resident worker per daemon.**
   - It is started as `worker.py --live`, takes one JSON job per stdin line, and tags its output lines with
     `jobId` and `attempt`. It loads Whisper once.
   - It exits on stdin EOF. The daemon closes stdin after `liveIdle`, before any non-chunk job, and on shutdown.
5. **The GPU turns on and off on demand, as today.**
   - Today the worker is a per-job process, so the GPU is used only while a job runs. That is kept.
   - Creating a live meeting queues a warm-up chunk job (`LiveBytes` 0), which starts the resident worker and loads
     Whisper before the first slice arrives. Stop queues the full transcription; its start on the daemon ends the
     resident worker.
6. **The live meeting comes first.**
   - While any meeting is `live`, the hub dispatches only `transcribe_chunk` jobs. Other queued jobs wait, so the
     live meeting never sits behind a 6-minute full transcription.
   - Chunk failures never change the meeting's status: the next slice retries from the same `FromMs`.
7. **Stop has a contract.**
   - `POST /api/meetings/{id}/live/stop {slices, force?}` answers 409 `{missing}` when slices below `slices` are
     absent. `force` keeps the contiguous prefix and discards the parts after a gap.
   - Then the hub cancels the chunk jobs and calls the existing `queueMeeting`. The full transcript replaces the
     live segments through `applyTranscript`.
8. **No resume.**
   - A tab that closes ends its `MediaRecorder`. The meeting stays `live`, and its page offers "Stop and process".
     The hub auto-stops it after 10 minutes without a slice.
   - A new recorder cannot continue the same WebM stream, so a resume would corrupt the file.
9. **Slices use PUT.** The route is `PUT /api/meetings/{id}/live/{seq}`, not POST: `POST /api/meetings/{id}/live/{seq}`
   would clash in the mux with `POST /api/meetings/uploads/{id}/complete`, and Go panics on that. PUT is also
   idempotent, as a retried slice is.
10. **Microphone permission in the shells.**
    - Android: Capacitor's `BridgeWebChromeClient.onPermissionRequest` already maps `AUDIO_CAPTURE` to a runtime
      request, so the manifest only needs `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. The Android WebView has no
      Wake Lock API, so `HubShell.keepScreenOn` is added.
    - `Quorum.exe`: go-webview2 leaves microphone requests in the `Default` state, so WebView2 shows its own prompt
      and remembers the answer in the persistent profile. No code is needed; E2E verifies it.

## Review Focus

1. **A retried slice whose first PUT was stored but whose answer was lost.** The duplicate is a no-op (200
   `duplicate: true`), and the file's bytes are unchanged. Test in Task 2.
2. **The laptop is off for 20 minutes during a meeting.** Eighty slices give one queued chunk job, not eighty.
   When the machine connects, that job's `LiveBytes` is the whole file and its `FromMs` the last transcribed time,
   and the page says "Transcription waiting for <machine>" until then. Test in Task 1.
3. **An upload of another meeting finishes while recording.** Its full transcription stays queued while the
   meeting is live and is dispatched after stop. On the machine, a resident worker and a full worker never run at
   once. Tests in Task 1 (hub) and Task 4 (daemon).
4. **Words of the 2 s context come back from Whisper.** A word whose midpoint is before `fromMs` is dropped, so a
   phrase is never shown twice, and a segment cut at the end of the audio is held back and re-transcribed next
   time. Test in Task 3.
5. **The phone locks, or the tab closes, mid-meeting.** No more slices arrive. After 10 minutes the hub stops the
   meeting with `force` and runs the full pipeline on what arrived. A stop retried after success answers 200 with
   the meeting. Test in Task 2.

---

### Task 1: Proto, store and the `transcribe_chunk` job step (hub)

**Files:**
- Modify:
  - `internal/proto/proto.go`;
  - `internal/hub/store/meetings.go` (status, schema, live functions);
  - `internal/hub/meetings_jobs.go` (the `live` step flag, dispatch order and hold);
  - `app/src/proto.gen.ts` and `mod/src/proto.gen.ts` (through `make proto`).
- Create: `internal/hub/meetings_live_jobs.go`, `internal/hub/meetings_live_jobs_test.go`.
- Test: `internal/hub/store/meetings_test.go`, `internal/hub/meetings_live_jobs_test.go` (reuse `newJobFx`,
  `connect` and `worker.start` from `meetings_jobs_test.go`).

**Interfaces:**
- Produces, in proto:
  - `MeetingStepTranscribeChunk = "transcribe_chunk"`.
  - `MeetingChunkSettings{Language, Model, Prompt string; FromMs, ContextMs, LiveBytes int64}`, with JSON
    `language, model, prompt, fromMs, contextMs, liveBytes`.
  - `MeetingChunkResult{Segments []MeetingWorkerSegment; ThroughMs int64 \`json:"through_ms"\`; Language string}`.
  - `MeetingLiveState{Slices int; Bytes int64; ThroughMs int64; LastSliceAt int64; Waiting bool}`, with JSON
    `slices, bytes, throughMs, lastSliceAt, waiting`.
  - `Meeting.Live *MeetingLiveState \`json:"live,omitempty"\``.
  - `MeetingLivePush{ID string \`json:"id"\`; ProjectID string \`json:"projectId"\`; Segments []MeetingSegment; Live MeetingLiveState}`.
  - The envelope doc comment gains "meeting_live (hub->app): Payload MeetingLivePush".
- Produces, in the store:
  - `MeetingStatuses` gains `"live"` first.
  - A table `meeting_live(meeting_id PK, next_seq INTEGER, bytes INTEGER, through_ms INTEGER, last_slice_at INTEGER)`.
  - `CreateLiveMeeting(u MeetingUpload, audioPath func(id string) string) (proto.Meeting, error)`. It uses
    ProjectID, Title, Language and StartedAt, inserts `meetings` (status `live`), `meeting_audio` (bytes 0, mime
    `audio/webm`) and `meeting_live`, and returns `ErrNoProject` for an unknown project.
  - `LiveState` struct `{MeetingID string; NextSeq int; Bytes, ThroughMs, LastSliceAt, CreatedAt int64}`.
  - `MeetingLiveState(id string) (LiveState, error)` (`ErrNotFound` when the meeting is not live).
  - `LiveMeetings() ([]LiveState, error)`.
  - `AdvanceLive(id string, nextSeq int, bytes, at int64) error`, which also sets `meeting_audio.bytes`.
  - `SetLiveThrough(id string, ms int64) error` (keeps the max).
  - `AppendMeetingSegments(id string, segs []proto.MeetingSegment) error` (idx continues after the last).
  - `EndLive(id string) error`, which deletes the `meeting_live` row.
- Produces, in the hub (`meetings_live_jobs.go`):
  - `jobStep.live bool`. A live step never calls `setMeetingState` or `failJob` on the meeting: start, requeue,
    progress, the worker's error and three lost attempts only change the job row, and log.
  - `func (s *Server) queueLiveChunk(meetingID string) error` creates a chunk job unless the meeting already has a
    queued one.
  - `chunkSettings` (the `jobStep.settings` hook) fills `FromMs = LiveState.ThroughMs`, `ContextMs = 2000`,
    `LiveBytes = LiveState.Bytes`, and the language, model and prompt as `transcribeSettings` does.
  - `parseChunk` and `applyChunk`:
    - A meeting that is no longer live discards the result.
    - Segments with `EndMs <= ThroughMs` are dropped.
    - The rest are appended with Speaker "".
    - `SetLiveThrough(max)` runs, then `publishLive`.
  - `func (s *Server) liveState(id string) (proto.MeetingLiveState, error)`, which includes `Waiting`.
  - `func (s *Server) publishLive(id, projectID string, segs []proto.MeetingSegment)`.
  - `dispatchMeetingJobs` puts chunk jobs first, oldest first. While `LiveMeetings()` is not empty, it skips the
    non-chunk jobs.
  - `handleMeeting` sets `m.Live` for a live meeting.

- [ ] **Step 1: Write the failing tests:**
  - Store `TestLiveMeetingLifecycle`:
    - Create gives status `live`, `HasAudio` true, and a `LiveState` of zeros.
    - `AdvanceLive(id, 2, 300, t)` is read back, and the `meeting_audio` bytes are 300.
    - `SetLiveThrough` 5000, then 3000, keeps 5000.
    - `AppendMeetingSegments` twice keeps the order and the idx.
    - `EndLive` makes `MeetingLiveState` return `ErrNotFound`.
    - `SetMeetingStatus(id, "live", …)` is valid.
  - Hub:
    - `TestChunkSettingsBuiltAtDispatch`: a live meeting with `Bytes` 900 and `ThroughMs` 15000 and a connected
      transcriber. The started job has step `transcribe_chunk`, an AudioURL, and settings `fromMs` 15000,
      `contextMs` 2000, `liveBytes` 900.
    - `TestChunkJobsCoalesce` (Review Focus 2): no transcriber, and `queueLiveChunk` is called 80 times. There is
      exactly one queued chunk job, and `liveState` has `Waiting` true. After `AdvanceLive(…, 80, 7200, …)`, a
      transcriber connects and gets one job with `liveBytes` 7200.
    - `TestChunkResultAppendsAndPushes`:
      - The result is `{segments: [{0,4000,"a"},{15500,18000,"b"}], through_ms: 18000}` posted with
        `ThroughMs` 5000 already stored.
      - Stored segments gain only "b".
      - A `meeting_live` envelope carries "b" with `live.throughMs` 18000.
    - `TestChunkFailureKeepsMeetingLive`: a worker error result, then three silent attempts through
      `checkMeetingJobs`. The meeting stays `live` with error "", and no `meeting_changed` says failed.
    - `TestLiveHoldsOtherJobs` (Review Focus 3): a queued `transcribe` job of another meeting and a live meeting
      with a queued chunk, with one transcriber. The chunk starts first. After the chunk result, the other job is
      still queued. After `EndLive` and a kick, it starts.
    - `TestLiveChunkResultAfterStopDiscarded`: `EndLive`, then the result is posted. No segments are added, and
      the answer is 200 or 409.
- [ ] **Step 2: Run** `go test ./internal/hub/... -run 'Live|Chunk'`. Expected: FAIL (undefined names).
- [ ] **Step 3: Implement** the proto types, run `make proto`, then the store, the step and the dispatch changes
  with the signatures above.
- [ ] **Step 4: Run** `go test ./internal/...`. Expected: PASS, with the existing meetings job tests unchanged.
- [ ] **Step 5: Commit** "meetings: live state, transcribe_chunk jobs and live-first dispatch".

### Task 2: Hub live routes (start, slices, stop, auto-stop)

**Files:**
- Create: `internal/hub/meetings_live.go`, `internal/hub/meetings_live_test.go` (reuse `newMeetFx` / `do` from
  `meetings_test.go`).
- Modify:
  - `internal/hub/meetings.go`: register the routes. `handleDeleteMeeting` also removes
    `<audioDir>/live/<id>/`.
  - `internal/hub/meetings_jobs.go`: `startMeetingJobs` calls `checkLiveMeetings` each tick.

**Interfaces:**
- Consumes: Task 1's store functions, `queueLiveChunk` and `publishLive`.
- Produces these routes (device auth):
  - `POST /api/meetings/live {projectId?, title?, language?, startedAt?}` returns 201 with the Meeting (status
    `live`).
    - It is validated like `handleMeetingUploadBegin`, with the same messages.
    - The disk must keep `meetingMinFree`.
    - It queues the warm-up chunk (`queueLiveChunk`) and publishes `meeting_changed`.
  - `PUT /api/meetings/{id}/live/{seq}`, where the body is the slice bytes. It answers 200
    `{nextSeq, bytes, duplicate?}`:
    - 400 "invalid slice number";
    - 404 "no such meeting";
    - 409 "the meeting is not recording";
    - 409 "the slice is too far ahead";
    - 413 "the slice is too large", or "the recording is larger than 400 MB";
    - 507 for a full disk (`diskFullErr`).
    - A seq below `NextSeq` is a duplicate. A part is written as a temp file plus rename.
    - Then, under a per-meeting lock, the file is truncated to the stored `Bytes`, every contiguous part is
      appended and fsynced, `AdvanceLive` runs and the parts are removed.
    - Then `queueLiveChunk`, and `publishLive` with no segments (it refreshes `waiting`).
  - `POST /api/meetings/{id}/live/stop {slices: int, force?: bool}` returns 200 with the Meeting:
    - 409 `{error: "some slices have not arrived", missing: [seq…]}` when not forced and a seq below `slices` is
      absent.
    - A meeting that is no longer live answers 200 with the meeting (a retried stop).
- `func (s *Server) stopLive(id string, slices int, force bool) (proto.Meeting, []int, error)`:
  - It appends what is contiguous and discards (and logs) the parts after a gap.
  - It removes the parts folder, cancels the chunk jobs (the existing `cancelMeetingJobs(id)`: a live meeting has
    no other jobs) and calls `EndLive`.
  - With 0 bytes it removes the file and sets `failed` "Nothing was recorded.". Otherwise it calls `queueMeeting`.
- `func (s *Server) checkLiveMeetings(now time.Time)` calls `stopLive(id, 0, true)` for every live meeting whose
  `LastSliceAt` (or `CreatedAt` when there is no slice) is more than `liveIdleStop` ago.

- [ ] **Step 1: Write the failing tests:**
  - `TestLiveStartCreatesMeetingAndWarmup`: 201, status `live`, one queued chunk job. A bad language gives 400,
    and an unknown project gives 400 "no such project".
  - `TestLiveSlicesAssembleOutOfOrder`: PUT seq 1 ("bb"), then 0 ("aa"), then 2 ("cc").
    - The answers' `nextSeq` are 0, 2 and 3.
    - The audio file is "aabbcc", and the parts folder is empty.
  - `TestLiveDuplicateSliceIsNoop` (Review Focus 1): PUT seq 0 twice with the same body. The second answers
    `duplicate: true`, and the file is unchanged.
  - `TestLiveSliceLimits`:
    - a body of `2<<20+1` gives 413;
    - seq "x", -1 and 100000 give 400;
    - seq `nextSeq+64` gives 409 "too far ahead";
    - an unknown id gives 404;
    - a stopped meeting gives 409 "the meeting is not recording".
  - `TestLiveStopQueuesFullPipeline`: 3 slices, then stop `{slices:3}`.
    - The status is `queued`, a `transcribe` job exists, and no chunk job is queued or running.
    - Posting a full transcript result (the existing helper) replaces the live segments.
  - `TestLiveStopMissingSlices`: seqs 0 and 2, then stop `{slices:3}` gives 409 `missing [1]`. Stop with `force`
    gives 200, and the file holds slice 0 only.
  - `TestLiveStopEmptyFails`: stop with no slices gives `failed` "Nothing was recorded.".
  - `TestLiveAutoStopAfterTenMinutes` (Review Focus 5):
    - At 9 min 59 s, `checkLiveMeetings` leaves the meeting live.
    - At 10 min 1 s it is queued.
    - A later `stop` answers 200 with the meeting.
  - `TestLiveDeleteRemovesParts`: a held part (seq 1 without 0), then DELETE. The parts folder and the audio file
    are gone.
- [ ] **Step 2: Run** `go test ./internal/hub/... -run Live`. Expected: FAIL.
- [ ] **Step 3: Implement** with the signatures above. Use the hub clock (`s.hub.now()`) so the tests can move
  time.
- [ ] **Step 4: Run** `go test ./internal/...`. Expected: PASS, and the server starts with no mux pattern panic.
- [ ] **Step 5: Commit** "meetings: live recording routes with ordered slice assembly and auto-stop".

### Task 3: Worker live mode

**Files:**
- Modify: `worker/meetings/worker.py` (live section, `Emitter` tags, `main` handles `--live`, docstring).
- Create: `worker/meetings/tests/test_live.py`. Its own Range-aware local HTTP server records each request's
  `Range` header. Audio is made with ffmpeg: `-f lavfi aevalsrc` tones and silence encoded with
  `-c:a libopus -b:a 48k -cluster_time_limit 2000 -f webm`.

**Interfaces:**
- Produces:
  - `Emitter(out=None, tags: dict | None = None)`: every line written carries the tags (`jobId`, `attempt`).
  - `WebmIndex` dataclass `{header_end: int, clusters: list[tuple[int, int]], end: int}`:
    - each cluster is (byte offset, timecode ms);
    - `end` is the offset after the last complete block.
  - `webm_index(data: bytes) -> WebmIndex`:
    - It walks the EBML header and the Segment children. It handles unknown sizes (all value bits 1): an
      unknown-size Cluster ends at the next Segment-level id.
    - It scales the timecodes by TimecodeScale (default 1000000 ns).
    - It raises `WorkerError("The live recording is not WebM audio.")` on anything else.
    - Ids: EBML `1A45DFA3`, Segment `18538067`, Info `1549A966`, TimecodeScale `2AD7B1`, Tracks `1654AE6B`,
      Cluster `1F43B675`, Timecode `E7`, SimpleBlock `A3`, BlockGroup `A0`, Cues `1C53BB6B`.
  - `fetch_range(url: str, dest: Path, start: int, end: int) -> None` appends bytes `[start, end)` from a
    `Range: bytes=start-(end-1)` request. A 200 rewrites `dest` from the body's first `end` bytes. Same-host
    redirects only, as `download` does.
  - `live_audio(mirror: Path, from_ms: int, context_ms: int, workdir: Path) -> tuple[Path | None, int, int]`
    returns the WAV, its absolute start ms and its absolute end ms. The WAV is None when nothing lies after
    `from_ms`.
  - `keep_new(segs: list[Segment], start_ms: int, from_ms: int, end_ms: int, hold_ms: int = 1000, final: bool = False) -> tuple[list[Segment], int]`
    shifts the segments to absolute times, then:
    - drops the words whose midpoint is before `from_ms` and rebuilds the text from the words left;
    - holds back a last segment ending within `hold_ms` of `end_ms`, unless nothing else is new;
    - returns the segments and `through_ms`.
  - `run_chunk(job: dict, emit: Emitter, engine) -> dict` returns
    `{"segments": [...], "through_ms": int, "language": str}`:
    - The mirror is `<workDir>/<meetingId>.webm`, and `meetingId` must match `^[A-Za-z0-9_-]{1,64}$`.
    - When the mirror is shorter than `liveBytes`, the missing bytes are fetched. A mirror longer than `liveBytes`
      is reset.
    - `liveBytes` 0 returns no segments and `through_ms` = `fromMs`.
  - `run_live(lines: Iterable[str], out, engine_factory=None) -> int`:
    - Each line is one job. The engine is created on the first job and again only when `settings.model`
      changes.
    - A job's failure becomes a tagged `error` line, and the loop goes on.
    - At EOF it calls `engine.close()` and returns 0.
    - `main(["--live"])` calls it with `sys.stdin`. `QUORUM_MEETINGS_FAKE=1` uses `FakeEngine`.

- [ ] **Step 1: Write the failing tests:**
  - `test_webm_index_ffmpeg_file`: a 10 s file gives at least 4 clusters with increasing timecodes, the first at
    0, and `header_end` equal to the first cluster's offset.
  - `test_webm_index_unknown_size_clusters`: the same file rebuilt by a test helper `as_live_stream` (header plus
    each cluster with the size `01 FF FF FF FF FF FF FF`) gives the same timecodes. A stream cut mid-block has an
    `end` before the cut.
  - `test_live_audio_absolute_times`:
    - The audio is a tone 0–2 s, silence, then a tone 8–10 s.
    - With `from_ms` 7000, `FakeEngine` plus `keep_new` give one segment starting at 8000 ± 150 ms.
    - The WAV starts at 5000 ± 2100 ms, the cluster start being within one cluster of 5000.
  - `test_keep_new_drops_context_words` (Review Focus 4): words at 4.0–4.5 and 5.2–5.6 with `from_ms` 5000. Only
    the second word stays, and the text is that word.
  - `test_keep_new_holds_back_cut_segment`: a last segment ending at `end_ms − 300` is held, and `through_ms` is
    its start. A lone segment is not held.
  - `test_run_live_reuses_engine_and_fetches_only_new_bytes`:
    - Two chunk jobs for one meeting over the Range server, the second with a bigger `liveBytes`.
    - The factory is called once.
    - The second request's Range starts at the first `liveBytes`.
    - Both result lines carry their `jobId`.
    - EOF closes the engine.
  - `test_run_live_error_is_tagged_and_loop_continues`: a bad `meetingId`, then a good job, give one tagged error
    and then one result.
  - `test_warmup_job_loads_engine_only`: `liveBytes` 0 gives a result with empty segments, the factory is called
    once, and no HTTP request is made.
- [ ] **Step 2: Run** `<venv>/bin/python -m pytest -q worker/meetings/tests/test_live.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The decode is `ffmpeg … -i chunk.webm -vn -ss <secs> -ac 1 -ar 16000 -c:a pcm_s16le`, run through the
    existing `_run` with `-protocol_whitelist file,pipe`.
  - The engine is the existing `FasterWhisperEngine.transcribe` with the prompt.
- [ ] **Step 4: Run** the full worker suite, then `go test ./internal/daemon/...` (the worker is embedded).
  Expected: PASS.
- [ ] **Step 5: Commit** "meetings: resident live worker that transcribes WebM clusters with context".

### Task 4: Daemon resident live worker

**Files:**
- Create: `internal/daemon/meetings_live.go`, `internal/daemon/meetings_live_test.go` (a fake `/bin/sh` live
  worker in the style of `fakeWorkerScript`: it reads lines, appends its PID to `$FAKE_DIR/pids`, and echoes a
  tagged progress and result per line).
- Modify:
  - `internal/daemon/meetings.go`: `start` routes chunk jobs, and it stops the live worker before any other job.
    The `meeting_job_cancel` handler also asks the live worker.
  - `internal/daemon/run.go`: `defer liveWorkers.shutdown()`.

**Interfaces:**
- Consumes: Task 3's protocol: `python -u worker.py --live`; one `workerJob` JSON per stdin line, with `WorkDir`
  = `<MeetingsDir>/tmp/live`; output `workerLine` plus `jobId` and `attempt`.
- Produces:
  - `var liveCommand = defaultLiveCommand`, with the same signature as `meetingCommand`, adding `--live`.
  - `var liveIdle = 5 * time.Minute`.
  - `var liveWorkers = &liveSupervisor{}` with these methods:
    - `run(hubURL string, reg *Registry, job proto.MeetingJobStart) error` returns at once. It starts the process
      when none runs, and creates `tmp/live` (0700). It returns `errMeetingBusy` while another chunk is in flight.
    - `stop()` closes stdin, waits up to 5 s, then kills the process group, and removes `tmp/live`.
    - `cancelJob(jobID string, attempt int) bool` kills the process when that job is in flight.
    - `shutdown()`.
  - Progress is forwarded as `meeting_progress`, with the heartbeat every `meetingHeartbeat`. Results go through
    `postMeetingResult`. A process that dies mid-job posts "the meeting worker stopped without a result" for that
    job.
  - `meetingSupervisor.start`:
    - A `transcribe_chunk` job is refused as busy while `s.cur != nil`; otherwise it goes to
      `liveWorkers.run`.
    - Any other step first calls `liveWorkers.stop()`, before `sweepMeetingTmp`.

- [ ] **Step 1: Write the failing tests:**
  - `TestLiveChunksShareOneWorker`: two chunk jobs in a row both post results, and `pids` holds one line.
  - `TestLiveWorkerExitsWhenIdle`: `liveIdle` 100 ms. After the result, the PID dies within 2 s, and `tmp/live` is
    removed.
  - `TestFullJobStopsTheLiveWorker` (Review Focus 3):
    - A chunk job, then a `transcribe` job.
    - The resident PID is dead before the full worker's PID file appears.
    - A chunk job while the full job runs is refused as busy.
  - `TestLiveChunkCancelKillsTheWorker`: cancel returns true, the PID dies, and no result is posted.
  - `TestLiveWorkerDeathPostsError`: the fake exits on its second line, and the second job gets an error result.
  - `TestLiveChunkProgressForwarded`: a `meeting_progress` with the job's id and attempt reaches the registry.
- [ ] **Step 2: Run** `go test ./internal/daemon/ -run Live`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `workerEnv`, `setProcessGroup`, `killProcessGroup`, `readLine`,
  `resolveHubURL` and `postMeetingResult`.
- [ ] **Step 4: Run** `go test ./internal/...`. Expected: PASS, with the existing `TestMeetingJob*` unchanged.
- [ ] **Step 5: Commit** "quorumd: resident live meeting worker fed chunk jobs on stdin".

### Task 5: App recorder, live API and the Android shell

**Files:**
- Create: `app/src/lib/liveRecorder.ts`, `app/src/lib/liveRecorder.test.ts`.
- Modify:
  - `app/src/lib/meetingsApi.ts`;
  - `app/src/lib/androidManifest.test.ts`;
  - `android-app/android/app/src/main/AndroidManifest.xml` (`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`);
  - `android-app/android/app/src/main/java/dev/quorum/app/HubShellPlugin.java` (`keepScreenOn`).

**Interfaces:**
- Consumes: Task 2's routes.
- Produces, in `meetingsApi.ts`:
  - `startLiveMeeting(b: {projectId?: string; title?: string; language?: string; startedAt?: number}): Promise<Meeting>`
  - `putLiveSlice(id: string, seq: number, blob: Blob, signal?: AbortSignal): Promise<{nextSeq: number; bytes: number; duplicate?: boolean}>`
    with Content-Type `application/octet-stream`.
  - `stopLiveMeeting(id: string, b: {slices: number; force?: boolean}): Promise<Meeting>`.
- Produces, in `liveRecorder.ts`:
  - `createSliceUploader(put: (seq: number, b: Blob) => Promise<unknown>, sleep?: (ms: number) => Promise<void>): SliceUploader`,
    where `SliceUploader` is
    `{add(seq: number, b: Blob): void; flush(): Promise<void>; pending(): number; error(): string; subscribe(fn: () => void): () => void}`.
    - It sends one slice at a time, in seq order, with the retry rule in Global Constraints.
    - A blob is dropped once it gets a 2xx.
  - `type RecorderState = 'recording' | 'stopping' | 'stopped' | 'failed'`.
  - `interface LiveRecording {meetingId: string; startedAt: number; state: RecorderState; error: string; pending: number; subscribe(fn: () => void): () => void; stop(): Promise<Meeting>}`.
  - `startLiveRecording(opts: {projectId?: string; title?: string; language?: string}): Promise<LiveRecording>`:
    - It checks, in this order: `isSecureContext`, `MediaRecorder.isTypeSupported`, then `getUserMedia`. Each
      failure throws the exact copy, and only then is `startLiveMeeting` called.
    - Each non-empty `dataavailable` goes to the uploader with the next seq.
    - It holds a module singleton and keeps the screen on.
  - `currentRecording(): LiveRecording | null`.
  - `stop()`:
    - It stops the recorder and waits for the last `dataavailable`.
    - It flushes the uploader and calls `stopLiveMeeting({slices})`. A 409 with `missing` is followed by
      `force: true`.
    - It stops the tracks, releases the screen, and clears the singleton.
    - A 409 "the meeting is not recording" on a slice ends the recording, with state `failed` and the hub's
      message.
  - `keepScreenOn(on: boolean): Promise<void>`:
    - Inside the Capacitor shell it calls `Capacitor.nativePromise('HubShell', 'keepScreenOn', {on})`.
    - Elsewhere it uses `navigator.wakeLock.request('screen')`, and requests it again on `visibilitychange` to
      visible.
    - It never throws.
  - A `beforeunload` listener is active while recording.
- Produces, on Android: `HubShell.keepScreenOn({on: boolean})` adds or clears
  `WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON` on the UI thread.

- [ ] **Step 1: Write the failing tests** (fake `MediaRecorder`, `getUserMedia`, fetch and `wakeLock`):
  - `uploader sends in order and retries`: the put fails with a 503, then a network error, then succeeds. The
    sleeps are 1000 and 2000. Seq 1 is sent only after seq 0 succeeds.
  - `uploader caps the backoff at 15 s and stops on 400`: the error is the hub's message.
  - `start checks before creating a meeting`:
    - No secure context gives "Recording needs the hub over HTTPS.".
    - An unsupported type gives "This browser cannot record Opus audio.".
    - A `NotAllowedError` gives "Microphone access was denied. Allow it in the browser or app settings.".
    - In all three, `startLiveMeeting` is not called.
  - `recorder options`: `mimeType 'audio/webm;codecs=opus'`, `audioBitsPerSecond 48000`, and `start(15000)`.
  - `stop flushes then stops with the slice count`: three slices, then stop. The calls are PUT 0, 1, 2, then stop
    `{slices: 3}`. A 409 `{missing:[1]}` is followed by `{slices: 3, force: true}`.
  - `keeps the screen on`:
    - The web path calls `wakeLock.request('screen')` and requests it again after `visibilitychange`.
    - The native path calls `nativePromise('HubShell','keepScreenOn',{on:true})`, then `{on:false}` on stop.
  - `androidManifest.test.ts`: the manifest contains `android.permission.RECORD_AUDIO` and
    `android.permission.MODIFY_AUDIO_SETTINGS`.
- [ ] **Step 2: Run** `cd app && npx vitest run src/lib/liveRecorder.test.ts src/lib/androidManifest.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd app && npx tsc --noEmit -p . && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** "app, android: live microphone recorder with ordered slice upload and screen wake".

### Task 6: App live meeting UI

**Files:**
- Create: `app/src/components/meetings/RecordMeeting.tsx`, `app/src/components/meetings/LiveView.tsx`,
  `app/src/components/meetings/LiveView.test.tsx`.
- Modify:
  - `app/src/lib/store.ts`: the `meeting_live` reducer, into `meetingText`;
  - `app/src/lib/store.test.ts`;
  - `app/src/components/meetings/util.ts`: `statusText('live')` is "Recording", and `statusTone` is `text-danger`
    for live;
  - `app/src/components/meetings/MeetingPage.tsx`: it renders `LiveView` for status `live`, and fetches no audio
    URL while live;
  - `ProjectMeetings.tsx` and `MeetingsSettings.tsx` (inbox): `RecordMeeting` goes next to `UploadMeeting`;
  - `app/src/lib/budget.test.ts`.

**Interfaces:**
- Consumes: Task 5's `startLiveRecording`, `currentRecording` and `stopLiveMeeting`, and Task 1's
  `MeetingLivePush` and `MeetingLiveState`.
- Produces:
  - `AppState.meetingText: Record<string, {segments: MeetingSegment[]; live: MeetingLiveState}>`. The
    `meeting_live` reducer appends the segments, dedupes them by `startMs` plus `text`, keeps them sorted, and
    replaces `live`.
  - `RecordMeeting({projectId, onStarted}: {projectId?: string; onStarted?: (m: Meeting) => void})` is a "Record
    meeting" button. It does `await import('../../lib/liveRecorder')` on click and shows errors inline.
  - `LiveView({state, m, onStopped})`:
    - It shows an elapsed timer from `startedAt` and the segments (the detail's segments merged with
      `meetingText`), auto-scrolled while the view is at the bottom.
    - It shows "Transcription waiting for <machine>" when `live.waiting`. The machine is the transcribe machines
      of `state.machines`, offline ones included, joined with " or ".
    - On the recording device (`currentRecording()?.meetingId === m.id`) it shows a Stop button, then "Finishing
      the upload…" with the pending count.
    - On any other device it shows the copy "Recording on another device, or interrupted. Stop it to process what
      arrived." with "Stop and process" (`stopLiveMeeting(id, {slices: 0, force: true})`).

- [ ] **Step 1: Write the failing tests:**
  - `store.test.ts`: two `meeting_live` envelopes with an overlapping segment keep it once, in order, and `live`
    is the last one.
  - `LiveView.test.tsx`:
    - The segments render.
    - `waiting: true` with an offline transcriber "laptop" shows "Transcription waiting for laptop".
    - With no current recording, "Stop and process" calls `stopLiveMeeting` with `force`.
    - With a fake current recording, Stop calls its `stop()`.
    - A new segment scrolls to the bottom only when the view was at the bottom.
  - `MeetingPage.test.tsx`: a `live` meeting renders `LiveView` and makes no `audio-url` request.
  - `budget.test.ts`: the initial chunks do not contain `'Transcription waiting for'`, `'/live/stop'` or
    `'audio/webm;codecs=opus'`.
- [ ] **Step 2: Run** `cd app && npx vitest run src/lib/store.test.ts src/components/meetings`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd app && npx tsc --noEmit -p . && npx vitest run && npm run build`. Expected: PASS, and the
  initial JS is 655 kB or less, with the budget test run after the build.
- [ ] **Step 5: Commit** "app: record meeting button and live transcript view".

### Task 7: End-to-end (controller)

- [ ] Deploy:
  - the hub on oracle83 (back up the DB first, as `hub-backup-pre-plan16.db`);
  - quorumd on the laptop, then `quorumd meetings setup` to reinstall `worker.py`;
  - `make desktop`, copied to Windows;
  - `make apk`, sent to the owner.
- [ ] **Web** (`https://quorum.aido.lat`): in a scratch project, press Record meeting and read aloud for 3
  minutes.
  - The first text appears within 20 s of speaking, checked by a stopwatch on 3 phrases.
  - `nvidia-smi` shows the resident worker during the recording and none 5 minutes after stop.
- [ ] **Machine off:** stop quorumd for 2 minutes mid-meeting.
  - The page says "Transcription waiting for <laptop>".
  - After a restart, the backlog arrives in one catch-up and in order.
- [ ] **Stop:** the meeting goes queued, then transcribing, then ready, and the live segments are replaced by
  the full transcript with speakers. Check that the audio player plays, and note whether seeking works on the
  WebM recording (a follow-up if not).
- [ ] **`Quorum.exe`:** the WebView2 microphone prompt appears once, and the answer is remembered after a
  restart. Recording works.
- [ ] **Android APK:** the microphone permission is asked, the screen stays on for 5 minutes, and the text
  arrives.
- [ ] **Interrupted:** close the tab mid-recording. The meeting stays Recording, shows "Stop and process" from
  another device, and is auto-stopped after 10 minutes.
- [ ] Delete the scratch meetings.
