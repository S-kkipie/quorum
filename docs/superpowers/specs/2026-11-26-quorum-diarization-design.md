# Speaker separation (diarization) — Design

Date: 2026-11-26. Status: the owner asked to fix speaker separation, "imitating AssemblyAI's technology", on the
laptop's RTX 5080 (16 GB).

## Problem

On a 57-minute room recording of a meeting with about 4 people, the current pipeline produced 36–37 "speakers".
That pipeline is sherpa-onnx with pyannote segmentation 3.0, TitaNet-large embeddings, and fast clustering at a
fixed threshold of 0.8. One fixed distance threshold over-splits long recordings, because a voice drifts with
distance to the mic, emotion and noise.

## Approach

AssemblyAI and NeMo-style pipelines follow the same recipe:

- dense speaker embeddings over short windows;
- the speaker count estimated from the structure of the embedding graph;
- clustering into that count;
- turns aligned with the words.

A spike on the owner's recording used the installed models and pure numpy:

- 1,859 windows (1.5 s, hop 0.75 s) were cut inside the segmentation turns, and a TitaNet embedding was taken for
  each.
- Spectral clustering with automatic K, in the NME-SC style, ran on the cosine affinity. NME-SC binarises the
  top-p neighbours, picks p by minimising p divided by the normalised eigengap, and sets K at the largest eigengap.
- The result was **4 speakers** (21.5, 7.2, 1.2 and 1.0 minutes of talk). It took 26 s on CPU on top of the
  existing segmentation.

### Alternatives considered

- **pyannote community-1 or DiariZen.** Strong, but the models are gated or non-commercial, and they need PyTorch
  plus a multi-GB install. Disk is tight.
- **NVIDIA Sortformer.** Limited to 4 speakers, and it needs NeMo, a heavy install.

Chosen: keep the installed ONNX models and replace the clustering, then align with Whisper word timestamps.

## Goals

1. **Re-clustering.**
   - Keep sherpa's segmentation turns. Embed windows of 1.5 s with a hop of 0.75 s inside each turn of at least
     0.5 s, using the same TitaNet ONNX model.
   - Cluster with automatic K: NME-SC with p chosen from a grid, and K at most 12.
   - When the owner gave the number of people (`speakers` > 0), use that K.
   - Each turn gets the majority label of its windows. A turn under 0.5 s takes the label of the nearest turn in
     time.
   - A cluster with less than 10 s of total talk merges into the nearest cluster by centroid.
   - Speaker numbering follows the order of first appearance.
2. **Word-level alignment.**
   - Use faster-whisper `word_timestamps=True`.
   - Give each word the speaker whose turn covers its midpoint; failing that, the nearest turn.
   - Split a Whisper segment wherever the speaker changes between words. The new segments take the times of their
     words.
   - Two-channel "me|others" recordings keep their channel logic.
3. Everything stays in the worker (numpy and sherpa-onnx), with no new dependencies or models.

## Non-goals

- Recognising the same person across meetings (voice memory).
- Overlap-aware labels for two people speaking at once.

## Constraints

- No new dependencies, no new model downloads, and disk use unchanged.
- Runtime: at most 2 minutes more for a 1-hour meeting on the laptop.
- Tests use synthetic embeddings and the fake engines, with no model needed.
- English only in repo content.
