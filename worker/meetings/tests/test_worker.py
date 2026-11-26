"""Tests of the meeting worker with fake engines: no GPU, no network (the audio and Ollama are served by
local fakes on 127.0.0.1). Audio is synthetic, generated with ffmpeg at test time."""

import io
import json
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

import worker as w

WORKER = Path(w.__file__)
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
                                  reason="ffmpeg is not installed")


# ---------------------------------------------------------------------------------------------------
# fixtures


def tone_file(path: Path, left: str, right: str | None = None, seconds: int = 6) -> Path:
    """A synthetic recording: each channel is a 440 Hz tone where its expression is 1, silence elsewhere."""
    expr = f"({left})*0.5*sin(2*PI*440*t)"
    if right is not None:
        expr += f"|({right})*0.5*sin(2*PI*660*t)"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc='{expr}':s=16000:d={seconds}", str(path)], check=True)
    return path


class _Files(BaseHTTPRequestHandler):
    def do_GET(self):
        body = self.server.files.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(n))
        self.server.requests.append((self.path, req))
        reply = self.server.replies.pop(0) if self.server.replies else {"message": {"content": "{}"}}
        code = reply.pop("_status", 200) if isinstance(reply, dict) else 200
        data = json.dumps(reply).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


@pytest.fixture
def local_http():
    srv = HTTPServer(("127.0.0.1", 0), _Files)
    srv.files, srv.requests, srv.replies = {}, [], []
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    srv.base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield srv
    srv.shutdown()


def serve(local_http, path: Path) -> str:
    local_http.files["/audio"] = path.read_bytes()
    return local_http.base + "/audio"


# ---------------------------------------------------------------------------------------------------
# transcribe: channels, merge order and speakers


@needs_ffmpeg
def test_two_channel_split_and_merge_order(tmp_path, local_http):
    # Me speaks 0–2 s and 4–6 s; Others answers 2–4 s
    src = tone_file(tmp_path / "rec.flac", "lt(t,2)+gte(t,4)", "between(t,2,4)")
    job = {"step": "transcribe", "audioURL": serve(local_http, src), "settings": {"channels": "me|others", "language": "es"}}
    work = tmp_path / "work"
    work.mkdir()
    out = io.StringIO()
    res = w.run_transcribe(job, w.Emitter(out), work, w.FakeEngine, lambda: w.FakeDiarizer(speakers=1, every=10))
    speakers = [s["speaker"] for s in res["segments"]]
    assert speakers == ["Me", "Others", "Me"]
    starts = [s["start_ms"] for s in res["segments"]]
    assert starts == sorted(starts)
    assert abs(starts[1] - 2000) <= 250 and abs(starts[2] - 4000) <= 250
    assert res["duration_s"] == pytest.approx(6, abs=0.1)
    assert res["language"] == "es"
    pcts = [json.loads(l)["pct"] for l in out.getvalue().splitlines() if json.loads(l)["type"] == "progress"]
    assert pcts == sorted(pcts) and pcts[-1] >= 95


@needs_ffmpeg
def test_others_channel_is_diarized_and_me_stays_me(tmp_path, local_http):
    # Others has two voices (2–2.5 s and 3.25–4 s); the diarizer switches speaker every second
    src = tone_file(tmp_path / "rec.wav", "lt(t,2)", "between(t,2,2.5)+between(t,3.25,4)")
    job = {"step": "transcribe", "audioURL": serve(local_http, src), "settings": {"channels": "me|others"}}
    work = tmp_path / "w"
    work.mkdir()
    res = w.run_transcribe(job, w.Emitter(io.StringIO()), work, w.FakeEngine, lambda: w.FakeDiarizer(speakers=2, every=1))
    speakers = [s["speaker"] for s in res["segments"]]
    assert speakers[0] == "Me"
    assert set(speakers[1:]) == {"Speaker 1", "Speaker 2"}
    assert speakers[1] == "Speaker 1"  # numbered by first appearance


@needs_ffmpeg
def test_transcribe_passes_prompt_to_engine(tmp_path, local_http):
    src = tone_file(tmp_path / "rec.flac", "lt(t,2)", "between(t,3,4)")
    job = {"step": "transcribe", "audioURL": serve(local_http, src), "settings": {"prompt": "Vocabulary: zorvanite."}}
    work = tmp_path / "w"
    work.mkdir()
    engines = []

    def factory():
        engines.append(w.FakeEngine())
        return engines[-1]

    w.run_transcribe(job, w.Emitter(io.StringIO()), work, factory, lambda: w.FakeDiarizer(speakers=1, every=3))
    assert engines[0].prompts == ["Vocabulary: zorvanite."]


