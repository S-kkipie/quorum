# Plan 15b — Transcription Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe meetings with Whisper large-v3 and a soft VAD, feed a per-project glossary to Whisper, and
correct misheard terms with Claude through ccapi before the summary. The original text always stays viewable.

**Architecture:**
- **Worker** (Python, faster-whisper): new defaults, plus an `initial_prompt` from the job settings.
- **Hub:** stores the project glossary, builds the prompt, and runs a correction step inside `runHubSummary`
  (same `chat` function and model as the summary) before `summarizeSegments`. Corrected segments keep their
  original text.
- **App:** a glossary editor, a "Show original" toggle on the meeting page, and a Settings switch.

**Tech Stack:** Go hub and daemon, Python worker (pytest), React app (vitest), and `prompts.json` shared by the
worker and the hub.

**Spec:** `docs/superpowers/specs/2026-11-26-quorum-transcription-accuracy-design.md`

## Global Constraints

- **Whisper model:** `large-v3` (float16, CUDA), `beam_size=5`, `condition_on_previous_text=False`.
- **VAD:** `vad_filter=True` with `threshold=0.25`, `min_silence_duration_ms=1500`, `speech_pad_ms=500`.
- **Glossary:** a project field of ≤ 2000 characters, with terms separated by commas or new lines.
- **Whisper prompt:** `"Vocabulary: " + terms joined by ", " + "."`. The hub caps it at 600 characters and stops
  at a whole term.
- **Correction:**
  - Chunks of ≤ 120 segments.
  - The answer is a JSON array `[{"i": <index>, "text": "<corrected>"}]` holding only the changed segments.
  - A change is rejected when its word-level edit distance is more than 40% of the original segment's word count.
  - A failure never fails the meeting: it logs, keeps the raw text and goes on to the summary.
- **When correction runs:** at most once per meeting (`corrected_at`); reprocessing a summary does not correct
  again. It applies only when the summary runs on the hub (provider `ccapi` or `openai-compatible`) and the
  setting `correct` is true. The default is true.
