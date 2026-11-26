#!/usr/bin/env python3
"""Quorum meeting worker.

quorumd runs this program in the venv that `quorumd meetings setup` creates, one job at a time. The job
arrives as one JSON object on stdin:

    {"jobId", "attempt", "meetingId", "step", "audioURL", "transcriptURL", "settings", "workDir"}

and the worker writes JSON lines on stdout:

    {"type": "progress", "pct": 0-100, "stage": "..."}
    {"type": "log", "message": "..."}
    {"type": "result", "result": {...}}      (last line on success)
    {"type": "error", "error": "..."}        (last line on failure, exit status 1)

Steps:
- transcribe: download the audio, convert it with ffmpeg to 16 kHz mono WAV (one file per channel for
  two-channel "me|others" recordings), transcribe with faster-whisper, label speakers with sherpa-onnx
  diarization, and return {segments: [{start_ms, end_ms, speaker, text}], duration_s, language}.
- summarize_local: summarise a transcript through the Ollama HTTP API, per 15-minute section, then merge,
  and return {title, summary, topics, decisions, openPoints, actions, attendees}.

Settings per step:
- transcribe: {language ("es", "" or "auto" to detect), channels ("me|others" or ""), speakers (the number of
  people when known, else 0), model (the Whisper model)}.
- summarize_local: {language, speakerNames ({label: name}), glossary (string or list), model (the Ollama
  model), ollamaURL, numCtx}; the transcript comes from the job's transcriptURL (a signed hub URL that serves
  {segments: [{start_ms, end_ms, speaker, text}]}), or from settings.segments (tests).

The summary prompts and repair rules live in prompts.json next to this file; the hub uses the same file for
the ccapi and OpenAI-compatible providers, and tests on both sides check the shared cases in
testdata/summary_cases.json.

Live mode (--live): a resident worker for live meetings. quorumd writes one transcribe_chunk job per stdin
line, in the same shape as above, with settings {language, model, prompt, fromMs, contextMs, liveBytes}. Every
output line carries the job's "jobId" and "attempt", and each job ends with its own result or error line; the
process keeps running and loads Whisper once (again only when settings.model changes). At stdin EOF it frees
the model and exits 0.
- The audio is the live meeting's growing WebM/Opus file. The worker keeps a mirror of it in the job's workDir
  (<workDir>/<meetingId>.webm) and fetches only the bytes it lacks, up to liveBytes, with an HTTP Range request.
- It decodes the header plus the clusters from the last one at or before fromMs - contextMs, up to the last
  complete block, and transcribes that. Words whose midpoint is before fromMs (the context) are dropped, and a
  last segment ending within 1 s of the decoded end is held back for the next chunk.
- The result is {segments: [{start_ms, end_ms, speaker, text}] (absolute times), through_ms, language}.
- liveBytes 0 is a warm-up: it only loads the model and returns no segments, with through_ms = fromMs.

Other modes (used by the setup): --check-cuda, --download-model NAME, --version.

The heavy libraries (faster_whisper, sherpa_onnx, numpy, soundfile) are imported lazily, so the logic can
be tested without them and without a GPU.
"""

from __future__ import annotations

import gc
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

# numpy's OpenBLAS starts one busy-waiting thread per core; the speaker clustering's eigen-decompositions ran
# 4–20× slower with 24 threads than with 8, worst when the machine is busy. Read when numpy is first imported.
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(max(1, min(8, os.cpu_count() or 1))))

WORKER_VERSION = "1"
SAMPLE_RATE = 16000
WHISPER_MODEL = "large-v3"
DIAR_THRESHOLD = 0.8
OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_MODEL = "gemma3:12b"
NUM_CTX = 32768
CHANNELS_ME_OTHERS = "me|others"
HERE = Path(__file__).resolve().parent
DIAR_DIR = HERE / "models" / "diarization"
SEGMENTATION_MODEL = DIAR_DIR / "pyannote-segmentation-3-0.onnx"
EMBEDDING_MODEL = DIAR_DIR / "nemo_en_titanet_large.onnx"


class WorkerError(Exception):
    """An error with a message meant for the owner (shown on the meeting page)."""


# ---------------------------------------------------------------------------------------------------
# output


class Emitter:
    """Writes the protocol's JSON lines; progress is only written when it moves. Every line carries the tags
    (in live mode, the job's jobId and attempt)."""

    def __init__(self, out=None, tags: dict | None = None):
        self.out = out or sys.stdout
        self.tags = dict(tags or {})
        self.last = None

    def _write(self, obj):
        self.out.write(json.dumps({**obj, **self.tags}, ensure_ascii=False) + "\n")
        self.out.flush()

    def progress(self, pct: float, stage: str):
        p = (max(0, min(100, int(pct))), stage)
        if p != self.last:
            self.last = p
            self._write({"type": "progress", "pct": p[0], "stage": stage})

    def log(self, message: str):
        self._write({"type": "log", "message": message})

    def result(self, result):
        self._write({"type": "result", "result": result})

    def error(self, message: str):
        self._write({"type": "error", "error": message})


def span(emit: Emitter, lo: float, hi: float, stage: str) -> Callable[[float], None]:
    """Maps a 0..1 fraction of one stage onto lo..hi of the step's progress."""
    return lambda frac: emit.progress(lo + (hi - lo) * max(0.0, min(1.0, frac)), stage)


# ---------------------------------------------------------------------------------------------------
# audio


MAX_DOWNLOAD = 450 * 1024 * 1024  # the hub accepts recordings of up to 400 MB


class _SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to the same scheme and host: the audio never comes from elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        a, b = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (a.scheme, a.netloc) != (b.scheme, b.netloc):
            raise WorkerError("The hub redirected the recording to another host; refused.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, dest: Path, on_progress: Callable[[float], None], limit: int = MAX_DOWNLOAD) -> Path:
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise WorkerError("The recording's URL is not an http(s) URL; refused.")
    opener = urllib.request.build_opener(_SameHostRedirects)
    try:
        with opener.open(url, timeout=60) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            if total > limit:
                raise WorkerError("The recording is larger than the 400 MB limit.")
            got = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                got += len(chunk)
                if got > limit:
                    raise WorkerError("The recording is larger than the 400 MB limit.")
                f.write(chunk)
                if total:
                    on_progress(got / total)
    except urllib.error.HTTPError as e:
        raise WorkerError(f"Could not download the recording from the hub (HTTP {e.code}).") from e
    except (urllib.error.URLError, OSError) as e:
        raise WorkerError(f"Could not download the recording from the hub: {e}") from e
    return dest


def _run(cmd: list[str], what: str) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError as e:
        raise WorkerError(f"{cmd[0]} is not installed; run `quorumd meetings setup` on this machine.") from e
    if p.returncode != 0:
        last = (p.stderr.strip().splitlines() or ["unknown error"])[-1]
        raise WorkerError(f"{what}: {last}")
    return p.stdout


def probe(src: Path) -> tuple[int, float]:
    """Returns (channels, duration in seconds) of the first audio stream."""
    out = _run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "a:0", "-show_entries", "stream=channels:format=duration",
                "-of", "json", str(src)], "ffmpeg could not read the recording")
    info = json.loads(out or "{}")
    streams = info.get("streams") or []
    if not streams:
        raise WorkerError("The recording has no audio track.")
    channels = int(streams[0].get("channels") or 1)
    try:
        duration = float((info.get("format") or {}).get("duration") or 0)
    except ValueError:
        duration = 0.0
    return channels, duration