def test_engine_uses_soft_vad_and_no_previous_text(monkeypatch):
    import types

    seen = {}

    class StubModel:
        def __init__(self, *a, **k):
            pass

        def transcribe(self, audio, **kw):
            seen.update(kw)
            return iter([]), types.SimpleNamespace(language="en")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=StubModel))
    eng = w.FasterWhisperEngine("stub")
    eng.transcribe([0.0] * 16000, "en", lambda p: None, "Vocabulary: zorvanite.")
    assert seen == dict(
        language="en",
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(threshold=0.25, min_silence_duration_ms=1500, speech_pad_ms=500),
        condition_on_previous_text=False,
        initial_prompt="Vocabulary: zorvanite.",
        hotwords="Vocabulary: zorvanite.",
        word_timestamps=True,
    )
    eng.transcribe([0.0] * 16000, "en", lambda p: None)
    assert seen["initial_prompt"] is None and seen["hotwords"] is None


@needs_ffmpeg
def test_without_channel_metadata_the_channels_are_mixed(tmp_path, local_http):
    src = tone_file(tmp_path / "rec.flac", "lt(t,2)", "between(t,3,4)")
    job = {"step": "transcribe", "audioURL": serve(local_http, src), "settings": {}}
    work = tmp_path / "w"
    work.mkdir()
    calls = []

    class Engine(w.FakeEngine):
        def transcribe(self, audio, language, on_progress, prompt=None):
            calls.append(len(audio))
            return super().transcribe(audio, language, on_progress, prompt)

    res = w.run_transcribe(job, w.Emitter(io.StringIO()), work, Engine, lambda: w.FakeDiarizer(speakers=2, every=3))
    assert len(calls) == 1  # one mixed track
    assert [s["speaker"] for s in res["segments"]] == ["Speaker 1", "Speaker 2"]


@needs_ffmpeg
def test_failed_diarization_leaves_speakers_empty(tmp_path, local_http):
    src = tone_file(tmp_path / "rec.wav", "lt(t,2)")
    job = {"step": "transcribe", "audioURL": serve(local_http, src), "settings": {}}
    work = tmp_path / "w"
    work.mkdir()

    def broken():
        raise w.WorkerError("The speaker models are missing")

    out = io.StringIO()
    res = w.run_transcribe(job, w.Emitter(out), work, w.FakeEngine, broken)
    assert [s["speaker"] for s in res["segments"]] == [""]
    assert "speaker separation skipped" in out.getvalue()


def test_label_speakers_by_overlap_and_first_appearance():
    segs = [w.Segment(0, 2, "a"), w.Segment(2, 4, "b"), w.Segment(4.5, 5, "c"), w.Segment(20, 21, "d")]
    turns = [w.Turn(0, 1.5, 7), w.Turn(1.5, 4.2, 3), w.Turn(5.5, 6, 7)]
    # a overlaps 7 most; b → 3; c has no overlap, nearest turn (0.3 s gap to 3) → 3; d is too far
    assert w.label_speakers(segs, turns) == ["Speaker 1", "Speaker 2", "Speaker 2", None]


# ---------------------------------------------------------------------------------------------------
# re-clustering (synthetic embeddings, no model)


def _voices(n_speakers: int = 3, dim: int = 192, seed: int = 1):
    """Well-separated L2-normalised voice directions and a sampler that adds noise with sigma 0.05."""
    import numpy as np

    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(rng.normal(size=(dim, n_speakers)))
    dirs = q.T

    def sample(speaker: int):
        v = dirs[speaker] + rng.normal(scale=0.05, size=dim)
        return v / np.linalg.norm(v)

    return sample


def _embed(turns, truth, sample):
    """The windows of `turns` and one synthetic embedding per window, from each turn's true speaker."""
    import numpy as np

    spans = w.window_spans(turns)
    return spans, np.array([sample(truth[i]) for i, _, _ in spans])


def _meeting(pattern, seconds: float = 20.0):
    """Back-to-back turns with the given true speakers; sherpa's own labels are deliberately wrong (99)."""
    turns = [w.Turn(i * seconds, (i + 1) * seconds, 99) for i in range(len(pattern))]
    return turns, list(pattern)


def test_window_spans_cover_turns():
    turns = [w.Turn(0, 3.0, 0), w.Turn(3.0, 3.3, 1), w.Turn(4, 5, 0)]
    spans = w.window_spans(turns)
    # 3 s turn: windows at 0, 0.75, 1.5; the 0.3 s turn has none; the 1 s turn gives one whole-turn window
    assert spans == [(0, 0.0, 1.5), (0, 0.75, 2.25), (0, 1.5, 3.0), (2, 4.0, 5.0)]


