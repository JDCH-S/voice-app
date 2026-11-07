"""End-to-end checks for the analysis pipeline. Plain script, no pytest needed:

    cd server && .venv/bin/python tests/test_pipeline.py [--no-server] [--no-separation]

1. generates the synthetic song (tests/make_test_song.py),
2. runs analysis.features.analyze directly in "mix" mode and in "separated" mode
   (using the rendered melody track as the "vocal"), checks against the ground
   truth and validates the SongAnalysis shape,
3. starts uvicorn on a free port and exercises the HTTP API (quick analysis;
   separation + stems when Demucs is installed, which takes a few minutes on CPU).
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVER_DIR)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

import make_test_song  # noqa: E402
from analysis import audio_io, coach, features, separate, words  # noqa: E402

OUT_DIR = os.path.join(SERVER_DIR, "tests", "out")
FAILURES: list[str] = []
# "add your Anthropic API key in Settings": the message the coach must give without a working key
NO_KEY_HINT = "Anthropic API key"


def check(cond: bool, msg: str) -> None:
    status = "ok  " if cond else "FAIL"
    print(f"  [{status}] {msg}")
    if not cond:
        FAILURES.append(msg)


# ----------------------------------------------------------------- schema

NOTE_TYPES = {
    "id": int, "start": (int, float), "end": (int, float), "midi": int, "cents": (int, float),
    "hzMedian": (int, float), "stabilityCents": (int, float), "slideIn": (dict, type(None)),
    "run": bool, "vibrato": (dict, type(None)), "loudnessDb": (int, float), "dynamic": str,
    "breathBefore": bool, "register": (str, type(None)), "lyric": (str, type(None)), "phrase": int,
}
PHRASE_TYPES = {"index": int, "start": (int, float), "end": (int, float), "noteIds": list, "text": str,
                "difficulty": int, "tags": list}
TOP_TYPES = {"version": int, "mode": str, "duration": (int, float), "key": (dict, type(None)),
             "tempoBpm": (int, float, type(None)), "melody": dict, "notes": list, "phrases": list,
             "breaths": list, "range": dict, "warnings": list}
TAGS = {"high-note", "low-note", "long-hold", "run", "wide-leap", "slide", "vibrato", "fast"}
DYNAMICS = {"pp", "p", "mp", "mf", "f", "ff"}


def validate_schema(a: dict, mode: str) -> None:
    check(set(a.keys()) == set(TOP_TYPES), f"top-level keys exactly {sorted(TOP_TYPES)}")
    for k, t in TOP_TYPES.items():
        check(isinstance(a.get(k), t), f"{k} has type {t}")
    check(a["version"] == 1 and a["mode"] == mode, "version 1 and mode matches")
    mel = a["melody"]
    check(set(mel) == {"t0", "hop", "hz", "rmsDb"}, "melody keys")
    check(len(mel["hz"]) == len(mel["rmsDb"]) > 0, "melody arrays same length")
    check(abs(mel["hop"] - 256 / 22050) < 1e-9 and mel["t0"] == 0, "melody hop/t0")
    check(all(isinstance(v, (int, float)) and v >= 0 for v in mel["hz"]), "hz are non-negative numbers")
    check(all(-100 <= v <= 0.5 for v in mel["rmsDb"]), "rmsDb within [-100, 0]")
    check(set(a["range"]) == {"lowMidi", "highMidi", "p05", "p95"}, "range keys")
    if a["key"] is not None:
        check(set(a["key"]) == {"tonic", "mode", "confidence"} and a["key"]["mode"] in ("major", "minor")
              and 0 <= a["key"]["confidence"] <= 1, "key shape")
    for i, n in enumerate(a["notes"]):
        if set(n) != set(NOTE_TYPES):
            check(False, f"note {i} keys: {sorted(set(n) ^ set(NOTE_TYPES))}")
            break
        bad = [k for k, t in NOTE_TYPES.items() if not isinstance(n[k], t)]
        if bad:
            check(False, f"note {i} field types: {bad}")
            break
    else:
        check(True, "all notes have exactly the RefNote keys with the right types")
    check(all(n["id"] == i for i, n in enumerate(a["notes"])), "note ids equal index")
    check(all(a["notes"][i]["start"] <= a["notes"][i + 1]["start"] for i in range(len(a["notes"]) - 1)),
          "notes sorted by start")
    check(all(n["end"] > n["start"] for n in a["notes"]), "note end > start")
    check(all(-50 <= n["cents"] <= 50 for n in a["notes"]), "cents within -50..50")
    check(all(n["dynamic"] in DYNAMICS for n in a["notes"]), "dynamic labels valid")
    check(all(n["loudnessDb"] <= 0 for n in a["notes"]) and any(n["loudnessDb"] == 0 for n in a["notes"]),
          "loudnessDb relative to loudest (max is 0)")
    check(all(n["lyric"] is None for n in a["notes"]), "lyric is null")
    if mode == "mix":
        check(all(n["register"] is None for n in a["notes"]), "register null in mix mode")
    else:
        check(all(n["register"] in ("chest", "head", "mixed", None) for n in a["notes"]), "register values")
    for p in a["phrases"]:
        if set(p) != set(PHRASE_TYPES) or any(not isinstance(p[k], t) for k, t in PHRASE_TYPES.items()):
            check(False, f"phrase {p.get('index')} shape")
            break
    else:
        check(True, "all phrases have exactly the Phrase keys with the right types")
    check(all(p["index"] == i for i, p in enumerate(a["phrases"])), "phrase index equals position")
    check(all(1 <= p["difficulty"] <= 5 for p in a["phrases"]), "difficulty 1..5")
    check(all(set(p["tags"]) <= TAGS for p in a["phrases"]), "phrase tags valid")
    check(all(p["text"] == "" for p in a["phrases"]), "phrase text empty")
    ids = [i for p in a["phrases"] for i in p["noteIds"]]
    check(sorted(ids) == list(range(len(a["notes"]))), "every note is in exactly one phrase")
    check(all(a["notes"][i]["phrase"] == p["index"] for p in a["phrases"] for i in p["noteIds"]),
          "note.phrase matches phrase.noteIds")
    check(all(p["end"] - p["start"] <= 12.2 for p in a["phrases"]), "phrases <= 12 s")
    check(all(isinstance(b, (int, float)) for b in a["breaths"]), "breaths are numbers")
    s = json.dumps(a, allow_nan=False)
    check(len(s) > 0, f"json.dumps succeeds ({len(s) / 1024:.0f} kB)")


# ----------------------------------------------------------------- truth comparison

def compare_with_truth(a: dict, truth: dict, mode: str) -> None:
    notes = a["notes"]
    matched = 0
    for tn in truth["notes"]:
        mid = (tn["start"] + tn["end"]) / 2
        hits = [n for n in notes if n["start"] <= mid <= n["end"]]
        if hits and abs(hits[0]["midi"] - tn["midi"]) <= 1:
            matched += 1
    frac = matched / len(truth["notes"])
    check(frac >= 0.8, f"{matched}/{len(truth['notes'])} generated notes found within +-1 semitone ({frac:.0%})")
    n_phr = len(a["phrases"])
    check(abs(n_phr - truth["phrases"]) <= 1, f"phrase count {n_phr} (expected {truth['phrases']} +-1)")
    slides = [n for n in notes if n["slideIn"]]
    vibs = [n for n in notes if n["vibrato"]]
    check(len(slides) >= 1, f"slideIn detected on {len(slides)} note(s): "
          + ", ".join(f"midi {n['midi']} from {n['slideIn']['fromMidi']} ({n['slideIn']['duration'] * 1000:.0f} ms)" for n in slides))
    check(len(vibs) >= 1, f"vibrato detected on {len(vibs)} note(s): "
          + ", ".join(f"midi {n['midi']} {n['vibrato']['rate']} Hz/{n['vibrato']['extentCents']} c" for n in vibs))
    truth_vib = [tn for tn in truth["notes"] if tn["vibrato"]]
    vib_hit = sum(1 for tn in truth_vib if any(n["vibrato"] and n["start"] <= (tn["start"] + tn["end"]) / 2 <= n["end"] for n in notes))
    check(vib_hit >= len(truth_vib) - 1, f"vibrato found on {vib_hit}/{len(truth_vib)} generated vibrato notes")
    slide_truth = [tn for tn in truth["notes"] if tn["slideFrom"] is not None]
    slide_hit = sum(1 for tn in slide_truth if any(n["slideIn"] and abs(n["start"] - tn["start"]) < 0.3 and n["midi"] == tn["midi"] for n in notes))
    check(slide_hit == len(slide_truth), f"slide found on the generated slide note ({slide_hit}/{len(slide_truth)})")
    run_notes = [n for n in notes if n["run"]]
    check(len(run_notes) >= 3, f"run flagged on {len(run_notes)} notes (generated run has 5)")
    check(len(a["breaths"]) >= 2, f"breath points: {len(a['breaths'])} at {a['breaths']}")
    key = a["key"]
    check(key is not None and key["tonic"] == "C" and key["mode"] == "major",
          f"key {key} (generated: C major)")
    check(a["tempoBpm"] is not None and abs(a["tempoBpm"] - truth["bpm"]) <= 3, f"tempo {a['tempoBpm']} (generated {truth['bpm']})")
    tm = [tn["midi"] for tn in truth["notes"]]
    check(abs(a["range"]["highMidi"] - max(tm)) <= 1.5, f"range.highMidi {a['range']['highMidi']} (generated max {max(tm)})")
    if mode == "separated":
        check(abs(a["range"]["lowMidi"] - min(tm)) <= 1.5, f"range.lowMidi {a['range']['lowMidi']} (generated min {min(tm)})")
    dyn = sorted({n["dynamic"] for n in notes})
    check(len(dyn) >= 2, f"dynamics vary across phrases: {dyn}")


def summary(a: dict) -> None:
    print(f"  key={a['key']} tempo={a['tempoBpm']} range={a['range']} notes={len(a['notes'])} "
          f"phrases={len(a['phrases'])} breaths={len(a['breaths'])}")
    for p in a["phrases"]:
        ns = [a["notes"][i] for i in p["noteIds"]]
        print(f"   phrase {p['index']} {p['start']:6.2f}-{p['end']:6.2f}s  {len(ns):2d} notes  "
              f"difficulty {p['difficulty']}  tags={p['tags']}  dynamics={sorted({n['dynamic'] for n in ns})}")
    for n in a["notes"]:
        extras = []
        if n["slideIn"]:
            extras.append(f"slide from {n['slideIn']['fromMidi']} ({n['slideIn']['duration'] * 1000:.0f} ms)")
        if n["vibrato"]:
            extras.append(f"vibrato {n['vibrato']['rate']} Hz / {n['vibrato']['extentCents']} c")
        if n["run"]:
            extras.append("run")
        if n["breathBefore"]:
            extras.append("breath before")
        if extras:
            print(f"   note {n['id']:2d} {n['start']:6.2f}s midi {n['midi']} {n['dynamic']:>2}: " + ", ".join(extras))


# ----------------------------------------------------------------- word timing / coach unit tests

def _monotonic(ws: list) -> bool:
    return all(ws[i]["t0"] <= ws[i + 1]["t0"] for i in range(len(ws) - 1)) and all(w["t1"] > w["t0"] for w in ws)


def validate_words(ws: list, label: str) -> None:
    ok = isinstance(ws, list) and all(
        set(w) >= {"t0", "t1", "text", "conf"} and isinstance(w["t0"], (int, float)) and isinstance(w["t1"], (int, float))
        and isinstance(w["text"], str) and w["text"] and isinstance(w["conf"], (int, float)) and 0 <= w["conf"] <= 1
        for w in ws)
    check(ok, f"{label}: WordTiming shape (t0, t1, text, conf 0..1) for {len(ws)} words")


def test_words_unit() -> None:
    print("== word alignment (pure Python)")
    rec = [  # what recognition gave on a real a cappella clip (first line misheard)
        {"t0": 3.7, "t1": 5.4, "text": "A", "conf": 0.5}, {"t0": 5.4, "t1": 6.2, "text": "little", "conf": 0.6},
        {"t0": 6.2, "t1": 7.0, "text": "vice,", "conf": 0.6},
        {"t0": 7.5, "t1": 8.7, "text": "A", "conf": 0.5}, {"t0": 8.7, "t1": 9.5, "text": "little", "conf": 0.6},
        {"t0": 9.5, "t1": 10.4, "text": "vice,", "conf": 0.6},
        {"t0": 11.0, "t1": 11.6, "text": "every", "conf": 0.9}, {"t0": 11.6, "t1": 12.4, "text": "morning", "conf": 0.95},
        {"t0": 12.4, "t1": 12.9, "text": "you", "conf": 0.9}, {"t0": 12.9, "t1": 13.6, "text": "greet", "conf": 0.9},
        {"t0": 13.6, "t1": 14.6, "text": "me", "conf": 0.9},
    ]
    toks = words.tokenize_lyrics("[00:03.70] Edelweiss, Edelweiss,\n[Chorus]\nevery morning you greet me")
    check(toks == ["Edelweiss,", "Edelweiss,", "every", "morning", "you", "greet", "me"], f"tokenizer drops LRC/section tags: {toks}")
    out = words.align_lyrics("Edelweiss, Edelweiss,\nevery morning you greet me", rec, span=(3.0, 15.0))
    validate_words(out, "align (misheard first line)")
    check([w["text"] for w in out] == toks, "aligned words keep the user's spelling and order")
    check(_monotonic(out), "aligned times are monotonic and t1 > t0")
    exact = out[2:]
    check(all(abs(w["t0"] - r["t0"]) < 1e-6 and w["conf"] == r["conf"] for w, r in zip(exact, rec[6:])),
          "matched words take the recognised timing and confidence")
    check(3.6 <= out[0]["t0"] < out[1]["t0"] <= 10.4 and out[1]["t1"] <= 10.41 and out[0]["conf"] == 0 and out[1]["conf"] == 0,
          f"two user words share the span of the six misheard ones: {out[0]} {out[1]}")

    out = words.align_lyrics("every mornin you greet me and more words after", rec, span=(3.0, 20.0))
    check(len(out) == 9 and _monotonic(out), "unmatched words after the last anchor are interpolated in order")
    check(out[1]["text"] == "mornin" and out[1]["t0"] == 11.6 and 0 < out[1]["conf"] < 0.95,
          f"a misspelt word paired one to one gets the timing with reduced confidence: {out[1]}")
    check(out[-1]["t1"] <= 20.0 + 1e-6 and out[5]["t0"] >= 14.6 - 1e-6, "tail words stay inside the span after the last anchor")

    out = words.align_lyrics("la la la la", [], span=(10.0, 12.0))
    check(len(out) == 4 and out[0]["t0"] == 10.0 and abs(out[-1]["t1"] - 12.0) < 1e-6 and all(w["conf"] == 0 for w in out),
          "no recognised words: lyrics spread evenly over the span")
    check(words.align_lyrics("", rec) == [] and words.align_lyrics("...", rec) == [], "empty lyrics give an empty list")

    print("== snapping word starts to note onsets")
    notes = [{"start": 1.0, "end": 1.9}, {"start": 2.0, "end": 2.4}, {"start": 2.5, "end": 3.4}, {"start": 9.0, "end": 9.8}]
    ws = [{"t0": 1.3, "t1": 1.8, "text": "a", "conf": 0.9}, {"t0": 2.05, "t1": 2.3, "text": "b", "conf": 0.9},
          {"t0": 2.35, "t1": 3.0, "text": "c", "conf": 0.9}, {"t0": 6.0, "t1": 6.4, "text": "far", "conf": 0.9}]
    sn = words.snap_to_notes(ws, notes)
    check([w["t0"] for w in sn] == [1.0, 2.0, 2.5, 6.0], f"starts snap to the nearest unused onset, far words untouched: {[w['t0'] for w in sn]}")
    check(sn[0]["t1"] == 1.9 and sn[2]["t1"] == 3.4 and _monotonic(sn), "ends snap to note ends; order kept")
    check(ws[0]["t0"] == 1.3, "snap_to_notes does not modify its input")
    check(words.snap_to_notes([], notes) == [] and words.snap_to_notes(ws, []) == ws, "snap with no words / no notes is a no-op")

    print("== coach helpers (no network)")
    ctx = {"profile": {"level": "beginner"}, "range": {"lowMidi": 48, "highMidi": 67},
           "attempts": [{"date": i, "songId": "s1", "phraseIndex": i % 3, "scores": {"overall": 60 + i},
                         "issues": [{"kind": "flat"}, {"kind": "flat"}, {"kind": "late"}], "frames": list(range(300))}
                        for i in range(45)],
           "songs": [{"id": "s1", "title": "Test", "phrases": 4}],
           "melody": {"hz": list(range(5000))}, "weekStart": 1762732800000}
    c = coach.compact_context(ctx)
    check(len(c["attempts"]) == 30 and c["attempts"][-1]["date"] == 44, "context keeps the last 30 attempts")
    check("frames" not in c["attempts"][0] and c["attempts"][0]["issues"] == {"flat": 2, "late": 1},
          "attempts are summarised (no frames, issue counts)")
    check("melody" not in c and len(json.dumps(c)) <= coach.MAX_CONTEXT_CHARS, f"signal arrays dropped, context {len(json.dumps(c))} chars")
    check(coach.compact_context("junk") == {} and coach.compact_context(None) == {}, "non-dict context becomes {}")
    msgs = coach._clean_messages([{"role": "assistant", "content": "hi"}, {"role": "user", "content": "a"},
                                  {"role": "user", "content": "b"}, {"role": "assistant", "content": "c"},
                                  {"role": "user", "content": " d "}])
    check(msgs == [{"role": "user", "content": "a\n\nb"}, {"role": "assistant", "content": "c"}, {"role": "user", "content": "d"}],
          f"messages cleaned: leading assistant dropped, same roles merged: {msgs}")
    try:
        coach._clean_messages([{"role": "assistant", "content": "x"}])
        check(False, "empty conversation rejected")
    except coach.CoachError as e:
        check(e.status_code == 400, "empty conversation rejected with 400")
    raw = {"summary": "Work on pitch.", "days": [
        {"day": "Mon", "focus": "pitch", "items": [
            {"kind": "exercise", "title": "Lip trills", "exerciseId": "lip-trills", "songId": None, "phraseIndex": None, "minutes": 20},
            {"kind": "exercise", "title": "Made up", "exerciseId": "not-an-exercise", "songId": None, "phraseIndex": None, "minutes": 20},
            {"kind": "phrase", "title": "Phrase 9", "exerciseId": None, "songId": "s1", "phraseIndex": 9, "minutes": 10}]},
        {"day": "Wed", "focus": "song", "items": [
            {"kind": "phrase", "title": "Phrase 2", "exerciseId": None, "songId": "s1", "phraseIndex": 2, "minutes": 5},
            {"kind": "song", "title": "Unknown song", "exerciseId": None, "songId": "nope", "phraseIndex": None, "minutes": 5}]},
        {"day": "Wed", "focus": "dup", "items": []}]}
    p = coach.normalise_plan(raw, c, 1762732800000)
    check([d["day"] for d in p["days"]] == ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] and p["source"] == "coach"
          and p["weekStart"] == 1762732800000, "plan has all 7 days in order, source coach")
    mon = p["days"][0]["items"]
    check(mon[1]["exerciseId"] is None and mon[2]["kind"] == "song" and mon[2]["phraseIndex"] is None,
          f"unknown exercise id nulled, out-of-range phrase becomes a song item: {mon[1:]}")
    check(sum(i["minutes"] for i in mon) <= 25, f"a 50-minute day is scaled down to <= 25 min: {sum(i['minutes'] for i in mon)}")
    wed = p["days"][2]["items"]
    check(wed[0]["kind"] == "phrase" and wed[0]["phraseIndex"] == 2 and wed[1]["kind"] == "rest" and wed[1]["minutes"] == 0,
          f"known phrase kept, unknown song becomes rest: {wed}")
    check(p["days"][1]["items"][0]["kind"] == "rest" and p["days"][2]["focus"] == "song", "missing days are rest days; duplicates ignored")
    try:
        coach.normalise_plan({"summary": "", "days": []}, c, 1)
        check(False, "invalid plan rejected")
    except coach.CoachError as e:
        check(e.status_code == 502, "invalid plan rejected with 502")
    st = coach.status(check=False)
    check({"available", "model", "keySource"} <= set(st) and st["keySource"] in ("env", "file", "none"), f"coach status shape: {st}")
    try:
        coach.save_key("not a key")
        check(False, "junk key rejected")
    except coach.CoachError as e:
        check(e.status_code == 400, "junk key rejected with 400")


# ----------------------------------------------------------------- HTTP smoke test

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method: str, url: str, data: bytes | None = None, headers: dict | None = None, timeout: float = 30):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def multipart(fields: dict, file_field: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = "----voicecoach" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\n"
             f"Content-Type: audio/wav\r\n\r\n").encode()
    body += content + f"\r\n--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def poll(base: str, job_id: str, until, timeout: float, label: str) -> dict:
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        st, _, body = http("GET", f"{base}/jobs/{job_id}")
        js = json.loads(body)
        if js != last:
            print(f"    {label}: status={js['status']} progress={js['progress']} message={js['message']!r}")
            last = js
        if until(js) or js["status"] == "failed":
            return js
        time.sleep(0.5)
    raise TimeoutError(f"{label} timed out")


def smoke_test(song_path: str, want_separation: bool) -> None:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    python = sys.executable
    env = dict(os.environ)
    env["VOICECOACH_SECRETS_DIR"] = os.path.join(OUT_DIR, "secrets")  # never touch the real key file
    proc = subprocess.Popen([python, "-m", "uvicorn", "main:app", "--port", str(port), "--host", "127.0.0.1"],
                            cwd=SERVER_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, env=env)
    try:
        for _ in range(100):
            try:
                st, _, body = http("GET", f"{base}/health", timeout=2)
                if st == 200:
                    break
            except Exception:
                time.sleep(0.3)
        else:
            raise RuntimeError("server did not start")
        health = json.loads(body)
        check(health.get("ok") is True and health.get("separation") in ("demucs", "unavailable")
              and health.get("device") in ("cpu", "cuda", "mps") and "version" in health, f"GET /health -> {health}")
        check(isinstance(health.get("whisper"), bool) and isinstance(health.get("coach"), bool),
              f"health reports whisper={health.get('whisper')} coach={health.get('coach')}")
        has_whisper = bool(health.get("whisper"))
        with open(song_path, "rb") as f:
            content = f.read()
        body, ctype = multipart({"separate": "false"}, "file", "Test Artist - Test Song.wav", content)
        st, _, resp = http("POST", f"{base}/analyze", body, {"Content-Type": ctype}, timeout=60)
        check(st == 200 and "jobId" in json.loads(resp), f"POST /analyze separate=false -> {st} {resp[:80]!r}")
        job_id = json.loads(resp)["jobId"]
        st, _, resp = http("GET", f"{base}/jobs/{job_id}/analysis/quick")
        check(st in (200, 404), "GET analysis/quick before ready answers 200 or 404")
        st, _, resp = http("GET", f"{base}/jobs/{job_id}/words")
        check(st in (404, 503), f"GET words before ready -> {st}")
        js = poll(base, job_id, lambda j: j["status"] == "done", 600, "quick job")
        check(js["status"] == "done" and js["quickReady"] and not js["finalReady"] and js["error"] is None,
              f"job finished: {js['status']} quickReady={js['quickReady']} finalReady={js['finalReady']}")
        check(isinstance(js.get("wordsReady"), bool) and isinstance(js.get("separationWeak"), bool),
              f"status has wordsReady={js.get('wordsReady')} separationWeak={js.get('separationWeak')} wordsError={js.get('wordsError')!r}")
        st, _, resp = http("GET", f"{base}/jobs/{job_id}/words")
        if has_whisper and js["wordsReady"]:
            wj = json.loads(resp)
            check(st == 200 and isinstance(wj.get("words"), list), f"GET words -> {st}, {len(wj.get('words', []))} words, language={wj.get('language')}")
            validate_words(wj["words"], "recognised words")
            check(_monotonic(wj["words"]) if wj["words"] else True, "recognised words sorted with t1 > t0")
            print("    (the synthetic song has no real words: only the shape and that recognition ran are checked;"
                  f" recognised: {' '.join(w['text'] for w in wj['words'])[:120]!r})")
            lyr = "Every morning you greet me\nSmall and white, clean and bright\nYou look happy to me"
            st, _, resp = http("POST", f"{base}/jobs/{job_id}/align", json.dumps({"lyrics": lyr}).encode(),
                               {"Content-Type": "application/json"})
            aj = json.loads(resp)
            check(st == 200 and isinstance(aj.get("words"), list) and len(aj["words"]) == 16 and aj.get("total") == 16,
                  f"POST align -> {st}: {len(aj.get('words', []))} words, matched {aj.get('matched')}")
            validate_words(aj["words"], "aligned words")
            check(_monotonic(aj["words"]) and all(0 <= w["t0"] <= 31 for w in aj["words"]),
                  "aligned words are in order and inside the song")
            check([w["text"] for w in aj["words"]][:4] == ["Every", "morning", "you", "greet"], "aligned words keep the user's text")
        elif has_whisper:
            check(st == 503 and json.loads(resp).get("detail"), f"GET words when recognition failed -> {st} {resp[:160]!r}")
            print(f"    (speech recognition did not run: {js.get('wordsError')!r})")
        else:
            check(st == 503 and "faster-whisper" in json.loads(resp).get("detail", ""), f"GET words without whisper -> 503: {resp[:120]!r}")
            st, _, resp = http("POST", f"{base}/jobs/{job_id}/align", json.dumps({"lyrics": "la la"}).encode(),
                               {"Content-Type": "application/json"})
            check(st == 503, f"POST align without whisper -> {st}")
        meta = js["meta"] or {}
        check(meta.get("title") == "Test Song" and meta.get("artist") == "Test Artist" and abs(meta.get("duration", 0) - 30) < 0.5,
              f"meta from filename: {meta}")
        st, hdr, resp = http("GET", f"{base}/jobs/{job_id}/analysis/quick")
        check(st == 200 and hdr.get("content-type", "").startswith("application/json"), "GET analysis/quick -> 200 json")
        a = json.loads(resp)
        check(a["mode"] == "mix" and len(a["notes"]) >= 20, f"quick analysis mode=mix notes={len(a['notes'])}")
        st, _, _ = http("GET", f"{base}/jobs/{job_id}/analysis/final")
        check(st == 404, "GET analysis/final without separation -> 404")
        st, _, _ = http("GET", f"{base}/jobs/{job_id}/stems/vocals")
        check(st == 404, "GET stems/vocals without separation -> 404")
        st, _, _ = http("DELETE", f"{base}/jobs/{job_id}")
        check(st == 200, "DELETE job -> 200")
        st, _, _ = http("GET", f"{base}/jobs/{job_id}")
        check(st == 404, "GET deleted job -> 404")

        # word timing can be switched off per job
        body, ctype = multipart({"separate": "false", "words": "false"}, "file", "song.wav", content)
        st, _, resp = http("POST", f"{base}/analyze", body, {"Content-Type": ctype}, timeout=60)
        job_id = json.loads(resp)["jobId"]
        js = poll(base, job_id, lambda j: j["status"] == "done", 180, "quick job (words=false)")
        check(js["status"] == "done" and js["wordsReady"] is False and js["wordsError"] == "not requested",
              f"words=false: wordsReady={js['wordsReady']} wordsError={js['wordsError']!r}")
        st, _, resp = http("GET", f"{base}/jobs/{job_id}/words")
        check(st == 404 if has_whisper else st == 503, f"GET words for a words=false job -> {st}")
        http("DELETE", f"{base}/jobs/{job_id}")

        # AI coach
        st, _, resp = http("GET", f"{base}/coach/status", timeout=40)
        cs = json.loads(resp)
        check(st == 200 and {"available", "model", "keySource"} <= set(cs) and isinstance(cs["available"], bool)
              and cs["keySource"] in ("env", "file", "none"), f"GET /coach/status -> {cs}")
        st, _, resp = http("POST", f"{base}/coach/key", json.dumps({"key": "nonsense key"}).encode(),
                           {"Content-Type": "application/json"})
        check(st == 400, f"POST /coach/key with junk -> {st}")
        if cs["keySource"] != "env":
            fake = "sk-ant-api03-" + "x" * 40
            st, _, resp = http("POST", f"{base}/coach/key", json.dumps({"key": fake}).encode(),
                               {"Content-Type": "application/json"}, timeout=40)
            ks = json.loads(resp)
            key_file = os.path.join(OUT_DIR, "secrets", "anthropic_key")
            mode = oct(os.stat(key_file).st_mode & 0o777) if os.path.exists(key_file) else None
            check(st == 200 and ks.get("keySource") == "file" and mode == "0o600",
                  f"POST /coach/key stores the key (mode {mode}) -> keySource={ks.get('keySource')} available={ks.get('available')}")
            check(ks.get("available") is False and ks.get("message"), f"a fake key is reported unusable: {ks.get('message')!r}")
            st, _, resp = http("POST", f"{base}/coach/key", json.dumps({"key": ""}).encode(),
                               {"Content-Type": "application/json"}, timeout=40)
            ks = json.loads(resp)
            check(st == 200 and ks.get("keySource") == "none" and not os.path.exists(key_file), "POST /coach/key with '' removes the saved key")
        coach_ctx = {"profile": {"level": "beginner", "goals": ["pitch"], "dailyGoalMinutes": 10},
                     "range": {"lowMidi": 48, "highMidi": 67, "voiceType": "baritone"},
                     "attempts": [{"date": 1, "songId": "s1", "phraseIndex": 1,
                                   "scores": {"pitch": 58, "timing": 72, "length": 80, "expression": 50, "overall": 64},
                                   "issues": [{"kind": "flat", "noteId": 3}, {"kind": "late", "noteId": 4}]}],
                     "songs": [{"id": "s1", "title": "Test Song", "phrases": 4}],
                     "exercises": ["breathing", "lip-trills", "pitch-match", "scales", "sirens", "sustain"],
                     "weekStart": 1762732800000}
        st, _, resp = http("POST", f"{base}/coach", json.dumps({"messages": [{"role": "user", "content": "Why do I go flat on high notes? Keep it short."}],
                                                            "context": coach_ctx}).encode(),
                           {"Content-Type": "application/json"}, timeout=180)
        cj = json.loads(resp) if resp else {}
        if st == 200:
            check(isinstance(cj.get("reply"), str) and len(cj["reply"]) > 20, f"POST /coach -> reply {cj.get('reply', '')[:160]!r}")
        else:
            check(st == 401 and NO_KEY_HINT in cj.get("detail", ""), f"POST /coach without a key -> {st} {cj.get('detail')!r}")
            print("    (no Anthropic key available here: the live coach call could not be verified)")
        st, _, resp = http("POST", f"{base}/coach/plan", json.dumps({"context": coach_ctx}).encode(),
                           {"Content-Type": "application/json"}, timeout=240)
        pj = json.loads(resp) if resp else {}
        if st == 200:
            days = pj.get("days") or []
            kinds = {"exercise", "song", "phrase", "rest", "range-test"}
            ok = (pj.get("source") == "coach" and pj.get("weekStart") == 1762732800000 and isinstance(pj.get("summary"), str)
                  and [d.get("day") for d in days] == ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                  and all(isinstance(d.get("focus"), str) and isinstance(d.get("items"), list) for d in days)
                  and all(i["kind"] in kinds and isinstance(i["title"], str) and isinstance(i["minutes"], int)
                          and (i["exerciseId"] is None or i["exerciseId"] in coach_ctx["exercises"])
                          and (i["songId"] is None or i["songId"] == "s1")
                          and (i["phraseIndex"] is None or 0 <= i["phraseIndex"] < 4)
                          for d in days for i in d["items"]))
            check(ok, f"POST /coach/plan -> WeeklyPlan validates: {pj.get('summary', '')[:120]!r}")
            check(all(sum(i["minutes"] for i in d["items"]) <= 25 for d in days)
                  and any(i["kind"] == "rest" for d in days for i in d["items"]), "plan respects <= 25 min/day and has a rest item")
        else:
            check(st == 401 and NO_KEY_HINT in pj.get("detail", ""), f"POST /coach/plan without a key -> {st} {pj.get('detail')!r}")
        st, _, resp = http("POST", f"{base}/coach", json.dumps({"messages": [], "context": {}}).encode(),
                           {"Content-Type": "application/json"})
        check(st == 400, f"POST /coach with no messages -> {st}")

        # identify / lyrics: either a real answer or a graceful 502 / found:false
        st, _, resp = http("POST", f"{base}/identify", json.dumps({"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}).encode(),
                           {"Content-Type": "application/json"}, timeout=30)
        check(st in (200, 502), f"POST /identify -> {st} {resp[:100]!r}")
        st, _, resp = http("POST", f"{base}/identify", json.dumps({"url": "not a url"}).encode(),
                           {"Content-Type": "application/json"})
        check(st == 200 and json.loads(resp)["source"] == "unknown", f"POST /identify (junk url) -> {st} {resp!r}")
        st, _, resp = http("POST", f"{base}/lyrics/search", json.dumps({"title": "Hello", "artist": "Adele", "duration": 295}).encode(),
                           {"Content-Type": "application/json"}, timeout=30)
        check(st in (200, 502), f"POST /lyrics/search -> {st} {resp[:100]!r}")
        if st == 200:
            js = json.loads(resp)
            check({"found", "synced", "plain", "title", "artist", "source"} <= set(js) and js["source"] == "lrclib",
                  "lyrics response shape")

        if want_separation and health.get("separation") == "demucs":
            print("  running separation job (CPU, this can take a few minutes)...")
            body, ctype = multipart({"separate": "true"}, "file", "song.wav", content)
            st, _, resp = http("POST", f"{base}/analyze", body, {"Content-Type": ctype}, timeout=60)
            job_id = json.loads(resp)["jobId"]
            js = poll(base, job_id, lambda j: j["quickReady"], 180, "sep job (quick)")
            check(js["quickReady"], "quick analysis ready while separation pending")
            js = poll(base, job_id, lambda j: j["status"] in ("done", "failed"), 1800, "sep job (final)")
            if js["status"] == "done":
                check(js["finalReady"], "finalReady after separation")
                st, hdr, resp = http("GET", f"{base}/jobs/{job_id}/analysis/final")
                a = json.loads(resp)
                # Demucs does not hear the synthetic sawtooth "voice" (its vocal stem is ~-60 dBFS):
                # the robustness guard must kick in so the song does not end up empty.
                check(js.get("separationWeak") is True, f"separationWeak flagged for the synthetic song: {js.get('separationWeak')}")
                if js.get("separationWeak"):
                    check(st == 200 and a["mode"] == "mix" and len(a["notes"]) >= 20
                          and any("very little voice" in w for w in a["warnings"]),
                          f"weak separation -> final analysis is the mix one: mode={a.get('mode')} notes={len(a.get('notes', []))} warnings={a.get('warnings')}")
                else:
                    check(st == 200 and a["mode"] == "separated", f"final analysis mode={a.get('mode')} notes={len(a.get('notes', []))}")
                check(js["wordsReady"] == (has_whisper and not js.get("wordsError")),
                      f"words published with the final result: wordsReady={js['wordsReady']} wordsError={js.get('wordsError')!r}")
                if js["wordsReady"]:
                    st, _, resp = http("GET", f"{base}/jobs/{job_id}/words")
                    check(st == 200, "GET words after separation -> 200")
                    validate_words(json.loads(resp)["words"], "words after separation")
                for kind in ("vocals", "instrumental"):
                    st, hdr, resp = http("GET", f"{base}/jobs/{job_id}/stems/{kind}", timeout=60)
                    ct = hdr.get("content-type", "")
                    check(st == 200 and ct in ("audio/mpeg", "audio/wav") and len(resp) > 10000,
                          f"GET stems/{kind} -> {st} {ct} {len(resp)} bytes")
            else:
                print(f"    separation failed: {js['error']}")
                check(js["quickReady"] and js["error"], "failed separation keeps quick analysis and reports an error")
                if "403" in (js["error"] or "") or "URLError" in (js["error"] or ""):
                    print("    (model download blocked by the network; separation could not be verified end to end)")
                else:
                    FAILURES.append(f"separation failed: {js['error']}")
            http("DELETE", f"{base}/jobs/{job_id}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ----------------------------------------------------------------- main

def main() -> int:
    run_server = "--no-server" not in sys.argv
    want_sep = "--no-separation" not in sys.argv
    print("== generating synthetic song")
    paths = make_test_song.build(OUT_DIR)
    truth = json.load(open(paths["truth"]))
    mix = audio_io.decode_mono(paths["song"])
    vocal = audio_io.decode_mono(paths["vocal"])
    check(abs(mix.size / 22050 - truth["duration"]) < 0.05, f"decoded {mix.size / 22050:.2f} s mono 22050 Hz")

    print("== mix mode (full mix, fallback)")
    t0 = time.time()
    a_mix = features.analyze(mix, 22050, "mix")
    print(f"  analysed in {time.time() - t0:.1f} s")
    validate_schema(a_mix, "mix")
    check(any("full mix" in w for w in a_mix["warnings"]), f"mix warning present: {a_mix['warnings']}")
    compare_with_truth(a_mix, truth, "mix")
    summary(a_mix)

    print("== separated mode (melody track as the vocal)")
    t0 = time.time()
    a_sep = features.analyze(vocal, 22050, "separated", y_mix_for_key=mix)
    print(f"  analysed in {time.time() - t0:.1f} s")
    validate_schema(a_sep, "separated")
    check(a_sep["warnings"] == [], "no warnings in separated mode")
    compare_with_truth(a_sep, truth, "separated")
    check(any(n["register"] is not None for n in a_sep["notes"]), "register estimated in separated mode")
    summary(a_sep)
    with open(os.path.join(OUT_DIR, "analysis_mix.json"), "w") as f:
        json.dump(a_mix, f)
    with open(os.path.join(OUT_DIR, "analysis_separated.json"), "w") as f:
        json.dump(a_sep, f)

    test_words_unit()

    print(f"== demucs available: {separate.is_available()} (device {separate.device()}); "
          f"whisper: {words.is_available()}; coach sdk: {coach.is_available()}")
    if run_server:
        print("== HTTP smoke test")
        smoke_test(paths["song"], want_sep)

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