def convert(src: Path, workdir: Path, split: bool) -> list[tuple[str | None, Path]]:
    """Converts to 16 kHz mono 16-bit WAV. split=True writes the first channel as "Me" and the second as
    "Others"; otherwise every channel is mixed down into one track with no label."""
    # only local files: a crafted container (HLS, concat…) cannot make ffmpeg open URLs or other paths
    base = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe",
            "-i", str(src), "-vn"]
    enc = ["-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le"]
    if split:
        me, others = workdir / "me.wav", workdir / "others.wav"
        cmd = base + ["-filter_complex", "[0:a]pan=mono|c0=c0[me];[0:a]pan=mono|c0=c1[ot]",
                      "-map", "[me]", *enc, str(me), "-map", "[ot]", *enc, str(others)]
        _run(cmd, "ffmpeg could not convert the recording")
        return [("Me", me), ("Others", others)]
    out = workdir / "audio.wav"
    _run(base + ["-ac", "1", *enc, str(out)], "ffmpeg could not convert the recording")
    return [(None, out)]


def load_wav(path: Path):
    import soundfile as sf

    audio, sr = sf.read(str(path), dtype="float32")
    if sr != SAMPLE_RATE:
        raise WorkerError(f"Unexpected sample rate {sr} after conversion.")
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    return audio


# ---------------------------------------------------------------------------------------------------
# transcription engines


@dataclass
class Segment:
    start: float  # seconds
    end: float
    text: str
    speaker: str = ""
    words: list[tuple[float, float, str]] = field(default_factory=list)  # (start, end, word)


class FasterWhisperEngine:
    """faster-whisper on CUDA float16 with VAD (the spike's settings)."""

    def __init__(self, model: str = WHISPER_MODEL, device: str = "cuda", compute_type: str = "float16"):
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise WorkerError("faster-whisper is not installed; run `quorumd meetings setup`.") from e
        try:
            self.model = WhisperModel(model, device=device, compute_type=compute_type)
        except Exception as e:  # noqa: BLE001 - shown to the owner
            raise WorkerError(describe_model_error(model, e)) from e

    def transcribe(self, audio, language: str | None, on_progress: Callable[[float], None], prompt: str | None = None):
        duration = max(len(audio) / SAMPLE_RATE, 0.001)
        try:
            segs, info = self.model.transcribe(
                audio,
                language=language,
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(threshold=0.25, min_silence_duration_ms=1500, speech_pad_ms=500),
                condition_on_previous_text=False,
                initial_prompt=prompt or None,
                # initial_prompt only reaches the first window when condition_on_previous_text is off;
                # hotwords is applied to every window
                hotwords=prompt or None,
                word_timestamps=True,
            )
            out = []
            for s in segs:
                ws = [(float(x.start), float(x.end), str(x.word)) for x in (getattr(s, "words", None) or [])]
                out.append(Segment(float(s.start), float(s.end), s.text.strip(), words=[x for x in ws if x[2].strip()]))
                on_progress(s.end / duration)
        except Exception as e:  # noqa: BLE001
            raise WorkerError(describe_model_error("", e)) from e
        return out, getattr(info, "language", language or "")

    def close(self):
        # dropping the model frees its GPU memory before the next step
        self.model = None
        gc.collect()


def describe_model_error(model: str, e: Exception) -> str:
    msg = str(e).strip() or e.__class__.__name__
    low = msg.lower()
    if "cuda" in low or "cublas" in low or "cudnn" in low or "gpu" in low:
        return f"The GPU failed while transcribing ({msg}). Check `nvidia-smi` on the machine, then Retry."
    if "cached snapshot" in low or "outgoing traffic" in low or e.__class__.__name__ == "LocalEntryNotFoundError":
        return f"The Whisper model {model or 'large-v3'} is not downloaded on this machine; run `quorumd meetings setup`."
    if model and ("not found" in low or "no such file" in low or "repository" in low or "connect" in low):
        return f"The Whisper model {model} is not available on this machine; run `quorumd meetings setup`. ({msg})"
    return f"Transcription failed: {msg}"


class FakeEngine:
    """A test engine: one segment per stretch of non-silent audio, with numbered words."""

    def __init__(self, *_, **__):
        self.calls = 0
        self.prompts = []

    def transcribe(self, audio, language, on_progress, prompt=None):
        self.calls += 1
        self.prompts.append(prompt)
        out = []
        for i, (a, b) in enumerate(voiced_spans(audio)):
            out.append(Segment(a, b, f"words {i + 1}", words=[(a, b, f"words {i + 1}")]))
            on_progress(b / max(len(audio) / SAMPLE_RATE, 0.001))
        on_progress(1)
        return out, language or "es"

    def close(self):
        pass


def voiced_spans(audio, window: float = 0.25, threshold: float = 0.05) -> list[tuple[float, float]]:
    """Contiguous stretches (seconds) whose RMS is above threshold, in windows of `window` seconds."""
    n = int(window * SAMPLE_RATE)
    spans, start = [], None
    total = len(audio)
    for i in range(0, total, n):
        chunk = audio[i:i + n]
        rms = (sum(float(x) * float(x) for x in chunk) / max(len(chunk), 1)) ** 0.5
        t = i / SAMPLE_RATE
        if rms > threshold and start is None:
            start = t
        elif rms <= threshold and start is not None:
            spans.append((start, t))
            start = None
    if start is not None:
        spans.append((start, total / SAMPLE_RATE))
    return spans


# ---------------------------------------------------------------------------------------------------
# diarization


@dataclass
class Turn:
    start: float
    end: float
    speaker: int


class SherpaDiarizer:
    """Speaker separation with the installed sherpa-onnx models. sherpa (pyannote segmentation 3.0 + NeMo
    TitaNet-large) gives the speech turns; its fixed-threshold clustering over-splits long meetings, so the
    turns are relabelled: TitaNet embeddings of short windows inside each turn, spectral clustering with an
    automatic speaker count (or the owner's count), see recluster_turns."""

    def __init__(self, num_speakers: int = 0, threshold: float = DIAR_THRESHOLD):
        if not SEGMENTATION_MODEL.exists() or not EMBEDDING_MODEL.exists():
            raise WorkerError("The speaker models are missing; run `quorumd meetings setup`.")
        import sherpa_onnx

        threads = max(1, min(8, os.cpu_count() or 1))
        emb_cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMBEDDING_MODEL), num_threads=threads)
        cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(SEGMENTATION_MODEL)),
                num_threads=threads),
            embedding=emb_cfg,
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers if num_speakers > 0 else -1,
                                                        threshold=threshold),
            min_duration_on=0.3, min_duration_off=0.5)
        if not cfg.validate():
            raise WorkerError("The speaker models are invalid; run `quorumd meetings setup` again.")
        self.sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(emb_cfg)
        self.num_speakers = num_speakers

    def diarize(self, audio, on_progress: Callable[[float], None]) -> list[Turn]:
        import numpy as np

        def cb(done, total):
            on_progress(0.7 * done / max(total, 1))
            return 0

        res = self.sd.process(audio, callback=cb).sort_by_start_time()
        turns = [Turn(float(r.start), float(r.end), int(r.speaker)) for r in res]
        spans = window_spans(turns)
        spans = usable_spans(spans, len(audio))
        X = np.zeros((len(spans), self.ex.dim), dtype=np.float32)
        for j, (_, a, b) in enumerate(spans):
            s = self.ex.create_stream()
            s.accept_waveform(SAMPLE_RATE, audio[int(a * SAMPLE_RATE):int(b * SAMPLE_RATE)])
            s.input_finished()
            X[j] = self.ex.compute(s)
            if j % 50 == 0:
                on_progress(0.7 + 0.25 * j / len(spans))
        on_progress(0.95)
        out = recluster_turns(turns, spans, X, self.num_speakers)
        on_progress(1)
        return out


# Re-clustering. Dense windows inside the segmentation turns, NME-SC (normalised maximum eigengap spectral
# clustering) for the speaker count, k-means on the spectral embedding for the labels.