def test_estimate_speakers_finds_three():
    turns, truth = _meeting([0, 1, 2, 0, 1, 2, 2, 0, 1])
    _, X = _embed(turns, truth, _voices())
    assert w.estimate_speakers(X) == 3


def test_recluster_matches_the_true_speakers():
    turns, truth = _meeting([2, 0, 1, 0, 2, 1, 0])
    spans, X = _embed(turns, truth, _voices())
    out = w.recluster_turns(turns, spans, X)
    assert [t.speaker for t in out] == [0, 1, 2, 1, 0, 2, 1]
    assert [(t.start, t.end) for t in out] == [(t.start, t.end) for t in turns]


def test_recluster_merges_tiny_cluster():
    turns, truth = _meeting([0, 1, 0, 1, 0, 1])
    # speaker 2 talks 6 s in total: two 3 s turns, so its cluster merges into a real one
    turns[1:1] = [w.Turn(20, 23, 99)]
    truth[1:1] = [2]
    turns.append(w.Turn(200, 203, 99))
    truth.append(2)
    spans, X = _embed(turns, truth, _voices())
    out = w.recluster_turns(turns, spans, X)
    assert sorted({t.speaker for t in out}) == [0, 1]
    assert out[0].speaker == 0
    first_other = next(t.speaker for t, s in zip(out, truth) if s == 1)
    assert first_other == 1


def test_recluster_given_count():
    turns, truth = _meeting([0, 1, 2, 0, 1, 2])
    spans, X = _embed(turns, truth, _voices())
    out = w.recluster_turns(turns, spans, X, num_speakers=2)
    assert len({t.speaker for t in out}) == 2


def test_recluster_edge_cases():
    import numpy as np

    sample = _voices()
    assert w.recluster_turns([], [], np.zeros((0, 192))) == []
    # one turn
    turns = [w.Turn(0, 30, 5)]
    spans, X = _embed(turns, [0], sample)
    assert [t.speaker for t in w.recluster_turns(turns, spans, X)] == [0]
    # a single window
    turns = [w.Turn(0, 1.2, 4), w.Turn(2, 2.3, 9)]
    spans, X = _embed(turns, [0, 1], sample)
    assert len(X) == 1
    assert [t.speaker for t in w.recluster_turns(turns, spans, X)] == [0, 0]
    # only short turns: no windows at all
    turns = [w.Turn(0, 0.3, 1), w.Turn(1, 1.2, 2)]
    assert [t.speaker for t in w.recluster_turns(turns, [], np.zeros((0, 192)))] == [0, 0]
    # more speakers asked for than there are windows: clipped, no crash; min_talk=0 keeps every cluster
    turns = [w.Turn(0, 1, 0), w.Turn(1, 2, 0), w.Turn(2, 3, 0)]
    spans, X = _embed(turns, [0, 1, 2], sample)
    out = w.recluster_turns(turns, spans, X, num_speakers=8, min_talk=0)
    assert len(X) == 3 and sorted(t.speaker for t in out) == [0, 1, 2]
    # identical windows (silence-like): one speaker, no NaN
    X = np.zeros((40, 192))
    turns = [w.Turn(i, i + 1, 0) for i in range(40)]
    spans = w.window_spans(turns)
    assert {t.speaker for t in w.recluster_turns(turns, spans, X)} == {0}
    assert w.estimate_speakers(X) >= 1


def test_short_turn_takes_nearest_label():
    turns = [w.Turn(0, 20, 99), w.Turn(20, 40, 99), w.Turn(40.2, 40.5, 99), w.Turn(60, 80, 99), w.Turn(80, 100, 99)]
    # the 0.3 s turn is 0.2 s after the second turn (speaker 1) and 19.5 s before the fourth (speaker 0)
    truth = [0, 1, 0, 0, 1]
    spans, X = _embed(turns, truth, _voices())
    assert all(i != 2 for i, _, _ in spans)
    out = w.recluster_turns(turns, spans, X)
    assert out[2].speaker == out[1].speaker == 1


def test_large_n_subsamples():
    import time

    turns, truth = _meeting([0, 1, 2] * 30, seconds=30.0)
    spans, X = _embed(turns, truth, _voices())
    assert len(X) > 3000
    t0 = time.time()
    out = w.recluster_turns(turns, spans, X)
    assert time.time() - t0 < 30
    assert [t.speaker for t in out] == [0, 1, 2] * 30


