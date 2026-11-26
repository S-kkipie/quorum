"""Tests of the worker's live mode (--live): WebM cluster index, Range fetches, context trimming, hold-back and
the resident loop. Fake engine, synthetic Opus audio made with ffmpeg, a Range-aware local HTTP server."""

import io
import json
import re
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

import worker as w

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
                                  reason="ffmpeg is not installed")

TONE_GAP_TONE = "(lt(t,2)+gte(t,8))*0.5*sin(2*PI*440*t)"


# ---------------------------------------------------------------------------------------------------
# fixtures


def opus_webm(path: Path, expr: str = TONE_GAP_TONE, seconds: int = 10) -> Path:
    """A WebM/Opus recording of the aevalsrc expression, with a cluster every 2 s."""
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc='{expr}':s=48000:d={seconds}", "-c:a", "libopus", "-b:a", "48k",
                    "-cluster_time_limit", "2000", "-f", "webm", str(path)], check=True)
    return path


UNKNOWN = bytes.fromhex("01FFFFFFFFFFFFFF")


def _element(data: bytes, pos: int) -> tuple[int, int, int]:
    """(id end, data start, data size) of the element at pos; size -1 when unknown."""
    width = 1
    while not data[pos] & (0x80 >> (width - 1)):
        width += 1
    id_end = pos + width
    first = data[id_end]
    n = 1
    while not first & (0x80 >> (n - 1)):
        n += 1
    value = first & (0xFF >> n)
    for b in data[id_end + 1:id_end + n]:
        value = (value << 8) | b
    if value == (1 << (7 * n)) - 1:
        value = -1
    return id_end, id_end + n, value


def as_live_stream(data: bytes) -> bytes:
    """The file as Chrome's MediaRecorder writes it: a Segment and Clusters of unknown size, no Cues."""
    idx = w.webm_index(data)
    seg = data.index(bytes.fromhex("18538067"))
    _, seg_data, _ = _element(data, seg)
    out = bytearray(data[:seg] + bytes.fromhex("18538067") + UNKNOWN + data[seg_data:idx.header_end])
    for off, _ in idx.clusters:
        id_end, start, size = _element(data, off)
        out += data[off:id_end] + UNKNOWN + data[start:start + size]
    return bytes(out)