# A longer meeting is subsampled evenly for the speaker count and the clustering, and every window then takes
# its nearest centroid. NME-SC runs one N×N eigen-decomposition per grid point (~30 at 2000, ~38 at 3000):
# on the laptop's 24 threads under load, 3000 took ~22 s and 2000 ~6 s; the spike's 1,859 windows fit whole.
MAX_CLUSTER_WINDOWS = 2000


def window_spans(turns: list[Turn], win: float = 1.5, hop: float = 0.75,
                 min_turn: float = 0.5) -> list[tuple[int, float, float]]:
    """(turn index, start, end) of the embedding windows: `win` seconds every `hop` seconds inside each turn
    of at least `min_turn` seconds; a turn no longer than `win` gives one window covering the whole turn."""
    out: list[tuple[int, float, float]] = []
    for i, t in enumerate(turns):
        d = t.end - t.start
        if d < min_turn:
            continue
        if d <= win:
            out.append((i, t.start, t.end))
            continue
        n = int((d - win) / hop + 1e-6) + 1
        for j in range(n):
            s = t.start + j * hop
            out.append((i, s, min(t.end, s + win)))
    return out


def usable_spans(spans, n_samples: int, min_samples: int = SAMPLE_RATE // 10):
    """The spans whose audio slice is at least min_samples long once clipped to the audio (a rounding edge at
    the end can leave an empty slice); the others are dropped, so spans and embeddings stay in step."""
    return [(i, a, b) for i, a, b in spans
            if min(int(b * SAMPLE_RATE), n_samples) - int(a * SAMPLE_RATE) >= min_samples]


def _unit_rows(X):
    import numpy as np

    X = np.asarray(X, dtype=np.float64)
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)


def _subsample(n: int):
    import numpy as np

    if n <= MAX_CLUSTER_WINDOWS:
        return np.arange(n)
    return np.linspace(0, n - 1, MAX_CLUSTER_WINDOWS).round().astype(int)


def _binarize(A, p: int):
    """The top-p neighbours of each row set to 1, symmetrised with (B+Bᵀ)/2."""
    import numpy as np

    B = np.zeros_like(A)
    idx = np.argpartition(-A, p - 1, axis=1)[:, :p]
    np.put_along_axis(B, idx, 1.0, axis=1)
    return (B + B.T) / 2


def _laplacian(B):
    import numpy as np

    return np.diag(B.sum(axis=1)) - B


def _nme_sc(X, max_k: int = 12) -> tuple[int, int]:
    """(p, K) by NME-SC on unit rows X: for each p of the grid, K is the largest gap among the first max_k+1
    Laplacian eigenvalues, and the p that minimises p / (maxgap / λ_max) wins."""
    import numpy as np

    n = len(X)
    if n < 2 or np.allclose(X, X[0], atol=1e-6):
        return 1, 1
    A = X @ X.T
    grid = list(range(4, 40, 2)) + list(range(40, int(n * 0.08), 10))
    grid = sorted({min(p, n - 1) for p in grid})
    best = None
    for p in grid:
        w = np.linalg.eigvalsh(_laplacian(_binarize(A, p)))
        gaps = np.diff(w[:max_k + 1])
        k = int(np.argmax(gaps)) + 1
        ratio = p / (gaps.max() / (w[-1] + 1e-9) + 1e-9)
        if best is None or ratio < best[0]:
            best = (ratio, p, k)
    return best[1], best[2]


def estimate_speakers(X, max_k: int = 12) -> int:
    """The number of speakers in the embeddings X (one row per window), by NME-SC; 1 under 2 windows."""
    X = _unit_rows(X)
    return _nme_sc(X[_subsample(len(X))], max_k)[1]


def _kmeans(E, k: int, restarts: int = 20, iters: int = 100, seed: int = 0):
    """Spherical k-means on the unit rows E; the restart with the highest cohesion wins."""
    import numpy as np

    rng = np.random.default_rng(seed)
    best = None
    for _ in range(restarts):
        C = E[rng.choice(len(E), k, replace=False)]
        for _ in range(iters):
            lab = np.argmax(E @ C.T, axis=1)
            C2 = np.array([E[lab == j].mean(axis=0) if (lab == j).any() else C[j] for j in range(k)])
            C2 = C2 / (np.linalg.norm(C2, axis=1, keepdims=True) + 1e-9)
            if np.allclose(C2, C):
                break
            C = C2
        lab = np.argmax(E @ C.T, axis=1)
        cohesion = float((E * C[lab]).sum())
        if best is None or cohesion > best[0]:
            best = (cohesion, lab)
    return best[1]


def cluster_embeddings(X, k: int, p: int | None = None):
    """A label in [0, k) for each row of X: spectral clustering into k clusters over the top-p binarised
    cosine affinity (p from NME-SC when not given). k is clipped to the number of windows. Beyond
    MAX_CLUSTER_WINDOWS rows an even subsample is clustered and every row takes its nearest centroid."""
    import numpy as np

    X = _unit_rows(X)
    n = len(X)
    k = max(1, min(int(k), n))
    if n == 0:
        return np.zeros(0, dtype=int)
    if k == 1:
        return np.zeros(n, dtype=int)
    sub = _subsample(n)
    Xs = X[sub]
    if p is None:
        p = _nme_sc(Xs)[0]
    p = max(1, min(p, len(Xs) - 1))
    _, v = np.linalg.eigh(_laplacian(_binarize(Xs @ Xs.T, p)))
    lab = _kmeans(_unit_rows(v[:, :k]), k)
    if len(sub) == n:
        return lab
    C = _unit_rows(np.array([Xs[lab == j].mean(axis=0) for j in range(k) if (lab == j).any()]))
    return np.argmax(X @ C.T, axis=1)


def recluster_turns(turns: list[Turn], spans, X, num_speakers: int = 0, min_talk: float = 10.0) -> list[Turn]:
    """New turns (same times) whose speakers come from the window embeddings X (one row per span of
    window_spans). K is num_speakers when given, else estimated. A turn takes the majority label of its
    windows; a turn without windows takes the label of the nearest labelled turn in time. A cluster with less
    than min_talk seconds of turn time merges into the most similar centroid, until none is left or one
    cluster remains. Speakers are renumbered 0.. by first appearance."""
    import numpy as np

    if not turns:
        return []
    X = _unit_rows(X)
    owner = np.array([s[0] for s in spans], dtype=int)
    n = len(X)
    if n < 2:
        win_lab = np.zeros(n, dtype=int)
    else:
        sub = _subsample(n)
        p, k = _nme_sc(X[sub])
        if num_speakers > 0:
            k = min(num_speakers, n)
        win_lab = cluster_embeddings(X, k, p)

    label: dict[int, int] = {}
    for ti in np.unique(owner):
        vals, counts = np.unique(win_lab[owner == ti], return_counts=True)
        label[int(ti)] = int(vals[np.argmax(counts)])
    labelled = sorted(label)
    for i, t in enumerate(turns):
        if i in label:
            continue
        if not labelled:
            label[i] = 0
            continue
        near = min(labelled, key=lambda j: (max(turns[j].start - t.end, t.start - turns[j].end, 0.0), j))
        label[i] = label[near]

    def talk() -> dict[int, float]:
        out: dict[int, float] = {}
        for i, t in enumerate(turns):
            out[label[i]] = out.get(label[i], 0.0) + (t.end - t.start)
        return out

    # the owner's count is respected as given: no merging of small clusters
    while num_speakers <= 0:
        tt = talk()
        if len(tt) < 2:
            break
        small = min(tt, key=lambda c: (tt[c], c))
        if tt[small] >= min_talk:
            break
        win_turn = np.array([label[int(o)] for o in owner], dtype=int)
        cents = {c: X[win_turn == c].mean(axis=0) for c in tt if (win_turn == c).any()}
        others = [c for c in tt if c != small]
        if small in cents:
            v = cents[small] / (np.linalg.norm(cents[small]) + 1e-9)

            def sim(c):
                if c not in cents:
                    return -2.0
                return float(v @ (cents[c] / (np.linalg.norm(cents[c]) + 1e-9)))

            target = max(others, key=lambda c: (sim(c), -c))
        else:
            target = max(others, key=lambda c: (tt[c], -c))
        for i in label:
            if label[i] == small:
                label[i] = target

    order = sorted(range(len(turns)), key=lambda i: (turns[i].start, turns[i].end, i))
    names: dict[int, int] = {}
    for i in order:
        names.setdefault(label[i], len(names))
    return [Turn(t.start, t.end, names[label[i]]) for i, t in enumerate(turns)]


