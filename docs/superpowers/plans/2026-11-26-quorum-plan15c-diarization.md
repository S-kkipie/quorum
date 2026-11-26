# Plan 15c — Speaker Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-threshold clustering with windowed TitaNet embeddings plus spectral clustering with
automatic K, and split Whisper segments at speaker changes using word timestamps.

**Architecture:** Everything lives in `worker/meetings/worker.py` (numpy and sherpa-onnx, no new dependencies).
`SherpaDiarizer` keeps sherpa's segmentation turns, then relabels them with `recluster_turns`. Transcription asks
faster-whisper for word timestamps, and `split_by_speaker` turns words and turns into labelled segments.

**Tech Stack:** Python 3.12, numpy, sherpa-onnx (installed models), faster-whisper, pytest.

**Spec:** `docs/superpowers/specs/2026-11-26-quorum-diarization-design.md`

## Global Constraints

- Windows: 1.5 s with a hop of 0.75 s, inside turns of at least 0.5 s. A turn shorter than 1.5 s gives one window
  covering the whole turn.
- Automatic K uses NME-SC on the cosine affinity `A = X·Xᵀ` of L2-normalised embeddings:
  - Binarise the top-p neighbours per row and symmetrise with `(B+Bᵀ)/2`.
  - The Laplacian is `L = D − B`. K is the position of the largest gap among the first 13 eigenvalues, so
    K ≤ 12.
  - p comes from the grid `range(4, 40, 2)` plus `range(40, int(N*0.08), 10)`, and minimises
    `p / (maxgap / λ_max)`.
  - A given `num_speakers > 0` overrides K.
  - When there are fewer than 2 windows, there is one speaker. When N < 20, K is decided with the p grid clipped to
    N−1.
- Labels come from k-means on the row-normalised first K eigenvectors: 20 restarts with seed 0, at most 100
  iterations, highest cohesion wins.
- A turn gets the majority label of its windows. A turn without windows (under 0.5 s) takes the label of the
  nearest labelled turn in time.
- A cluster with less than 10 s of total turn time merges into the cluster whose centroid has the highest cosine
  similarity. This repeats until none is left, or one cluster remains.
- Speaker ids are renumbered by first appearance, starting at 0.
- Words: faster-whisper `word_timestamps=True`.
  - A word's speaker is the turn covering its midpoint, else the nearest turn within 2.0 s, else none.
  - A segment splits wherever consecutive words have different speakers. A word without a speaker joins the
    previous run.
  - A segment with no words falls back to `label_speakers`.
- No new dependencies or models. Repo content in English.

## Review Focus

1. **Silence, one speaker, or a single turn.** It must not crash: one speaker, no division by zero, no NaN. Test
   in Task 1.
2. **`num_speakers` larger than the number of windows.** K is clipped to the window count. Test in Task 1.
3. **Words with zero or inverted timestamps** (faster-whisper can emit `start == end`). A midpoint must still be
   assigned. Test in Task 2.
4. **The two-channel "me|others" path.** The "Me" track is never relabelled, and Others still gets "Speaker N".
   Test in Task 2.
5. **A long meeting.** 4,000 windows means a 4000×4000 eigen-decomposition per grid point. Bound it: when
   N > 3000, subsample the windows evenly to 3000 for estimating K and clustering, then label every window by its
   nearest centroid. Test in Task 1 with a synthetic N = 3500 (fast) that checks the subsampling path.

---

### Task 1: Re-clustering with automatic K

**Files:**
- Modify: `worker/meetings/worker.py` (new functions next to `SherpaDiarizer`; `SherpaDiarizer.diarize` calls
  them).
- Test: `worker/meetings/tests/test_worker.py`.

**Interfaces:**
- Produces:
  - `window_spans(turns: list[Turn], win=1.5, hop=0.75, min_turn=0.5) -> list[tuple[int, float, float]]`: each
    tuple is (turn index, start, end).
  - `estimate_speakers(X: np.ndarray, max_k: int = 12) -> int`
  - `cluster_embeddings(X: np.ndarray, k: int) -> np.ndarray`: returns the labels.
  - `recluster_turns(turns: list[Turn], spans, X: np.ndarray, num_speakers: int = 0, min_talk: float = 10.0) -> list[Turn]`