class _RangeFiles(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.ranges.append(self.headers.get("Range"))
        body = self.server.files.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range") or "")
        if m and not self.server.ignore_range:
            a = int(m.group(1))
            b = int(m.group(2)) if m.group(2) else len(body) - 1
            part = body[a:b + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{a + len(part) - 1}/{len(body)}")
        else:
            part = body
            self.send_response(200)
        self.send_header("Content-Length", str(len(part)))
        self.end_headers()
        self.wfile.write(part)

    def log_message(self, *_):
        pass


@pytest.fixture
def range_http():
    srv = HTTPServer(("127.0.0.1", 0), _RangeFiles)
    srv.files, srv.ranges, srv.ignore_range = {}, [], False
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    srv.base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield srv
    srv.shutdown()


@pytest.fixture(scope="module")
def ffmpeg_file(tmp_path_factory) -> bytes:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is not installed")
    return opus_webm(tmp_path_factory.mktemp("live") / "a.webm").read_bytes()


@pytest.fixture(scope="module")
def live_file(ffmpeg_file) -> bytes:
    return as_live_stream(ffmpeg_file)


def chunk_job(base: str, work: Path, live_bytes: int, from_ms: int = 0, job_id: str = "job-1",
              meeting_id: str = "meet-1", model: str = "fake-model") -> str:
    return json.dumps({"jobId": job_id, "attempt": 1, "meetingId": meeting_id, "step": "transcribe_chunk",
                       "audioURL": base + "/audio", "workDir": str(work),
                       "settings": {"language": "es", "model": model, "prompt": "", "fromMs": from_ms,
                                    "contextMs": 2000, "liveBytes": live_bytes}})


class CountingFactory:
    def __init__(self):
        self.models, self.engines = [], []

    def __call__(self, model):
        self.models.append(model)
        e = ClosingEngine()
        self.engines.append(e)
        return e


class ClosingEngine(w.FakeEngine):
    closed = False

    def close(self):
        self.closed = True


def lines_of(out: io.StringIO) -> list[dict]:
    return [json.loads(x) for x in out.getvalue().splitlines() if x.strip()]


# ---------------------------------------------------------------------------------------------------
# WebM index


@needs_ffmpeg
def test_webm_index_ffmpeg_file(ffmpeg_file):
    idx = w.webm_index(ffmpeg_file)
    assert len(idx.clusters) >= 4
    tcs = [tc for _, tc in idx.clusters]
    assert tcs[0] == 0
    assert tcs == sorted(tcs) and len(set(tcs)) == len(tcs)
    assert idx.header_end == idx.clusters[0][0]
    assert idx.clusters[-1][0] < idx.end <= len(ffmpeg_file)


@needs_ffmpeg
def test_webm_index_unknown_size_clusters(ffmpeg_file, live_file):
    want = [tc for _, tc in w.webm_index(ffmpeg_file).clusters]
    idx = w.webm_index(live_file)
    assert [tc for _, tc in idx.clusters] == want
    assert idx.end == len(live_file)
    # a stream cut in the middle of a block ends at the last complete block
    cut = (idx.clusters[2][0] + idx.clusters[3][0]) // 2 + 3
    part = w.webm_index(live_file[:cut])
    assert part.end < cut
    assert part.end > part.clusters[-1][0]
    assert [tc for _, tc in part.clusters] == want[:len(part.clusters)]


def test_webm_index_rejects_other_data():
    with pytest.raises(w.WorkerError, match="not WebM audio"):
        w.webm_index(b"RIFF\x00\x00\x00\x00WAVEfmt ")
    with pytest.raises(w.WorkerError, match="not WebM audio"):
        w.webm_index(b"")


# ---------------------------------------------------------------------------------------------------
# chunk audio and keep_new


@needs_ffmpeg
def test_live_audio_absolute_times(live_file, tmp_path):
    mirror = tmp_path / "meet-1.webm"
    mirror.write_bytes(live_file)
    wav, start_ms, end_ms = w.live_audio(mirror, 7000, 2000, tmp_path)
    assert wav is not None and wav.exists()
    assert abs(start_ms - 5000) <= 2100
    tcs = [tc for _, tc in w.webm_index(live_file).clusters]
    gap = max(b - a for a, b in zip(tcs, tcs[1:]))
    chosen = max(tc for tc in tcs if tc <= 5000)
    assert 5000 - chosen <= gap
    assert abs(end_ms - 10000) <= 150
    segs, _ = w.FakeEngine().transcribe(w.load_wav(wav), "es", lambda _f: None)
    kept, through = w.keep_new(segs, start_ms, 7000, end_ms)
    assert len(kept) == 1
    assert abs(kept[0].start * 1000 - 8000) <= 150
    assert through == end_ms


@needs_ffmpeg
def test_live_audio_nothing_after_from(live_file, tmp_path):
    mirror = tmp_path / "meet-1.webm"
    mirror.write_bytes(live_file)
    wav, start_ms, end_ms = w.live_audio(mirror, 20000, 2000, tmp_path)
    assert wav is None


def test_keep_new_drops_context_words():
    seg = w.Segment(0.0, 1.6, "hola mundo", words=[(0.0, 0.5, " hola"), (1.2, 1.6, " mundo")])
    kept, through = w.keep_new([seg], 4000, 5000, 9000)
    assert len(kept) == 1
    assert kept[0].text == "mundo"
    assert kept[0].start == pytest.approx(5.2)
    assert kept[0].end == pytest.approx(5.6)
    assert kept[0].words == [(pytest.approx(5.2), pytest.approx(5.6), " mundo")]
    assert through == 9000
    # a segment made only of context words is dropped
    only = w.Segment(0.0, 0.5, "hola", words=[(0.0, 0.5, " hola")])
    assert w.keep_new([only], 4000, 5000, 9000) == ([], 9000)


def test_keep_new_holds_back_cut_segment():
    end_ms = 20000
    a = w.Segment(1.0, 3.0, "uno", words=[(1.0, 3.0, " uno")])
    b = w.Segment(5.0, (end_ms - 10000 - 300) / 1000, "dos", words=[(5.0, 9.7, " dos")])
    kept, through = w.keep_new([a, b], 10000, 10000, end_ms)
    assert [s.text for s in kept] == ["uno"]
    assert through == 15000
    # final: nothing is held
    kept, through = w.keep_new([a, b], 10000, 10000, end_ms, final=True)
    assert [s.text for s in kept] == ["uno", "dos"] and through == end_ms
    # a lone segment is not held
    kept, through = w.keep_new([b], 10000, 10000, end_ms)
    assert [s.text for s in kept] == ["dos"] and through == end_ms


# ---------------------------------------------------------------------------------------------------
# Range fetch


def test_fetch_range_appends_and_handles_200(range_http, tmp_path):
    body = bytes(range(256)) * 4
    range_http.files["/audio"] = body
    dest = tmp_path / "m.webm"
    dest.write_bytes(body[:100])
    w.fetch_range(range_http.base + "/audio", dest, 100, 300)
    assert dest.read_bytes() == body[:300]
    assert range_http.ranges[-1] == "bytes=100-299"
    range_http.ignore_range = True
    w.fetch_range(range_http.base + "/audio", dest, 300, 500)
    assert dest.read_bytes() == body[:500]


def test_fetch_range_refuses_other_schemes(tmp_path):
    with pytest.raises(w.WorkerError):
        w.fetch_range("file:///etc/passwd", tmp_path / "x", 0, 10)


# ---------------------------------------------------------------------------------------------------
# resident loop


@needs_ffmpeg
def test_run_live_reuses_engine_and_fetches_only_new_bytes(range_http, live_file, tmp_path):
    range_http.files["/audio"] = live_file
    idx = w.webm_index(live_file)
    first = idx.clusters[2][0] + 200
    jobs = [chunk_job(range_http.base, tmp_path, first, 0, "job-1"),
            chunk_job(range_http.base, tmp_path, len(live_file), 3000, "job-2")]
    out = io.StringIO()
    factory = CountingFactory()
    assert w.run_live(iter(j + "\n" for j in jobs), out, factory) == 0
    assert factory.models == ["fake-model"]
    assert range_http.ranges == [f"bytes=0-{first - 1}", f"bytes={first}-{len(live_file) - 1}"]
    assert (tmp_path / "meet-1.webm").read_bytes() == live_file
    results = [x for x in lines_of(out) if x["type"] == "result"]
    assert [r["jobId"] for r in results] == ["job-1", "job-2"]
    assert all(r["attempt"] == 1 for r in results)
    for r in results:
        res = r["result"]
        assert set(res) == {"segments", "through_ms", "language"}
        for s in res["segments"]:
            assert set(s) == {"start_ms", "end_ms", "speaker", "text"}
    second = results[1]["result"]
    assert [round(s["start_ms"] / 1000) for s in second["segments"]] == [8]
    assert abs(second["through_ms"] - 10000) <= 150
    assert factory.engines[0].closed
    assert not [x for x in lines_of(out) if x["type"] == "error"]


@needs_ffmpeg
def test_run_live_error_is_tagged_and_loop_continues(range_http, live_file, tmp_path):
    range_http.files["/audio"] = live_file
    jobs = [chunk_job(range_http.base, tmp_path, len(live_file), 0, "job-bad", meeting_id="../escape"),
            chunk_job(range_http.base, tmp_path, len(live_file), 0, "job-good")]
    out = io.StringIO()
    assert w.run_live(iter(jobs), out, CountingFactory()) == 0
    got = [(x["type"], x.get("jobId")) for x in lines_of(out) if x["type"] in ("error", "result")]
    assert got == [("error", "job-bad"), ("result", "job-good")]


def test_run_live_switches_engine_when_model_changes(range_http, tmp_path):
    jobs = [chunk_job(range_http.base, tmp_path, 0, 0, "a", model="m1"),
            chunk_job(range_http.base, tmp_path, 0, 0, "b", model="m1"),
            chunk_job(range_http.base, tmp_path, 0, 0, "c", model="m2")]
    factory = CountingFactory()
    w.run_live(iter(jobs), io.StringIO(), factory)
    assert factory.models == ["m1", "m2"]
    assert factory.engines[0].closed and factory.engines[1].closed


def test_warmup_job_loads_engine_only(range_http, tmp_path):
    out = io.StringIO()
    factory = CountingFactory()
    w.run_live(iter([chunk_job(range_http.base, tmp_path, 0, 4200, "warm")]), out, factory)
    assert len(factory.models) == 1
    assert range_http.ranges == []
    res = [x for x in lines_of(out) if x["type"] == "result"]
    assert len(res) == 1 and res[0]["jobId"] == "warm"
    assert res[0]["result"]["segments"] == [] and res[0]["result"]["through_ms"] == 4200


def test_run_live_bad_json_line_is_an_error(tmp_path):
    out = io.StringIO()
    assert w.run_live(iter(["not json\n", "\n"]), out, CountingFactory()) == 0
    assert [x["type"] for x in lines_of(out)] == ["error"]


def test_emitter_tags_every_line():
    out = io.StringIO()
    e = w.Emitter(out, tags={"jobId": "j", "attempt": 2})
    e.log("x")
    e.progress(5, "s")
    e.result({})
    e.error("y")
    for x in lines_of(out):
        assert x["jobId"] == "j" and x["attempt"] == 2


@needs_ffmpeg
def test_main_live_uses_fake_engine(range_http, live_file, tmp_path):
    range_http.files["/audio"] = live_file
    job = chunk_job(range_http.base, tmp_path, len(live_file), 7000, "job-main")
    p = subprocess.run([w.sys.executable, str(Path(w.__file__)), "--live"], input=job + "\n",
                       capture_output=True, text=True, env={**__import__("os").environ, "QUORUM_MEETINGS_FAKE": "1"},
                       timeout=60)
    assert p.returncode == 0, p.stderr
    res = [json.loads(x) for x in p.stdout.splitlines() if x.strip()]
    res = [x for x in res if x["type"] == "result"]
    assert res and res[0]["jobId"] == "job-main"
    assert [round(s["start_ms"] / 1000) for s in res[0]["result"]["segments"]] == [8]