class FakeDiarizer:
    """A test diarizer: a new speaker every `every` seconds, cycling through `speakers`."""

    def __init__(self, num_speakers: int = 0, every: float = 1.0, speakers: int = 2):
        self.every, self.speakers = every, num_speakers or speakers

    def diarize(self, audio, on_progress):
        total = len(audio) / SAMPLE_RATE
        turns, t, i = [], 0.0, 0
        while t < total:
            turns.append(Turn(t, min(t + self.every, total), i % self.speakers))
            t += self.every
            i += 1
        on_progress(1)
        return turns


def label_speakers(segs: list[Segment], turns: list[Turn], max_gap: float = 2.0) -> list[str | None]:
    """The diarization speaker of each segment: the turn with the largest time overlap, else the nearest
    turn within max_gap seconds, else None. Speakers are renamed "Speaker N" (1-based) by first appearance."""
    return _name_speakers([_turn_speaker(s.start, s.end, turns, max_gap) for s in segs])


def _turn_speaker(start: float, end: float, turns: list[Turn], max_gap: float) -> int | None:
    """The speaker of the turn with the largest overlap with [start, end]; for an empty or unmatched interval
    the turn containing it, else the nearest turn within max_gap seconds, else None."""
    best, overlap = None, 0.0
    for t in turns:
        o = min(end, t.end) - max(start, t.start)
        if o > overlap:
            best, overlap = t.speaker, o
    if best is None:
        mid = (start + end) / 2
        for t in turns:
            if t.start <= mid <= t.end:
                return t.speaker
        gap = max_gap
        for t in turns:
            g = max(t.start - end, start - t.end, 0.0)
            if g <= gap:
                best, gap = t.speaker, g
    return best


def _name_speakers(raw: list[int | None]) -> list[str | None]:
    names: dict[int, str] = {}
    out: list[str | None] = []
    for r in raw:
        if r is None:
            out.append(None)
            continue
        if r not in names:
            names[r] = f"Speaker {len(names) + 1}"
        out.append(names[r])
    return out


def split_by_speaker(segs: list[Segment], turns: list[Turn], max_gap: float = 2.0) -> list[Segment]:
    """New segments split wherever the speaker changes between consecutive words. Each word takes the speaker of
    its turn (see _turn_speaker); a word without one joins the previous word's speaker (a leading one, the next).
    A segment without words is labelled as a whole. Speakers are "Speaker N" by first appearance; "" if unknown."""
    pieces: list[tuple[Segment, int | None]] = []
    for s in segs:
        ws = [w for w in s.words if w[2].strip()]
        if not ws:
            pieces.append((Segment(s.start, s.end, s.text), _turn_speaker(s.start, s.end, turns, max_gap)))
            continue
        raw = [_turn_speaker(a, b, turns, max_gap) for a, b, _ in ws]
        known = [r for r in raw if r is not None]
        if not known:
            pieces.append((Segment(s.start, s.end, s.text, words=list(ws)), _turn_speaker(s.start, s.end, turns, max_gap)))
            continue
        prev = known[0]
        for i, r in enumerate(raw):
            if r is None:
                raw[i] = prev
            else:
                prev = r
        _absorb_short_runs(ws, raw)
        group: list[tuple[float, float, str]] = []
        gspk = None
        made: list[tuple[Segment, int | None]] = []
        for w, r in zip(ws, raw):
            if group and r != gspk:
                made.append((_from_words(group), gspk))
                group = []
            group.append(w)
            gspk = r
        made.append((_from_words(group), gspk))
        if len(made) == 1:
            made[0][0].text = s.text
        pieces.extend(made)
    names = _name_speakers([p[1] for p in pieces])
    for (seg, _), n in zip(pieces, names):
        seg.speaker = n or ""
    return [p[0] for p in pieces]


def _absorb_short_runs(ws, raw: list) -> None:
    """A run of one word, or shorter than 0.5 s, between two runs of the same speaker takes that speaker."""
    runs: list[list[int]] = []  # [first, last] word index of each run
    for i, r in enumerate(raw):
        if runs and raw[runs[-1][0]] == r:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    for k in range(1, len(runs) - 1):
        a, b = runs[k]
        if raw[runs[k - 1][0]] != raw[runs[k + 1][0]]:
            continue
        if a == b or ws[b][1] - ws[a][0] < 0.5:
            for i in range(a, b + 1):
                raw[i] = raw[runs[k - 1][0]]


def _from_words(ws: list[tuple[float, float, str]]) -> Segment:
    return Segment(ws[0][0], ws[-1][1], "".join(w[2] for w in ws).strip(), words=list(ws))


def merge_tracks(tracks: Iterable[list[Segment]]) -> list[Segment]:
    """Merges the per-channel segments by time (start, then end)."""
    merged = [s for t in tracks for s in t]
    merged.sort(key=lambda s: (s.start, s.end))
    return merged


# ---------------------------------------------------------------------------------------------------
# transcribe step


def run_transcribe(job: dict, emit: Emitter, workdir: Path, engine_factory=None, diarizer_factory=None) -> dict:
    settings = job.get("settings") or {}
    language = settings.get("language") or None
    if language == "auto":
        language = None
    speakers = int(settings.get("speakers") or 0)
    model = settings.get("model") or WHISPER_MODEL
    prompt = settings.get("prompt") or None
    engine_factory = engine_factory or (lambda: FasterWhisperEngine(model))
    diarizer_factory = diarizer_factory or (lambda: SherpaDiarizer(speakers))

    emit.progress(0, "downloading")
    src = download(job["audioURL"], workdir / "source", span(emit, 0, 5, "downloading"))
    emit.progress(5, "converting")
    channels, duration = probe(src)
    split = settings.get("channels") == CHANNELS_ME_OTHERS and channels >= 2
    tracks = convert(src, workdir, split)
    if split:
        emit.log("two-channel recording: transcribing Me and Others separately")
    emit.progress(10, "transcribing")

    engine = engine_factory()
    results: list[tuple[str | None, Path, list[Segment]]] = []
    detected = language or ""
    longest = 0
    try:
        for i, (label, path) in enumerate(tracks):
            # one track in memory at a time (a 2 h channel is ~460 MB of float32)
            lo, hi = 10 + 70 * i / len(tracks), 10 + 70 * (i + 1) / len(tracks)
            audio = load_wav(path)
            longest = max(longest, len(audio))
            segs, lang = engine.transcribe(audio, language, span(emit, lo, hi, "transcribing"), prompt)
            audio = None
            detected = detected or lang or ""
            results.append((label, path, segs))
    finally:
        engine.close()
        gc.collect()
    if not duration:
        duration = longest / SAMPLE_RATE

    emit.progress(80, "diarizing")
    # only the mixed track or the Others channel tells people apart; the Me channel is the owner
    to_diarize = [r for r in results if r[0] in (None, "Others") and r[2]]
    labelled: list[list[Segment]] = []
    diarizer = None
    if to_diarize:
        try:
            diarizer = diarizer_factory()
        except WorkerError as e:
            emit.log(f"speaker separation skipped: {e}")
        except Exception as e:  # noqa: BLE001 - diarization is best effort
            emit.log(f"speaker separation skipped: {e}")
    for label, path, segs in results:
        if label == "Me":
            for s in segs:
                s.speaker = "Me"
            labelled.append(segs)
            continue
        if diarizer is not None and segs:
            try:
                turns = diarizer.diarize(load_wav(path), span(emit, 80, 95, "diarizing"))
                segs = split_by_speaker(segs, turns)
            except Exception as e:  # noqa: BLE001
                emit.log(f"speaker separation failed: {e}")
        distinct = {s.speaker for s in segs if s.speaker}
        for s in segs:
            if label == "Others":
                # one voice on the Others channel stays "Others"
                s.speaker = s.speaker if len(distinct) > 1 and s.speaker else "Others"
        labelled.append(segs)
    emit.progress(95, "finishing")
    merged = merge_tracks(labelled)
    return {
        "segments": [{"start_ms": int(round(s.start * 1000)), "end_ms": int(round(s.end * 1000)),
                      "speaker": s.speaker, "text": s.text} for s in merged if s.text.strip()],
        "duration_s": round(duration, 2),
        "language": detected,
    }


