"""The shared summary cases (testdata/summary_cases.json): the hub's Go code (internal/hub/meetings_minutes.go)
checks the same file, so the worker and the hub apply the same prompts and repair rules.

QUORUM_UPDATE_CASES=1 rewrites the 'want' fields from this worker (then make the Go side pass)."""

import io
import json
import os
from pathlib import Path

import worker as w

CASES = Path(__file__).resolve().parent.parent / "testdata" / "summary_cases.json"
UPDATE = os.environ.get("QUORUM_UPDATE_CASES") == "1"


def _names(d):
    return {k: v for k, v in (d or {}).items() if isinstance(v, str) and v.strip()}


def compute(cases: dict) -> dict:
    out = json.loads(json.dumps(cases))
    out["parseTs"] = [[v, w.parse_ts(v)] for v, _ in cases["parseTs"]]
    out["parseAnswer"] = [[t, w.parse_json_answer(t)] for t, _ in cases["parseAnswer"]]
    for c in out["repair"]:
        c["want"] = w.repair_summary(c["raw"], c["transcript"], None if c["maxMs"] < 0 else c["maxMs"])
    for c in out["naiveMerge"]:
        c["want"] = w.naive_merge(c["parts"])
        c["wantMergePrompt"] = w.merge_prompt(c["parts"], w.language_name("es"), ["Quorum", "Ana"])
    for c in out["prompts"]:
        secs = w.split_sections(c["segments"], c["sectionMinutes"] * 60 * 1000)
        names = _names(c["speakerNames"])
        c["want"] = [w.section_prompt(w.render_lines(s, names), w.language_name(c["language"]), c["glossary"], i + 1, len(secs))
                     for i, s in enumerate(secs)]
    for c in out["runs"]:
        answers, sent = iter(c["answers"]), []

        def chat(msgs):
            sent.append(msgs)
            return next(answers)

        job = {"settings": {"segments": c["segments"], "language": c["language"], "speakerNames": c["speakerNames"],
                            "glossary": c["glossary"]}}
        try:
            c["want"] = w.run_summarize(job, w.Emitter(io.StringIO()), chat)
        except w.WorkerError:
            c["want"] = {"error": True}
        c["wantPrompts"] = sent
    return out


def test_shared_summary_cases():
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    got = compute(cases)
    if UPDATE:
        CASES.write_text(json.dumps(got, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        return
    assert got == cases, "worker.py no longer matches testdata/summary_cases.json; regenerate it (see the docstring)"
