# Live meeting recording: microphone and PC — Design

Date: 2026-11-26. Status: the owner approved it in conversation. It refines "Plan 16 — live meetings" in
`2026-11-26-quorum-pendings-live-copilot-design.md`, which still holds for everything not restated here.

## Intent

The owner records meetings from Quorum itself and reads the transcript while the meeting runs. There are two
kinds of meeting:

1. **In person.** One microphone, on the phone or on the PC.
2. **On the PC.** A Meet, Teams or Zoom call, often with 4–5 people. The owner usually uses speakers, sometimes
   headphones.

## Decisions (the owner's)

- **Two modes:** "Record meeting (microphone)" and "Record meeting (PC)".
- **PC mode uses native capture in `Quorum.exe`.**
  - It records two tracks: the microphone ("Me") and the system audio through WASAPI loopback ("Others").
  - It is chosen over the browser's screen-share audio, because it takes one click and keeps the owner's voice
    apart from everyone else's.
- **Speakers are the normal case,** so the "Me" track carries an echo of the others. On the laptop, after the
  meeting, the cleanup is:
  1. Echo cancellation, using the "Others" track as the reference: an adaptive filter that estimates the
     delay and gain of the echo and subtracts it.
  2. Dedupe: a "Me" segment whose words largely repeat an "Others" segment at the same time is dropped from
     "Me".
  - Headphones give the cleanest result, but they are not required.
- **Several remote people** are separated inside the "Others" track by the existing diarization (Plan 15c). The
  owner is always "Me". A known speaker count is used when the owner gives one.
- **Names are not detected.** Speakers are "Speaker 1, 2, …", renameable as today. There are no bots in calls.
- **Two plans:**
  - **Plan 16:** live recording with the microphone in every app (web, `Quorum.exe`, Android), with live
    transcription. Then the full Plan 14 pipeline runs on stop.
  - **Plan 16b:** PC capture in `Quorum.exe` (mic plus loopback as two channels), echo cleanup and dedupe in the
    worker, and live transcription of both tracks.

## Non-goals

- Recording with the phone screen off, which needs a native Android recorder.
- Participant names from the call.
- Real-time echo cancellation. Cleanup runs on the laptop. The live transcript of the "Me" track may show some
  echo, deduped against "Others".

## Constraints

- Audio never leaves the owner's machines. Only text goes to ccapi.
- If the laptop is off, slices wait and are transcribed later, and the page says so.
- Repo content in English, with no personal data.
- Initial JS stays at 655 kB or less; the recorder UI goes in a lazy chunk.

## Approaches

- **PC audio, chosen:** native WASAPI loopback in `Quorum.exe` (pure Go COM, no cgo, as the desktop app already
  builds with `CGO_ENABLED=0`).
- **PC audio, rejected:** `getDisplayMedia({audio})`. It asks for a picker every time and gives a single mixed
  track.
- **Echo, chosen:** offline adaptive cancellation plus dedupe on the laptop.
- **Echo, rejected:** the Windows Voice Capture DSP in real time. It is complex COM, for a live transcript that
  the final pass replaces anyway.

## Left to the builder

- The exact echo-canceller algorithm, as long as it is numpy only, with no new heavy dependencies.
- The dedupe similarity threshold.
- The recorder UI layout.