- `SherpaDiarizer.diarize` runs sherpa as today to get the turns, embeds `window_spans` with
  `sherpa_onnx.SpeakerEmbeddingExtractor` (the same TitaNet model) and returns `recluster_turns(...)`. Progress:
  sherpa takes 0–0.7, embedding 0.7–0.95, clustering 0.95–1.

- [ ] **Step 1: Write the failing tests**, with synthetic L2-normalised embeddings: 3 well-separated directions
  plus noise σ = 0.05, seed 1.
  - `test_estimate_speakers_finds_three`: the estimate is 3.
  - `test_recluster_merges_tiny_cluster`: a cluster with 6 s of total talk merges, and the remaining speakers are
    numbered from 0 by first appearance.
  - `test_recluster_given_count`: `num_speakers=2` gives 2.
  - `test_recluster_edge_cases`:
    - no turns gives `[]`;
    - one turn gives speaker 0;
    - a single window gives one speaker;
    - `num_speakers=8` with 3 windows is clipped (Review Focus 1–2).
  - `test_short_turn_takes_nearest_label`.
  - `test_large_n_subsamples`: N = 3500 synthetic windows finish under 30 s and give 3 (Review Focus 5).
- [ ] **Step 2: Run** `<venv>/bin/python -m pytest -q worker/meetings/tests -k "recluster or estimate or large_n or short_turn"`.
  Expected: FAIL.
- [ ] **Step 3: Implement** with the algorithm in Global Constraints, numpy only.
- [ ] **Step 4: Run** the full pytest. Expected: PASS.
- [ ] **Step 5: Commit** "meetings: windowed embeddings and spectral clustering with automatic speaker count".

### Task 2: Word-level speaker split

**Files:**
- Modify: `worker/meetings/worker.py`:
  - `Segment` gains `words: list[tuple[float, float, str]] = field(default_factory=list)`.
  - `FasterWhisperEngine.transcribe` gets `word_timestamps=True` and fills `words`.
  - `split_by_speaker` is new.
  - `run_transcribe` uses `split_by_speaker` for diarized tracks.
  - `FakeEngine` can emit words.
- Test: `worker/meetings/tests/test_worker.py`.

**Interfaces:**
- Produces: `split_by_speaker(segs: list[Segment], turns: list[Turn], max_gap: float = 2.0) -> list[Segment]`.
  - It returns new segments with `speaker` set as "Speaker N", renamed by first appearance as `label_speakers`
    does.
  - A segment's text is its words joined with single spaces and stripped.
  - Its start and end are its first word's start and its last word's end.
  - A segment without words keeps its own times and text, and is labelled through `label_speakers` logic.

- [ ] **Step 1: Write the failing tests:**
  - `test_split_at_speaker_change`: one segment "hola cómo estás bien gracias" whose words cover turns A (0–2 s)
    and B (2–4 s) becomes two segments with the right texts, times and speakers.
  - `test_zero_length_word`: a word with `start == end` inside a turn is assigned (Review Focus 3).
  - `test_word_without_speaker_joins_previous`.
  - `test_segment_without_words_falls_back`.
  - `test_me_others_unchanged`: through `run_transcribe` with fake engines and a two-channel source, the Me
    segments keep the "Me" label and Others get "Speaker N" (Review Focus 4).
  - The existing transcribe pipeline tests stay green.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full pytest, then `go test ./internal/daemon/... ./internal/hub/...`, since the worker
  is embedded in quorumd. Expected: PASS.
- [ ] **Step 5: Commit** "meetings: split segments at speaker changes using word timestamps".

### Task 3: End-to-end (controller)

- [ ] Deploy quorumd on the laptop, then run `quorumd meetings setup`, which reinstalls `worker.py`.
- [ ] Upload the owner's 57-minute recording to a scratch project.
- [ ] Expect a speaker count close to the real one (about 4), and segments that don't mix speakers.
- [ ] Check that the runtime grows by at most 2 minutes.
- [ ] Delete the scratch data.