def test_merge_tracks_orders_by_time():
    me = [w.Segment(0, 1, "m1", "Me"), w.Segment(5, 6, "m2", "Me")]
    others = [w.Segment(2, 3, "o1", "Others"), w.Segment(5, 5.5, "o2", "Others")]
    assert [s.text for s in w.merge_tracks([me, others])] == ["m1", "o1", "o2", "m2"]


def test_model_errors_are_readable():
    msg = w.describe_model_error("large-v3", RuntimeError("CUDA failed with error out of memory"))
    assert "GPU" in msg and "Retry" in msg
    msg = w.describe_model_error("large-v3", RuntimeError("Repository Not Found"))
    assert "quorumd meetings setup" in msg
    expect = "The Whisper model large-v3 is not downloaded on this machine; run `quorumd meetings setup`."
    assert w.describe_model_error("large-v3", RuntimeError("Cannot find an appropriate cached snapshot folder")) == expect
    assert w.describe_model_error("large-v3", RuntimeError("outgoing traffic has been disabled")) == expect
    LocalEntryNotFoundError = type("LocalEntryNotFoundError", (Exception,), {})
    assert w.describe_model_error("large-v3", LocalEntryNotFoundError("x")) == expect


# ---------------------------------------------------------------------------------------------------
# summarize_local: sections, prompt, merge, validation


def seg(minute: float, text: str, speaker: str = "Speaker 1") -> dict:
    ms = int(minute * 60000)
    return {"start_ms": ms, "end_ms": ms + 4000, "speaker": speaker, "text": text}


def test_split_sections_at_15_minutes():
    segs = [seg(0, "a"), seg(14.99, "b"), seg(15, "c"), seg(31, "d"), seg(46, "e")]
    secs = w.split_sections(segs)
    assert [[s["text"] for s in sec] for sec in secs] == [["a", "b"], ["c"], ["d"], ["e"]]


def test_repair_fills_missing_fields_and_drops_invented_owner():
    transcript = "[00:01] Ana: Carla will send the budget on Friday.\n[00:09] Speaker 2: I will check the venue."
    raw = {
        "title": "Budget",
        "decisions": [{"text": "Use the cheaper venue", "ts": "00:09"}, {"text": ""}, "Keep the date"],
        "actions": [
            {"text": "Send the budget", "owner": "Carla", "due": "Friday", "ts": "00:01"},
            {"text": "Book the venue", "owner": "Velka", "due": "next Monday", "ts": "99:00"},
            {"text": "Check the venue", "owner": "unassigned", "due": ""},
        ],
        "attendees": ["Ana", "Carla", "Speaker 2", "Velka"],
        "topics": "not a list",
    }
    out = w.repair_summary(raw, transcript, max_ms=10_000)
    assert set(out) == {"title", "summary", "topics", "decisions", "openPoints", "actions", "attendees"}
    assert out["summary"] == "" and out["topics"] == [] and out["openPoints"] == []
    assert out["decisions"] == [{"text": "Use the cheaper venue", "ts_ms": 9000}, {"text": "Keep the date"}]
    assert out["actions"][0] == {"text": "Send the budget", "owner": "Carla", "due": "Friday", "ts_ms": 1000}
    # an owner and a due date the transcript never mentions are not added; an out-of-range ts is dropped
    assert out["actions"][1] == {"text": "Book the venue", "owner": "", "due": ""}
    assert out["actions"][2]["owner"] == ""
    assert out["attendees"] == ["Ana", "Carla"]


def test_repair_of_garbage_is_an_empty_summary():
    out = w.repair_summary(["not", "an", "object"], "text")
    assert out == {"title": "", "summary": "", "topics": [], "decisions": [], "openPoints": [], "actions": [], "attendees": []}


def test_parse_ts():
    assert w.parse_ts("01:05") == 65000
    assert w.parse_ts("[1:02:03]") == 3723000
    assert w.parse_ts(1500) == 1500
    assert w.parse_ts("soon") is None and w.parse_ts(None) is None and w.parse_ts(True) is None