- **Progress stage name:** `correcting`.
- Repo content in English, with no personal or client data. Tests use made-up terms ("zorvanite", "Quillon
  Labs").
- Initial JS stays at 655 kB or less, with new UI in lazy chunks. Use semantic tokens, 44 px targets and
  ScrollArea.

## Review Focus

1. **A rewrite disguised as a correction**, for example the model paraphrasing a whole segment. It must be rejected
   by the 40% guard, and the original kept. Test in Task 3.
2. **The model returns garbage or an index out of range.** Ignore that item and keep the rest. Test in Task 3.
3. **A glossary with a long single term or more than 600 characters.** The prompt is cut at a whole term and is
   never empty when the glossary isn't. Test in Task 2.
4. **Reprocess after correction.** It does not correct twice, and the originals stay the first raw text. Test in
   Task 3.
5. **Correction fails** (ccapi down). The summary still runs on the raw transcript, and the meeting ends `ready`.
   Test in Task 3.

---

### Task 1: Worker defaults and the Whisper prompt

**Files:**
- Modify:
  - `worker/meetings/worker.py`: `WHISPER_MODEL`, `FasterWhisperEngine.transcribe`, and the `run_transcribe`
    settings read.
  - `internal/daemon/meetings_setup.go`: `setupWhisperModel`.
  - `internal/hub/meetings_jobs.go`: `defaultWhisperModel`.
  - `internal/proto/proto.go`: `MeetingTranscribeSettings.Prompt string \`json:"prompt,omitempty"\``.
  - The generated proto TS (`make proto`).
- Test: `worker/meetings/test_worker.py` (or the existing pytest file) and `internal/hub/meetings_jobs_test.go`.

**Interfaces:**
- Produces: `FasterWhisperEngine.transcribe(audio, language, on_progress, prompt: str | None = None)`. It calls
  `model.transcribe(audio, language=language, beam_size=5, vad_filter=True, vad_parameters=dict(threshold=0.25, min_silence_duration_ms=1500, speech_pad_ms=500), condition_on_previous_text=False, initial_prompt=prompt or None)`.
- `run_transcribe` reads `settings.get("prompt")` and passes it on.
- The `FakeEngine.transcribe` signature gains the same optional `prompt` and records it.

- [ ] **Step 1: Write the failing tests:**
  - pytest `test_transcribe_passes_prompt_to_engine`: the settings `{"prompt":"Vocabulary: zorvanite."}` reach the
    fake engine.
  - pytest `test_engine_uses_soft_vad_and_no_previous_text`: a stub `WhisperModel` records its kwargs, and the test
    asserts the exact values above.
  - Go `TestTranscribeJobUsesLargeV3`: the job settings carry `"model":"large-v3"`.
- [ ] **Step 2: Run** `cd worker/meetings && python -m pytest -q` and `go test ./internal/hub -run TranscribeJob`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** Set `WHISPER_MODEL = "large-v3"`, `setupWhisperModel = "large-v3"` and
  `defaultWhisperModel = "large-v3"`.
- [ ] **Step 4: Run** the full pytest, `go test ./...` and `make proto`. Expected: PASS.
- [ ] **Step 5: Commit** "meetings: Whisper large-v3, soft VAD, vocabulary prompt".

### Task 2: Project glossary

**Files:**
- Modify:
  - `internal/hub/store/projects.go`: a `glossary` column, added with a migration in the existing style.
  - `internal/proto/proto.go`: `Project.Glossary string \`json:"glossary"\``.
  - `internal/hub/projectapi.go`: `handlePatchProject` accepts `glossary`.
  - `internal/hub/meetings_jobs.go`: put `Prompt` in the transcribe settings.
  - `internal/hub/meetings_summary.go`: `glossary()` adds the project's terms.
- Create: `internal/hub/glossary.go` and `internal/hub/glossary_test.go`.

**Interfaces:**
- Produces:
  - `glossaryTerms(g string) []string`: splits on commas and new lines, trims, drops empty entries and
    case-insensitive duplicates, keeps the order.
  - `whisperPrompt(terms []string) string`: returns `""` when there are no terms. Otherwise it returns
    `"Vocabulary: a, b."` capped at 600 characters, cut at a whole term. When the first term alone is longer than
    the cap, it truncates that term to fit.
- PATCH validation, 400: "glossary is longer than 2000 characters".

- [ ] **Step 1: Write the failing tests:**
  - `TestGlossaryTerms`: the input `"zorvanite, Quillon Labs\n\nzorvanite ,guía de remisión"` gives
    `["zorvanite","Quillon Labs","guía de remisión"]`.
  - `TestWhisperPromptCap`: 200 short terms give a prompt of ≤ 600 characters that ends with "."; a single
    700-character term gives a non-empty prompt of ≤ 600; no terms give `""` (Review Focus 3).
  - `TestPatchProjectGlossary`: a stored glossary round-trips through GET, and 2001 characters answers 400 with the
    message.
  - `TestTranscribeJobCarriesProjectPrompt`: a meeting in a project with a glossary has `settings.prompt` starting
    with "Vocabulary: ". An unassigned meeting has no prompt.
  - `TestSummaryGlossaryIncludesProjectTerms`.
- [ ] **Step 2: Run** `go test ./internal/hub/... -run 'Glossary|WhisperPrompt|TranscribeJobCarries'`. Expected:
  FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./...` and `make proto`. Expected: PASS.
- [ ] **Step 5: Commit** "hub: per-project glossary for transcription and summaries".

### Task 3: Correction pass

**Files:**
- Create: `internal/hub/meetings_correct.go` and `internal/hub/meetings_correct_test.go`.
- Modify:
  - `worker/meetings/prompts.json`: add `correctSystem` and `correctUser` (with `{project}`, `{glossary}`,
    `{speakers}` and `{segments}` placeholders), plus the Go struct that loads `prompts.json`.
  - `internal/hub/store/meetings.go`:
    - a `meeting_segments.orig_text TEXT NOT NULL DEFAULT ''` column;
    - a `meetings.corrected_at INTEGER NOT NULL DEFAULT 0` column;
    - `ApplySegmentCorrections(meetingID string, fixes map[int]string, now int64) error`, which sets `orig_text`
      only when it is empty, so the original stays the first raw text;
    - `SetMeetingCorrected(meetingID string, now int64) error`;
    - `Meeting.CorrectedAt`.
  - `internal/proto/proto.go`: `MeetingSegment.OrigText string \`json:"origText,omitempty"\`` and
    `Meeting.CorrectedAt int64 \`json:"correctedAt"\``.
  - `internal/hub/meetings_summary.go` (`runHubSummary`): before `summarizeSegments`, if
    `m.CorrectedAt == 0 && settings.Correct`, call `correctTranscript`, report the progress stage `correcting`,
    apply the fixes, mark the meeting corrected, and re-read the segments.
  - The meeting settings: `Correct bool \`json:"correct"\``, default true. Reading old stored settings where the
    field is absent must give true.

**Interfaces:**
- Produces: `correctTranscript(ctx context.Context, chat chatFunc, segs []proto.MeetingSegment, project string, glossary []string, names map[string]string, progress func(pct int)) (map[int]string, error)`.
  - It sends chunks of ≤ 120 segments, rendered as `i<TAB>speaker<TAB>text`.
  - It parses the JSON array, tolerating a code fence.
  - It drops items whose `i` is out of the chunk, whose text is empty or unchanged, or whose word edit distance is
    more than 40% of the original's word count.
  - It returns the accepted fixes keyed by the global index.
  - A chunk that errors or returns unparseable output is skipped, and the others continue. The function returns an
    error only when every chunk failed.
- `wordEditDistance(a, b string) int`: Levenshtein over lowercased word tokens.

- [ ] **Step 1: Write the failing tests:**
  - `TestCorrectAcceptsSurgicalFix`: "la guía de revisión" → "la guía de remisión" is accepted.
  - `TestCorrectRejectsRewrite`: a paraphrase that changes 3 of 5 words is rejected (Review Focus 1).
  - `TestCorrectIgnoresBadItems`: an out-of-range index, an empty text and a non-JSON chunk are skipped, and the
    other chunk's fix is kept (Review Focus 2).
  - `TestCorrectChunks`: 250 segments make 3 calls with the right global indices.
  - `TestApplyCorrectionsKeepsFirstOriginal`: applying twice keeps the first raw text in `orig_text` (Review
    Focus 4).
  - `TestHubSummaryCorrectsOnceThenSummarises`: with a fake chat, `runHubSummary` applies the fixes, sets
    `corrected_at`, and the summary prompt sees the corrected text. A reprocess makes no second correction call.
  - `TestHubSummaryCorrectionFailureStillSummarises`: every correction call errors, and the meeting still ends
    `ready` with a summary (Review Focus 5).
  - `TestCorrectionOffSetting`: with `correct:false` there is no correction call.
- [ ] **Step 2: Run** `go test ./internal/hub/... -run 'Correct|HubSummary'`. Expected: FAIL.
- [ ] **Step 3: Implement.** The prompt rules come from the spec:
  - Fix misheard words, names and domain terms only.
  - Never add, remove, reorder or rephrase content.
  - Keep the speaker's wording.
  - Return `[]` when unsure.
- [ ] **Step 4: Run** `go test -race ./...` and the worker pytest (`prompts.json` is shared). Expected: PASS.
- [ ] **Step 5: Commit** "hub: correct the transcript with the summary model before summarising".

### Task 4: App — glossary editor, "Show original", the Settings switch

**Files:**
- Modify:
  - The project page: add a "Glossary" entry in the project's ••• menu, opening a dialog with a textarea, a
    2000-character limit with a counter, and Save, which calls PATCH `{glossary}`.
  - `app/src/components/meetings/MeetingPage.tsx`: when any segment has `origText`, show a "Show original" toggle
    above the transcript; when it is on, render `origText || text`. Segments that were changed get a subtle marker
    with the title "Corrected by Claude".
  - `app/src/components/meetings/MeetingsSettings.tsx`: a "Correct transcripts with Claude" switch, bound to
    `correct`, with the hint "Only when summaries run through ccapi or an OpenAI-compatible API".
  - The meeting progress label map: `correcting` → "Correcting transcript".
  - `app/src/lib/meetingsApi.ts`: `MeetingSettings.correct: boolean`.
- Tests next to each changed component.

- [ ] **Step 1: Write the failing tests:**
  - The glossary dialog saves through PATCH, shows the counter, and blocks Save over 2000.
  - "Show original" appears only when there are originals and swaps the text.
  - The Settings switch sends `correct:false`.
  - The stage label reads "Correcting transcript".
- [ ] **Step 2: Run** `cd app && npx vitest run src/components/meetings src/screens`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and `npm run build`, and check that initial JS is ≤ 655 kB. Expected: PASS.
- [ ] **Step 5: Commit** "app: glossary, original transcript toggle, correction setting".

### Task 5: End-to-end (controller)

- [ ] Deploy the hub and daemons, then run `quorumd meetings setup` on the laptop so `large-v3` is downloaded.
- [ ] Set a glossary on a scratch project with the owner's terms, such as "guía de remisión, trazabilidad,
  cotización, código de pedido".
- [ ] Upload the owner's recording and check:
  - the stage `correcting` runs;
  - "Show original" shows the raw text;
  - corrected terms appear, for example "guía de remisión";
  - the summary is ready.
- [ ] Delete the scratch project and meeting.
