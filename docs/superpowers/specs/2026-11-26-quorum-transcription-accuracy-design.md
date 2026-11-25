# Transcription accuracy — Design

Date: 2026-11-26. Status: the owner approved the four changes below after a bake-off on one of their own
recordings.

## Intent

Meeting transcripts must be as accurate as the owner's hardware allows. Summaries, pending items and the future
copilot all read the transcript, so every lost or misheard phrase propagates.

## What the bake-off showed

The test used 10 minutes of a real client meeting in Peruvian Spanish, one room recording, on an RTX 5080 with
16 GB of VRAM.

| Model | Time | Result |
|---|---|---|
| Whisper large-v3 | 18 s | Most faithful overall |
| Whisper large-v3-turbo (current default) | 7 s | Close behind, with more small errors |
| NVIDIA Canary 1B v2 | — | Clearly worse on this Spanish |
| Voxtral Mini 3B | — | Looped, repeating one sentence hundreds of times |
| Larger models (Voxtral Small, Nemotron 3.5 Transcribe) | — | Do not fit 16 GB of VRAM, or the disk |

Further findings:

- **Aggressive VAD.** The current `vad_filter=True` with default settings dropped 15–20% of the words: 537 → 633
  words with turbo, and 558 → 647 with large-v3, once the VAD was softened.
- **Domain terms.** All models misspell domain terms: "guía de remisión" came out as "guía de revisión", and
  "trazabilidad" as "pasabilidad".
  - An `initial_prompt` with the project's vocabulary fixed some of them.
  - An LLM correction pass with the project's context is the remaining lever.

## Goals

1. Default model: **Whisper large-v3** (float16 on CUDA). It replaces large-v3-turbo in the hub's job settings,
   the worker default and `quorumd meetings setup`.
2. **Soft VAD.** Use `vad_filter=True` with `threshold=0.25`, `min_silence_duration_ms=1500` and
   `speech_pad_ms=500`, plus `condition_on_previous_text=False`, which prevents repetition loops. Keep
   `beam_size=5`.
3. **Per-project glossary.**
   - A free-text `glossary` field on the project: terms separated by commas or new lines, at most 2000
     characters. It is edited from the project page.
   - The transcribe job receives it as an `initial_prompt` of the form "Vocabulary: term1, term2, …."
   - The hub caps the prompt at 600 characters, since Whisper only reads about 224 tokens of prompt.
   - The same terms join the summary glossary.
4. **Correction pass through ccapi** after transcription, before the summary.
   - The hub sends the transcript in chunks of up to 120 segments, each with the project name, the glossary and
     the speaker names.
   - Claude returns only the segments it changed, as `[{i, text}]`.
   - The rules:
     - Fix misheard words, names and domain terms only.
     - Never add, remove, reorder or rephrase content.
     - Keep the speaker's wording.
     - Return nothing when unsure.
   - The hub rejects a change whose word-level edit distance is more than 40% of the segment's words. That
     guards against rewrites.
   - The hub stores the original text of every changed segment, and the meeting page has a "Show original"
     toggle.
   - A failed correction never blocks the meeting. It logs, keeps the raw transcript and goes on to the summary.
   - The model is the one set for summaries in Settings → Meetings. A new setting, "Correct transcripts with
     Claude", is on by default and only applies when the provider is ccapi.
   - The progress stage is `correcting`.

## Non-goals

- New ASR models beyond Whisper, and cloud ASR.
- Live transcription, which is Plan 16.
- Automatic glossary building.

## Anti-goals

- **Rewriting what people said.** Corrections must stay surgical, and the original must always be viewable.
- **Losing a transcript to a correction failure.**

## Constraints

- Repo content in English, with no personal or client data. Tests use made-up terms.
- Initial JS stays at 655 kB or less. The UI changes go in lazy chunks.
- Worker changes keep the existing pytest suite green and add tests with the fake engine.
- The `large-v3` model downloads during `quorumd meetings setup` (about 3 GB). There is enough disk.

## Left to the builder

- The exact correction prompt wording, within the rules above.
- Where the glossary editor lives on the project page.