def test_summarize_long_transcript_per_section_then_merge():
    segs = [seg(1, "Ana: we choose plan B", "Ana"), seg(20, "Bruno takes the report", "Speaker 2"), seg(35, "open: the budget")]
    prompts = []
    answers = [
        {"title": "Part 1", "summary": "s1", "decisions": [{"text": "Plan B", "ts": "01:00"}], "attendees": ["Ana"]},
        {"summary": "s2", "actions": [{"text": "Write the report", "owner": "Bruno", "due": "", "ts": "20:00"}]},
        {"summary": "s3", "openPoints": [{"text": "Budget", "ts": "35:00"}]},
        {"title": "Weekly", "summary": "All of it", "decisions": [{"text": "Plan B", "ts": "01:00"}],
         "openPoints": [{"text": "Budget", "ts": "35:00"}],
         "actions": [{"text": "Write the report", "owner": "Bruno", "due": "", "ts": "20:00"},
                     {"text": "Invented task", "owner": "Orlo", "due": "2026-12-01"}],
         "attendees": ["Ana", "Bruno"]},
    ]

    def chat(messages):
        prompts.append(messages)
        return json.dumps(answers[len(prompts) - 1])

    job = {"settings": {"segments": segs, "language": "es", "speakerNames": {"Speaker 2": "Bruno"}, "glossary": ["Quorum"]}}
    out = io.StringIO()
    res = w.run_summarize(job, w.Emitter(out), chat)
    assert len(prompts) == 4  # three sections and the merge
    assert "part 1 of 3" in prompts[0][1]["content"] and "part 3 of 3" in prompts[2][1]["content"]
    assert "[20:00] Bruno: Bruno takes the report" in prompts[1][1]["content"]  # speaker names applied
    assert "Spanish" in prompts[0][0]["content"] and "Never invent owners" in prompts[0][0]["content"]
    assert "Quorum" in prompts[0][1]["content"]
    assert "PART 2" in prompts[3][1]["content"]
    assert res["title"] == "Weekly"
    assert res["decisions"] == [{"text": "Plan B", "ts_ms": 60000}]
    assert res["actions"][0] == {"text": "Write the report", "owner": "Bruno", "due": "", "ts_ms": 1200000}
    assert res["actions"][1]["owner"] == "" and res["actions"][1]["due"] == ""
    stages = [json.loads(l)["stage"] for l in out.getvalue().splitlines()]
    assert "merging" in stages


def test_summarize_short_transcript_has_no_merge():
    calls = []

    def chat(messages):
        calls.append(messages)
        return '{"title": "Short", "summary": "ok"}'

    res = w.run_summarize({"settings": {"segments": [seg(0, "hello"), seg(10, "bye")]}}, w.Emitter(io.StringIO()), chat)
    assert len(calls) == 1
    assert res["title"] == "Short" and res["actions"] == []


def test_unusable_merge_falls_back_to_the_sections():
    answers = iter(['{"summary": "first", "decisions": [{"text": "A"}]}', '{"summary": "second", "decisions": [{"text": "B"}]}', "not json"])
    res = w.run_summarize({"settings": {"segments": [seg(0, "x"), seg(16, "y")]}}, w.Emitter(io.StringIO()), lambda _m: next(answers))
    assert [d["text"] for d in res["decisions"]] == ["A", "B"]
    assert res["summary"] == "first\nsecond"


def test_summarize_fetches_the_transcript_from_the_hub(local_http):
    local_http.files["/t"] = json.dumps({"segments": [seg(0, "hola"), seg(5, "adios")]}).encode()
    sent = []

    def chat(messages):
        sent.append(messages)
        return '{"summary": "ok"}'

    res = w.run_summarize({"transcriptURL": local_http.base + "/t", "settings": {"language": "es"}}, w.Emitter(io.StringIO()), chat)
    assert res["summary"] == "ok"
    assert "[05:00] Speaker 1: adios" in sent[0][1]["content"]
    with pytest.raises(w.WorkerError, match="HTTP 404"):
        w.run_summarize({"transcriptURL": local_http.base + "/missing", "settings": {}}, w.Emitter(io.StringIO()), chat)
    local_http.files["/bad"] = b'{"segments": 3}'
    with pytest.raises(w.WorkerError, match="invalid transcript"):
        w.fetch_transcript(local_http.base + "/bad")
    with pytest.raises(w.WorkerError, match="too large"):
        w.fetch_transcript(local_http.base + "/t", limit=10)
    with pytest.raises(w.WorkerError, match="http"):
        w.fetch_transcript("file:///etc/passwd")


def test_prompts_come_from_the_shared_file():
    shared = json.loads((Path(w.__file__).parent / "prompts.json").read_text(encoding="utf-8"))
    msgs = w.section_prompt(["[00:00] x"], "Spanish", "", 1, 1)
    assert shared["schema"] in msgs[0]["content"]
    assert "Write every text in Spanish." in msgs[0]["content"]
    assert w.prompts()["_unknown"] == set(shared["unknownOwners"])