# ---------------------------------------------------------------------------------------------------
# summarize_local step

_PROMPTS: dict | None = None


def prompts() -> dict:
    """The canonical prompts and repair rules (prompts.json, shared with the hub; quorumd deploys it next to
    this file). Loaded on first use, so the transcribe step and the setup modes never need it."""
    global _PROMPTS
    if _PROMPTS is None:
        try:
            p = json.loads((HERE / "prompts.json").read_text(encoding="utf-8"))
            p["_unknown"] = set(p["unknownOwners"])
            p["_generic"] = re.compile(p["genericSpeaker"])
            _PROMPTS = p
        except (OSError, ValueError, KeyError, re.error) as e:
            raise WorkerError(f"prompts.json is missing or invalid next to worker.py ({e}); update quorumd on this "
                              "machine.") from e
    return _PROMPTS


def _section_ms() -> int:
    return int(prompts()["sectionMinutes"]) * 60 * 1000


def fill(template: str, **values) -> str:
    """Replaces each {name} of values in one pass (an unknown placeholder stays as is), like the hub."""
    return re.sub(r"\{(\w+)\}", lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), template)


def compact_json(v) -> str:
    """JSON without spaces and with non-ASCII text as is (the hub writes the same bytes)."""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def fmt_ts(ms: int) -> str:
    s = int(ms // 1000)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def parse_ts(v) -> int | None:
    """A timestamp the model cited: "mm:ss", "hh:mm:ss" (optionally in brackets) or milliseconds."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v) if v >= 0 else None
    if isinstance(v, str):
        t = v.strip().strip("[]()")
        if re.fullmatch(r"\d+", t):
            return int(t)
        m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", t)
        if m:
            h, mi, s = int(m.group(1) or 0), int(m.group(2)), int(m.group(3))
            return ((h * 60 + mi) * 60 + s) * 1000
    return None


def render_lines(segments: list[dict], names: dict[str, str]) -> list[str]:
    lines = []
    for s in segments:
        who = s.get("speaker") or ""
        who = names.get(who, who)
        text = (s.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"[{fmt_ts(int(s.get('start_ms') or 0))}] {who + ': ' if who else ''}{text}")
    return lines


def split_sections(segments: list[dict], section_ms: int | None = None) -> list[list[dict]]:
    """Groups the segments into 15-minute sections by start time (empty sections are skipped)."""
    section_ms = section_ms or _section_ms()
    out: dict[int, list[dict]] = {}
    for s in segments:
        out.setdefault(int(s.get("start_ms") or 0) // section_ms, []).append(s)
    return [out[k] for k in sorted(out)]


def language_name(code: str) -> str:
    return prompts()["languages"].get((code or "").split("-")[0].lower(), code or prompts()["unknownLanguage"])


def glossary_text(g) -> str:
    if isinstance(g, list):
        g = ", ".join(str(x) for x in g if str(x).strip())
    g = (g or "").strip()
    return fill(prompts()["glossary"], glossary=g) if g else ""


def _rules(language: str) -> str:
    return fill(prompts()["rules"], language=language)


def section_prompt(lines: list[str], language: str, glossary, part: int, parts: int) -> list[dict]:
    where = fill(prompts()["sectionWhere"], part=part, parts=parts) if parts > 1 else ""
    system = fill(prompts()["sectionSystem"], schema=prompts()["schema"], rules=_rules(language))
    user = fill(prompts()["sectionUser"], where=where, glossary=glossary_text(glossary), transcript="\n".join(lines))
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def merge_prompt(parts: list[dict], language: str, glossary) -> list[dict]:
    system = fill(prompts()["mergeSystem"], schema=prompts()["schema"], rules=_rules(language))
    body = prompts()["mergePartSeparator"].join(fill(prompts()["mergePart"], n=i + 1, json=compact_json(p)) for i, p in enumerate(parts))
    return [{"role": "system", "content": system}, {"role": "user", "content": fill(prompts()["mergeUser"], glossary=glossary_text(glossary), parts=body)}]


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def words(s: str) -> list[str]:
    """The words of s for the "stated in the transcript" check: lower case, accents removed (NFKD without
    combining marks), split at anything that is not a letter or a digit. The hub does the same."""
    t = "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if unicodedata.category(c) != "Mn")
    return "".join(c if c.isalnum() else " " for c in t).split()


def _str(v) -> str:
    return v.strip() if isinstance(v, str) else ""


def _strs(v) -> list[str]:
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        x = _str(x)
        if x and x not in out:
            out.append(x)
    return out


def _points(v, max_ms: int | None) -> list[dict]:
    out = []
    for x in v if isinstance(v, list) else []:
        if isinstance(x, str):
            x = {"text": x}
        if not isinstance(x, dict):
            continue
        text = _str(x.get("text"))
        if not text:
            continue
        p = {"text": text}
        ts = parse_ts(x.get("ts_ms", x.get("ts")))
        if ts is not None and (max_ms is None or ts <= max_ms):
            p["ts_ms"] = ts
        out.append(p)
    return out


def repair_summary(raw, transcript_text: str, max_ms: int | None = None) -> dict:
    """Validates and repairs a summary: missing or mistyped fields become empty, owners and due dates
    that the transcript never mentions are dropped (never invented), generic speaker labels are not
    attendees, and timestamps become ts_ms."""
    if not isinstance(raw, dict):
        raw = {}
    hay = " " + " ".join(words(transcript_text)) + " "

    def stated(v: str) -> bool:
        w = words(v)
        return bool(w) and " " + " ".join(w) + " " in hay

    actions = []
    for a in raw.get("actions") if isinstance(raw.get("actions"), list) else []:
        if isinstance(a, str):
            a = {"text": a}
        if not isinstance(a, dict):
            continue
        text = _str(a.get("text"))
        if not text:
            continue
        owner = _str(a.get("owner"))
        if _norm(owner) in prompts()["_unknown"] or not stated(owner):
            owner = ""
        due = _str(a.get("due"))
        if _norm(due) in prompts()["_unknown"] or not stated(due):
            due = ""
        act = {"text": text, "owner": owner, "due": due}
        ts = parse_ts(a.get("ts_ms", a.get("ts")))
        if ts is not None and (max_ms is None or ts <= max_ms):
            act["ts_ms"] = ts
        actions.append(act)
    attendees = [n for n in _strs(raw.get("attendees")) if not prompts()["_generic"].match(n) and stated(n)]
    return {
        "title": _str(raw.get("title"))[:int(prompts()["titleMax"])],
        "summary": _str(raw.get("summary")),
        "topics": _strs(raw.get("topics")),
        "decisions": _points(raw.get("decisions"), max_ms),
        "openPoints": _points(raw.get("openPoints"), max_ms),
        "actions": actions,
        "attendees": attendees,
    }


def naive_merge(parts: list[dict]) -> dict:
    """Concatenates section summaries when the merge answer was unusable."""
    out = {"title": "", "summary": "", "topics": [], "decisions": [], "openPoints": [], "actions": [], "attendees": []}
    for p in parts:
        out["title"] = out["title"] or p.get("title", "")
        out["summary"] = (out["summary"] + "\n" + p.get("summary", "")).strip()
        for k in ("topics", "attendees"):
            out[k] += [x for x in p.get(k, []) if x not in out[k]]
        for k in ("decisions", "openPoints", "actions"):
            seen = {_norm(x["text"]) for x in out[k]}
            out[k] += [x for x in p.get(k, []) if _norm(x["text"]) not in seen]
    return out


def parse_json_answer(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        m = re.search(r"\{.*\}", text or "", re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    return None


class OllamaClient:
    """Ollama's /api/chat with JSON output, a 32k context, temperature 0.2 and thinking off."""

    def __init__(self, url: str = OLLAMA_URL, model: str = OLLAMA_MODEL, num_ctx: int = NUM_CTX, timeout: float = 1800):
        self.url, self.model, self.num_ctx, self.timeout = url.rstrip("/"), model, num_ctx, timeout

    def chat(self, messages: list[dict]) -> str:
        body = {"model": self.model, "messages": messages, "format": "json", "stream": False, "think": False,
                "options": {"num_ctx": self.num_ctx, "temperature": 0.2}}
        req = urllib.request.Request(self.url + "/api/chat", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if e.code == 404 or "not found" in detail.lower():
                raise WorkerError(f"The Ollama model {self.model} is not installed; run `ollama pull {self.model}` "
                                  "on the machine, then Retry.") from e
            raise WorkerError(f"Ollama answered HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, OSError) as e:
            raise WorkerError(f"Ollama is not reachable at {self.url} ({e}). Start it (`ollama serve`) or choose "
                              "another summary provider.") from e
        return (data.get("message") or {}).get("content") or ""


def ollama_url(settings: dict) -> str:
    """The Ollama address: the machine's own setting (QUORUM_OLLAMA_URL, from quorumd's config) wins; one from
    the hub's job settings must be a loopback address, so a job cannot send the transcript elsewhere."""
    local = os.environ.get("QUORUM_OLLAMA_URL", "").strip()
    if local:
        return local
    url = (settings.get("ollamaURL") or OLLAMA_URL).strip()
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if u.scheme not in ("http", "https") or not loopback:
        raise WorkerError(f"The Ollama address {url} is not on this machine; set ollamaUrl in this machine's quorumd "
                          "config to use a remote Ollama.")
    return url


MAX_TRANSCRIPT = 64 * 1024 * 1024


def fetch_transcript(url: str, limit: int = MAX_TRANSCRIPT) -> list[dict]:
    """The job's transcript from the hub's signed URL: {segments: [{start_ms, end_ms, speaker, text}]}."""
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise WorkerError("The transcript's URL is not an http(s) URL; refused.")
    opener = urllib.request.build_opener(_SameHostRedirects)
    try:
        with opener.open(url, timeout=60) as r:
            body = r.read(limit + 1)
    except urllib.error.HTTPError as e:
        raise WorkerError(f"Could not download the transcript from the hub (HTTP {e.code}).") from e
    except (urllib.error.URLError, OSError) as e:
        raise WorkerError(f"Could not download the transcript from the hub: {e}") from e
    if len(body) > limit:
        raise WorkerError("The transcript is too large.")
    try:
        data = json.loads(body)
    except ValueError as e:
        raise WorkerError("The hub sent an invalid transcript.") from e
    segs = data.get("segments") if isinstance(data, dict) else None
    if not isinstance(segs, list):
        raise WorkerError("The hub sent an invalid transcript.")
    return [x for x in segs if isinstance(x, dict)]


def run_summarize(job: dict, emit: Emitter, chat: Callable[[list[dict]], str] | None = None) -> dict:
    settings = job.get("settings") or {}
    # the hub sends a signed URL rather than the transcript itself (it can be megabytes)
    segments = settings.get("segments") or (fetch_transcript(job["transcriptURL"]) if job.get("transcriptURL") else [])
    names = {k: v for k, v in (settings.get("speakerNames") or {}).items() if isinstance(v, str) and v.strip()}
    language = language_name(settings.get("language") or "")
    glossary = settings.get("glossary")
    if chat is None:
        chat = OllamaClient(ollama_url(settings), settings.get("model") or OLLAMA_MODEL,
                            int(settings.get("numCtx") or NUM_CTX)).chat
    all_lines = render_lines(segments, names)
    if not all_lines:
        raise WorkerError("The transcript is empty, so there is nothing to summarise.")
    transcript_text = "\n".join(all_lines)
    max_ms = max(int(s.get("end_ms") or s.get("start_ms") or 0) for s in segments)
    sections = split_sections(segments)
    steps = len(sections) + (1 if len(sections) > 1 else 0)
    parts = []
    for i, sec in enumerate(sections):
        emit.progress(100 * i / steps, "summarizing")
        answer = parse_json_answer(chat(section_prompt(render_lines(sec, names), language, glossary, i + 1, len(sections))))
        if answer is None:
            raise WorkerError("The local model did not return valid JSON for the summary.")
        parts.append(repair_summary(answer, transcript_text, max_ms))
    if len(parts) == 1:
        final = parts[0]
    else:
        emit.progress(100 * len(sections) / steps, "merging")
        answer = parse_json_answer(chat(merge_prompt(parts, language, glossary)))
        final = repair_summary(answer, transcript_text, max_ms) if isinstance(answer, dict) else naive_merge(parts)
        if not final["summary"] and not final["decisions"] and not final["actions"]:
            final = naive_merge(parts)
    emit.progress(100, "summarizing")
    return final


# ---------------------------------------------------------------------------------------------------
# live mode (transcribe_chunk)
#
# A live meeting's audio is one growing WebM/Opus file (Chrome's MediaRecorder: a Segment and Clusters of
# unknown size). The worker keeps a mirror of it in the job's work folder, fetches only the new bytes with
# Range, and for each chunk decodes the header plus the clusters from the last one at or before
# fromMs - contextMs, up to the last complete block. Cluster timecodes count from the recorder's start, so the
# times are absolute.

STEP_TRANSCRIBE_CHUNK = "transcribe_chunk"
LIVE_CONTEXT_MS = 2000
LIVE_HOLD_MS = 1000
MEETING_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
NOT_WEBM = "The live recording is not WebM audio."

EBML_ID = 0x1A45DFA3
SEGMENT_ID = 0x18538067
INFO_ID = 0x1549A966
TIMECODE_SCALE_ID = 0x2AD7B1
TRACKS_ID = 0x1654AE6B
CLUSTER_ID = 0x1F43B675
TIMECODE_ID = 0xE7
SIMPLE_BLOCK_ID = 0xA3
BLOCK_GROUP_ID = 0xA0
CUES_ID = 0x1C53BB6B
# the Segment-level ids that end an unknown-size Cluster (SeekHead, Tags, Chapters and Attachments too)
SEGMENT_LEVEL_IDS = {CLUSTER_ID, CUES_ID, INFO_ID, TRACKS_ID, 0x114D9B74, 0x1254C367, 0x1043A770, 0x1941A469,
                     EBML_ID, SEGMENT_ID}
UNKNOWN_SIZE = bytes.fromhex("01FFFFFFFFFFFFFF")


@dataclass
class WebmIndex:
    header_end: int  # the offset of the first cluster (everything before it is the header)
    clusters: list[tuple[int, int]]  # (byte offset, timecode in ms) of each top-level cluster
    end: int  # the offset after the last complete block


def _ebml_element(data, pos: int) -> tuple[int, int, int] | None:
    """(id, data start, data size) of the element at pos, size -1 when unknown; None when the element's header
    is cut off or invalid."""
    n = len(data)
    if pos >= n:
        return None
    first = data[pos]
    width = 1
    while width <= 4 and not first & (0x80 >> (width - 1)):
        width += 1
    if width > 4 or pos + width > n:
        return None
    eid = int.from_bytes(data[pos:pos + width], "big")
    p = pos + width
    if p >= n:
        return None
    first = data[p]
    length = 1
    while length <= 8 and not first & (0x80 >> (length - 1)):
        length += 1
    if length > 8 or p + length > n:
        return None
    size = first & (0xFF >> length)
    for b in data[p + 1:p + length]:
        size = (size << 8) | b
    if size == (1 << (7 * length)) - 1:
        size = -1
    return eid, p + length, size


def _uint(data, start: int, size: int) -> int:
    return int.from_bytes(data[start:start + size], "big") if size > 0 else 0


def _scan_cluster(data, start: int, stop: int, unknown: bool) -> tuple[int | None, int, int, bool]:
    """Walks a cluster's children from start to stop: (timecode, end of its last complete block or 0, the
    offset after the cluster, whether the cluster is complete)."""
    tc, block_end, pos = None, 0, start
    while pos < stop:
        el = _ebml_element(data, pos)
        if el is None:
            return tc, block_end, pos, False
        eid, s, size = el
        if unknown and eid in SEGMENT_LEVEL_IDS:
            return tc, block_end, pos, True
        if size < 0 or s + size > stop:
            return tc, block_end, pos, False
        if eid == TIMECODE_ID:
            tc = _uint(data, s, size)
        elif eid in (SIMPLE_BLOCK_ID, BLOCK_GROUP_ID):
            block_end = s + size
        pos = s + size
    return tc, block_end, pos, stop < len(data) or not unknown


def _segment_header(data) -> tuple[int, int, int]:
    """(Segment element offset, Segment data start, Segment data end) of a WebM file."""
    el = _ebml_element(data, 0)
    if el is None or el[0] != EBML_ID or el[2] < 0:
        raise WorkerError(NOT_WEBM)
    seg = el[1] + el[2]
    el = _ebml_element(data, seg)
    if el is None or el[0] != SEGMENT_ID:
        raise WorkerError(NOT_WEBM)
    end = len(data) if el[2] < 0 else min(len(data), el[1] + el[2])
    return seg, el[1], end


def webm_index(data) -> WebmIndex:
    """The top-level clusters of a WebM file (or of a prefix of one), with their timecodes in ms."""
    _, pos, seg_end = _segment_header(data)
    scale = 1_000_000
    raw: list[tuple[int, int]] = []
    header_end, end = None, 0
    while pos < seg_end:
        el = _ebml_element(data, pos)
        if el is None:
            break
        eid, start, size = el
        if eid == CLUSTER_ID:
            if header_end is None:
                header_end = pos
            stop = seg_end if size < 0 else min(seg_end, start + size)
            tc, block_end, nxt, complete = _scan_cluster(data, start, stop, size < 0)
            if tc is None:
                break
            raw.append((pos, tc))
            end = max(end, block_end)
            if not complete:
                break
            pos = nxt if size < 0 else start + size
            continue
        if size < 0:
            break
        if eid == INFO_ID:
            p, info_end = start, min(seg_end, start + size)
            while p < info_end:
                child = _ebml_element(data, p)
                if child is None or child[2] < 0:
                    break
                if child[0] == TIMECODE_SCALE_ID and child[1] + child[2] <= len(data):
                    scale = _uint(data, child[1], child[2]) or 1_000_000
                p = child[1] + child[2]
        pos = start + size
    if header_end is None:
        header_end = min(pos, len(data))
    clusters = [(off, tc * scale // 1_000_000) for off, tc in raw]
    return WebmIndex(header_end, clusters, max(end, header_end) if clusters else header_end)


def fetch_range(url: str, dest: Path, start: int, end: int) -> None:
    """Appends the bytes [start, end) of url to dest (which holds the first `start` bytes). A server that
    ignores Range (200) rewrites dest from the body's first `end` bytes."""
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise WorkerError("The recording's URL is not an http(s) URL; refused.")
    if end <= start:
        return
    if end > MAX_DOWNLOAD:
        raise WorkerError("The recording is larger than the 400 MB limit.")
    have = dest.stat().st_size if dest.exists() else 0
    if have < start:
        raise WorkerError("The local copy of the live recording is shorter than expected.")
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end - 1}"})
    opener = urllib.request.build_opener(_SameHostRedirects)
    try:
        with opener.open(req, timeout=60) as r:
            if r.status == 206:
                if not (r.headers.get("Content-Range") or "").startswith(f"bytes {start}-"):
                    raise WorkerError("The hub answered a different part of the live recording.")
                f, need = open(dest, "r+b" if dest.exists() else "wb"), end - start
                f.seek(start)
                f.truncate()
            else:
                f, need = open(dest, "wb"), end
            got = 0
            with f:
                while got < need:
                    chunk = r.read(min(1 << 20, need - got))
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
            if got < need:
                raise WorkerError("The hub sent less of the live recording than expected.")
    except urllib.error.HTTPError as e:
        raise WorkerError(f"Could not download the live recording from the hub (HTTP {e.code}).") from e
    except (urllib.error.URLError, OSError) as e:
        raise WorkerError(f"Could not download the live recording from the hub: {e}") from e


def _wav_ms(path: Path) -> int:
    import wave

    with wave.open(str(path), "rb") as f:
        return f.getnframes() * 1000 // max(f.getframerate(), 1)


def live_audio(mirror: Path, from_ms: int, context_ms: int, workdir: Path) -> tuple[Path | None, int, int]:
    """The WAV of the mirror's audio from (from_ms - context_ms) to its last complete block, with its absolute
    start and end in ms; the WAV is None when nothing lies after from_ms."""
    import mmap

    with open(mirror, "rb") as f:
        if os.fstat(f.fileno()).st_size == 0:
            raise WorkerError(NOT_WEBM)
        with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
            idx = webm_index(data)
            if not idx.clusters or idx.end <= idx.clusters[0][0]:
                return None, from_ms, from_ms
            target = max(0, from_ms - context_ms)
            off, tc = idx.clusters[0]
            for c in idx.clusters:
                if c[1] <= target:
                    off, tc = c
            seg, seg_data, _ = _segment_header(data)
            chunk = workdir / "live-chunk.webm"
            with open(chunk, "wb") as out:
                # the Segment's size becomes unknown: the chunk is shorter than the file it was cut from
                out.write(data[:seg] + data[seg:seg_data][:4] + UNKNOWN_SIZE + data[seg_data:idx.header_end])
                out.write(data[off:idx.end])
    skip_ms = max(0, target - tc)
    wav = workdir / "live-chunk.wav"
    try:
        _run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe",
              "-i", str(chunk), "-vn", "-ss", f"{skip_ms / 1000:.3f}", "-ac", "1", "-ar", str(SAMPLE_RATE),
              "-c:a", "pcm_s16le", str(wav)], "ffmpeg could not convert the live recording")
    finally:
        chunk.unlink(missing_ok=True)
    start_ms = tc + skip_ms
    end_ms = start_ms + _wav_ms(wav)
    if end_ms <= from_ms:
        wav.unlink(missing_ok=True)
        return None, from_ms, from_ms
    return wav, start_ms, end_ms


def keep_new(segs: list[Segment], start_ms: int, from_ms: int, end_ms: int, hold_ms: int = LIVE_HOLD_MS,
             final: bool = False) -> tuple[list[Segment], int]:
    """The new part of a chunk's segments, in absolute times, and the time transcribed through. A word whose
    midpoint is before from_ms belongs to the context and is dropped (the text is rebuilt from the words left).
    A last segment ending within hold_ms of end_ms may be cut, so it is held back for the next chunk (through_ms
    is then its start), unless nothing else is new or final is set."""
    off = start_ms / 1000
    lo = from_ms / 1000
    out: list[Segment] = []
    for s in segs:
        ws = [(a + off, b + off, t) for a, b, t in s.words if t.strip()]
        if ws:
            ws = [x for x in ws if (x[0] + x[1]) / 2 >= lo]
            if not ws:
                continue
            text = "".join(x[2] for x in ws).strip()
            out.append(Segment(ws[0][0], max(ws[-1][1], ws[0][0]), text, s.speaker, ws))
        else:
            a, b = s.start + off, s.end + off
            if (a + b) / 2 >= lo and s.text.strip():
                out.append(Segment(a, b, s.text.strip(), s.speaker))
    out = [s for s in out if s.text]
    through = end_ms
    if not final and len(out) > 1 and out[-1].end * 1000 > end_ms - hold_ms:
        held = out.pop()
        through = max(from_ms, int(round(held.start * 1000)))
    return out, through


def run_chunk(job: dict, emit: Emitter, engine) -> dict:
    settings = job.get("settings") or {}
    meeting = job.get("meetingId")
    if not isinstance(meeting, str) or not MEETING_ID_RE.fullmatch(meeting):
        raise WorkerError("The chunk job has an invalid meeting id; update quorumd on this machine.")
    work = Path(job.get("workDir") or "")
    if not job.get("workDir") or not work.is_dir():
        raise WorkerError("The job has no work folder; update quorumd on this machine.")
    language = settings.get("language") or None
    if language == "auto":
        language = None
    prompt = settings.get("prompt") or None
    from_ms = max(0, int(settings.get("fromMs") or 0))
    context_ms = max(0, int(settings.get("contextMs", LIVE_CONTEXT_MS) or 0))
    live_bytes = max(0, int(settings.get("liveBytes") or 0))
    nothing = {"segments": [], "through_ms": from_ms, "language": language or ""}
    if live_bytes == 0:
        return nothing  # warm-up: the engine is loaded, nothing to transcribe yet
    mirror = work / f"{meeting}.webm"
    have = mirror.stat().st_size if mirror.exists() else 0
    if have > live_bytes:
        mirror.unlink()
        have = 0
    if have < live_bytes:
        fetch_range(job.get("audioURL") or "", mirror, have, live_bytes)
    wav, start_ms, end_ms = live_audio(mirror, from_ms, context_ms, work)
    if wav is None:
        return nothing
    try:
        audio = load_wav(wav)
    finally:
        wav.unlink(missing_ok=True)
    segs, lang = engine.transcribe(audio, language, lambda _f: None, prompt)
    kept, through = keep_new(segs, start_ms, from_ms, end_ms)
    return {
        "segments": [{"start_ms": int(round(s.start * 1000)), "end_ms": int(round(s.end * 1000)),
                      "speaker": s.speaker, "text": s.text} for s in kept],
        "through_ms": through,
        "language": lang or language or "",
    }


def _live_engine(model: str):
    return FakeEngine() if fakes_enabled() else FasterWhisperEngine(model)


def run_live(lines: Iterable[str], out, engine_factory=None) -> int:
    """The resident worker: one JSON job per line, every output line tagged with the job's jobId and attempt.
    The engine (engine_factory(model)) is created on the first job and again only when the model changes; a
    failed job becomes an error line and the loop goes on. At EOF the engine is closed."""
    factory = engine_factory or _live_engine
    engine, model = None, None
    try:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            emit = Emitter(out)
            try:
                job = json.loads(line)
                if not isinstance(job, dict):
                    raise WorkerError("The job could not be read (not a JSON object).")
                emit = Emitter(out, tags={"jobId": job.get("jobId") or "", "attempt": job.get("attempt") or 0})
                if job.get("step") != STEP_TRANSCRIBE_CHUNK:
                    raise WorkerError(f"Unknown live step {job.get('step')!r}; update quorumd on this machine.")
                want = (job.get("settings") or {}).get("model") or WHISPER_MODEL
                if engine is None or want != model:
                    if engine is not None:
                        old, engine = engine, None
                        old.close()
                    emit.log(f"loading the Whisper model {want}")
                    engine, model = factory(want), want
                emit.result(run_chunk(job, emit, engine))
            except WorkerError as e:
                emit.error(str(e))
            except json.JSONDecodeError:
                emit.error("The job could not be read (invalid JSON).")
            except Exception as e:  # noqa: BLE001 - every failure ends as a readable error line
                emit.error(f"The meeting worker failed: {e.__class__.__name__}: {e}")
    finally:
        if engine is not None:
            engine.close()
    return 0


# ---------------------------------------------------------------------------------------------------
# setup helpers


def check_cuda(model: str = WHISPER_MODEL) -> dict:
    """The setup's GPU test: CUDA visible to CTranslate2 and 5 s of audio through the model on the GPU."""
    t0 = time.time()
    try:
        import ctranslate2
        import numpy as np

        n = ctranslate2.get_cuda_device_count()
        if n < 1:
            return {"cuda": False, "error": "CTranslate2 sees no CUDA device"}
        eng = FasterWhisperEngine(model)
        t = np.arange(5 * SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
        audio = (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        eng.transcribe(audio, "en", lambda _f: None)
        eng.close()
    except WorkerError as e:
        return {"cuda": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"cuda": False, "error": f"{e.__class__.__name__}: {e}"}
    return {"cuda": True, "devices": n, "seconds": round(time.time() - t0, 1)}


def download_model(name: str) -> str:
    from faster_whisper.utils import download_model as dl

    return dl(name)


# ---------------------------------------------------------------------------------------------------
# main


def fakes_enabled() -> bool:
    return os.environ.get("QUORUM_MEETINGS_FAKE") == "1"


def run_job(job: dict, emit: Emitter) -> dict:
    step = job.get("step")
    if step == "transcribe":
        # the daemon creates the job's private folder and removes it whatever happens to this process
        work = Path(job.get("workDir") or "")
        if not job.get("workDir") or not work.is_dir():
            raise WorkerError("The job has no work folder; update quorumd on this machine.")
        if fakes_enabled():
            return run_transcribe(job, emit, work, FakeEngine, lambda: FakeDiarizer(int((job.get("settings") or {}).get("speakers") or 0)))
        return run_transcribe(job, emit, work)
    if step == "summarize_local":
        return run_summarize(job, emit)
    raise WorkerError(f"Unknown step {step!r}; update quorumd on this machine.")


def main(argv: list[str]) -> int:
    if "--version" in argv:
        print(WORKER_VERSION)
        return 0
    if "--check-cuda" in argv:
        print(json.dumps(check_cuda()))
        return 0
    if "--download-model" in argv:
        i = argv.index("--download-model")
        name = argv[i + 1] if i + 1 < len(argv) else WHISPER_MODEL
        print(download_model(name))
        return 0
    if "--live" in argv:
        return run_live(sys.stdin, sys.stdout)
    emit = Emitter()
    try:
        job = json.loads(sys.stdin.read() or "{}")
        emit.result(run_job(job, emit))
        return 0
    except WorkerError as e:
        emit.error(str(e))
    except json.JSONDecodeError:
        emit.error("The job could not be read (invalid JSON).")
    except Exception as e:  # noqa: BLE001 - every failure ends as a readable error line
        emit.error(f"The meeting worker failed: {e.__class__.__name__}: {e}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