def test_invalid_section_answer_is_an_error():
    with pytest.raises(w.WorkerError, match="valid JSON"):
        w.run_summarize({"settings": {"segments": [seg(0, "x")]}}, w.Emitter(io.StringIO()), lambda _m: "no json at all")


def test_ollama_request_shape(local_http):
    local_http.replies.append({"message": {"content": '{"title": "T"}'}})
    c = w.OllamaClient(local_http.base, "gemma3:12b")
    assert c.chat([{"role": "user", "content": "hi"}]) == '{"title": "T"}'
    path, body = local_http.requests[0]
    assert path == "/api/chat"
    assert body["model"] == "gemma3:12b" and body["format"] == "json" and body["stream"] is False
    assert body["think"] is False
    assert body["options"] == {"num_ctx": 32768, "temperature": 0.2}


def test_ollama_missing_model_is_readable(local_http):
    local_http.replies.append({"_status": 404, "error": "model 'gemma3:12b' not found"})
    with pytest.raises(w.WorkerError, match="ollama pull gemma3:12b"):
        w.OllamaClient(local_http.base, "gemma3:12b").chat([])


def test_ollama_unreachable_is_readable():
    with pytest.raises(w.WorkerError, match="not reachable"):
        w.OllamaClient("http://127.0.0.1:9", "m", timeout=2).chat([])


# ---------------------------------------------------------------------------------------------------
# end to end through the program's stdin/stdout, with the fake engine


def run_worker(job: dict, tmp_path: Path) -> tuple[int, list[dict]]:
    work = tmp_path / "job-work"
    work.mkdir(exist_ok=True)
    job.setdefault("workDir", str(work))
    env = {"QUORUM_MEETINGS_FAKE": "1", "PATH": "/usr/bin:/bin:/usr/local/bin"}
    p = subprocess.run([sys.executable, str(WORKER)], input=json.dumps(job), capture_output=True, text=True,
                       env=env, cwd=tmp_path, timeout=120)
    return p.returncode, [json.loads(l) for l in p.stdout.splitlines() if l.strip()]


@needs_ffmpeg
def test_fake_engine_end_to_end(tmp_path, local_http):
    src = tone_file(tmp_path / "rec.ogg", "lt(t,1)+between(t,3,4)", "between(t,1.5,2.5)", seconds=5)
    job = {"jobId": "j1", "attempt": 1, "step": "transcribe", "audioURL": serve(local_http, src),
           "settings": {"channels": "me|others", "language": "es", "speakers": 0}}
    code, lines = run_worker(job, tmp_path)
    assert code == 0, lines
    kinds = [l["type"] for l in lines]
    assert kinds[-1] == "result" and "progress" in kinds
    stages = [l["stage"] for l in lines if l["type"] == "progress"]
    for st in ("downloading", "converting", "transcribing", "diarizing"):
        assert st in stages
    res = lines[-1]["result"]
    # one voice on the Others channel stays "Others"
    assert [s["speaker"] for s in res["segments"]] == ["Me", "Others", "Me"]
    assert all(set(s) == {"start_ms", "end_ms", "speaker", "text"} for s in res["segments"])


def test_worker_error_line_and_exit_status(tmp_path):
    code, lines = run_worker({"step": "transcribe", "audioURL": "http://127.0.0.1:9/none", "settings": {}}, tmp_path)
    assert code == 1
    assert lines[-1]["type"] == "error"
    assert "Could not download the recording" in lines[-1]["error"]


def test_unknown_step_is_an_error(tmp_path):
    code, lines = run_worker({"step": "dance"}, tmp_path)
    assert code == 1 and "Unknown step" in lines[-1]["error"]


def test_transcribe_needs_the_daemons_work_folder(tmp_path):
    code, lines = run_worker({"step": "transcribe", "audioURL": "http://127.0.0.1:9/x", "workDir": str(tmp_path / "missing")}, tmp_path)
    assert code == 1 and "work folder" in lines[-1]["error"]


def test_download_only_http_and_capped(tmp_path, local_http):
    with pytest.raises(w.WorkerError, match="http"):
        w.download("file:///etc/passwd", tmp_path / "x", lambda _f: None)
    local_http.files["/big"] = b"x" * 5000
    with pytest.raises(w.WorkerError, match="400 MB"):
        w.download(local_http.base + "/big", tmp_path / "x", lambda _f: None, limit=1000)


class _Redirect(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", self.server.target)
        self.end_headers()

    def log_message(self, *_):
        pass


def test_download_refuses_a_redirect_to_another_host(tmp_path, local_http):
    local_http.files["/audio"] = b"data"
    srv = HTTPServer(("127.0.0.1", 0), _Redirect)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        # 127.0.0.1:<other port> is another host for this rule
        srv.target = local_http.base + "/audio"
        with pytest.raises(w.WorkerError, match="another host"):
            w.download(f"http://127.0.0.1:{srv.server_address[1]}/a", tmp_path / "x", lambda _f: None)
    finally:
        srv.shutdown()


def test_ollama_url_is_loopback_unless_set_on_the_machine(monkeypatch):
    monkeypatch.delenv("QUORUM_OLLAMA_URL", raising=False)
    assert w.ollama_url({}) == "http://127.0.0.1:11434"
    assert w.ollama_url({"ollamaURL": "http://localhost:11500"}) == "http://localhost:11500"
    for bad in ("http://10.0.0.5:11434", "http://evil.example", "file:///tmp/x", "http://127.0.0.1.evil.example"):
        with pytest.raises(w.WorkerError, match="not on this machine"):
            w.ollama_url({"ollamaURL": bad})
    monkeypatch.setenv("QUORUM_OLLAMA_URL", "http://gpu-box:11434")
    assert w.ollama_url({"ollamaURL": "http://evil.example"}) == "http://gpu-box:11434"


def test_ffmpeg_only_opens_local_files(tmp_path, monkeypatch):
    calls = []

    class Done:
        returncode, stdout, stderr = 0, '{"streams": [{"channels": 2}], "format": {"duration": "3"}}', ""

    monkeypatch.setattr(w.subprocess, "run", lambda cmd, **_k: calls.append(cmd) or Done())
    w.probe(tmp_path / "a.ogg")
    w.convert(tmp_path / "a.ogg", tmp_path, True)
    w.convert(tmp_path / "a.ogg", tmp_path, False)
    assert len(calls) == 3
    for cmd in calls:
        i = cmd.index("-protocol_whitelist")
        assert cmd[i + 1] == "file,pipe"
    for cmd in calls[1:]:
        assert cmd.index("-protocol_whitelist") < cmd.index("-i")


def test_prompts_load_lazily_and_fail_readably(tmp_path, monkeypatch):
    monkeypatch.setattr(w, "_PROMPTS", None)
    monkeypatch.setattr(w, "HERE", tmp_path)  # no prompts.json there: only the summary needs it
    with pytest.raises(w.WorkerError, match="prompts.json is missing"):
        w.section_prompt(["x"], "Spanish", "", 1, 1)


def test_owner_stated_by_whole_words():
    r = w.repair_summary({"actions": [{"text": "a", "owner": "Ana"}, {"text": "b", "owner": "tade runol"}]},
                         "[00:00] mañana lo hace Tadé Rúñol")
    assert [a["owner"] for a in r["actions"]] == ["", "tade runol"]


# ---------------------------------------------------------------------------------------------------
# word-level speaker split


def _words(text: str, start: float = 0.0, step: float = 0.8):
    return [(start + i * step, start + (i + 1) * step - 0.1, " " + x) for i, x in enumerate(text.split())]


def test_split_at_speaker_change():
    ws = _words("hola cómo estás bien gracias", step=0.8)  # words at 0, .8, 1.6 | 2.4, 3.2
    seg = w.Segment(0.0, 3.9, "hola cómo estás bien gracias", words=ws)
    out = w.split_by_speaker([seg], [w.Turn(0, 2, 7), w.Turn(2, 4, 3)])
    assert [s.text for s in out] == ["hola cómo estás", "bien gracias"]
    assert [s.speaker for s in out] == ["Speaker 1", "Speaker 2"]
    assert (out[0].start, out[0].end) == (ws[0][0], ws[2][1])
    assert (out[1].start, out[1].end) == (ws[3][0], ws[4][1])


def test_zero_length_word():
    seg = w.Segment(0.0, 3.0, "a b c", words=[(0.0, 0.5, " a"), (2.5, 2.5, " b"), (2.6, 3.0, " c")])
    out = w.split_by_speaker([seg], [w.Turn(0, 2, 0), w.Turn(2, 4, 1)])
    assert [(s.text, s.speaker) for s in out] == [("a", "Speaker 1"), ("b c", "Speaker 2")]


def test_word_without_speaker_joins_previous():
    seg = w.Segment(0.0, 20.0, "a b c", words=[(0.0, 1.0, " a"), (10.0, 11.0, " b"), (19.0, 20.0, " c")])
    out = w.split_by_speaker([seg], [w.Turn(0, 2, 0)], max_gap=2.0)
    assert [(s.text, s.speaker) for s in out] == [("a b c", "Speaker 1")]


def test_segment_without_words_falls_back():
    segs = [w.Segment(0.0, 1.0, "uno"), w.Segment(5.0, 6.0, "dos"), w.Segment(50.0, 51.0, "lejos")]
    out = w.split_by_speaker(segs, [w.Turn(0, 2, 4), w.Turn(5, 7, 9)])
    assert [(s.text, s.speaker, s.start, s.end) for s in out] == [
        ("uno", "Speaker 1", 0.0, 1.0), ("dos", "Speaker 2", 5.0, 6.0), ("lejos", "", 50.0, 51.0)]


@needs_ffmpeg
def test_me_others_unchanged(tmp_path, local_http):
    # Me speaks 0–2 s; Others has two voices (2–2.5 s and 3.25–4 s) and the diarizer switches every second
    src = tone_file(tmp_path / "rec.wav", "lt(t,2)", "between(t,2,2.5)+between(t,3.25,4)")
    job = {"step": "transcribe", "audioURL": serve(local_http, src), "settings": {"channels": "me|others"}}
    work = tmp_path / "w"
    work.mkdir()
    res = w.run_transcribe(job, w.Emitter(io.StringIO()), work, w.FakeEngine, lambda: w.FakeDiarizer(speakers=2, every=1))
    speakers = [s["speaker"] for s in res["segments"]]
    assert speakers[0] == "Me" and speakers.count("Me") == 1
    assert set(speakers[1:]) == {"Speaker 1", "Speaker 2"}


def test_engine_reads_word_timestamps(monkeypatch):
    import types

    class StubModel:
        def __init__(self, *a, **k):
            pass

        def transcribe(self, audio, **kw):
            assert kw["word_timestamps"] is True
            words = [types.SimpleNamespace(start=0.0, end=0.4, word=" hi"), types.SimpleNamespace(start=0.4, end=0.9, word=" you")]
            return iter([types.SimpleNamespace(start=0.0, end=1.0, text=" hi you", words=words)]), types.SimpleNamespace(language="en")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=StubModel))
    segs, _ = w.FasterWhisperEngine("stub").transcribe([0.0] * 16000, "en", lambda p: None)
    assert segs[0].words == [(0.0, 0.4, " hi"), (0.4, 0.9, " you")]


def test_recluster_given_count_skips_the_tiny_cluster_merge():
    turns, truth = _meeting([0, 1, 0, 1, 0, 1])
    turns[1:1] = [w.Turn(20, 23, 99)]
    truth[1:1] = [2]
    turns.append(w.Turn(200, 203, 99))
    truth.append(2)
    spans, X = _embed(turns, truth, _voices())
    out = w.recluster_turns(turns, spans, X, num_speakers=3)
    assert sorted({t.speaker for t in out}) == [0, 1, 2]


def test_usable_spans_drops_empty_slices_at_the_end():
    n = 10 * w.SAMPLE_RATE
    spans = [(0, 0.0, 1.5), (1, 8.0, 9.5), (1, 9.99, 10.4), (2, 10.0, 11.0)]
    assert w.usable_spans(spans, n) == spans[:2]


def test_short_wrong_speaker_run_is_absorbed():
    ws = _words("uno dos tres cuatro cinco", step=0.8)  # dos at 0.8-1.6
    seg = w.Segment(0.0, 4.0, "uno dos tres cuatro cinco", words=ws)
    turns = [w.Turn(0, 0.8, 0), w.Turn(0.8, 1.6, 1), w.Turn(1.6, 4, 0)]
    out = w.split_by_speaker([seg], turns)
    assert [(s.text, s.speaker) for s in out] == [("uno dos tres cuatro cinco", "Speaker 1")]


def test_segment_whose_words_have_no_speaker_uses_the_segment_rule():
    seg = w.Segment(0.0, 10.0, "a b", words=[(0.0, 0.5, " a"), (9.5, 10.0, " b")])
    out = w.split_by_speaker([seg], [w.Turn(4, 6, 3)], max_gap=2.0)
    assert out[0].speaker == "Speaker 1" and out[0].text == "a b"
    seg = w.Segment(10.0, 12.0, "a b", words=[(10.0, 10.5, " a"), (11.5, 12.0, " b")])
    # words 3 s from the turn (none), segment 3 s too: stays unlabelled
    assert w.split_by_speaker([seg], [w.Turn(0, 5, 3)], max_gap=2.0)[0].speaker == ""
