"""Breath points and practice phrases (Phrase in docs/ANALYSIS_SCHEMA.md).

Rules (from the schema doc):
  * gaps >= 0.25 s between voiced regions, inside sung sections, are breath points
  * phrases split at gaps >= 0.25 s, always at gaps >= 0.6 s
  * a phrase is capped at 12 s by splitting at its largest internal gap
  * phrases shorter than 1.0 s or with < 2 notes are merged into a neighbour
    (never across a gap >= 0.6 s, which must always stay a boundary)
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

BREATH_GAP_S = 0.25
HARD_SPLIT_GAP_S = 0.6
BREATH_MAX_GAP_S = 4.0          # longer gaps are instrumental breaks, not breaths
MAX_PHRASE_S = 12.0
MIN_PHRASE_S = 1.0
MIN_PHRASE_NOTES = 2
PHRASE_PAD_S = 0.05

LONG_HOLD_S = 1.2
WIDE_LEAP_ST = 7
FAST_NOTES_PER_S = 5.0


def _gap(notes: List[Dict], i: int) -> float:
    """Gap between note i and note i+1."""
    return float(notes[i + 1]["start"] - notes[i]["end"])


def detect_breaths(notes: List[Dict]) -> List[float]:
    """Breath times (midpoint of each qualifying gap); also sets breathBefore on notes."""
    breaths: List[float] = []
    for n in notes:
        n["breathBefore"] = False
    for i in range(len(notes) - 1):
        g = _gap(notes, i)
        if BREATH_GAP_S <= g <= BREATH_MAX_GAP_S:
            breaths.append(round(float(notes[i]["end"] + g / 2.0), 3))
            notes[i + 1]["breathBefore"] = True
    return breaths


def _split_groups(notes: List[Dict]) -> List[List[int]]:
    groups: List[List[int]] = []
    cur = [0]
    for i in range(len(notes) - 1):
        if _gap(notes, i) >= BREATH_GAP_S:
            groups.append(cur)
            cur = []
        cur.append(i + 1)
    groups.append(cur)
    return groups


def _span(notes: List[Dict], g: List[int]) -> float:
    return float(notes[g[-1]]["end"] - notes[g[0]]["start"])


def _cap_long(notes: List[Dict], groups: List[List[int]], guard: bool) -> List[List[int]]:
    out: List[List[int]] = []
    stack = list(reversed(groups))
    while stack:
        g = stack.pop()
        if _span(notes, g) <= MAX_PHRASE_S or len(g) < 2:
            out.append(g)
            continue
        gaps = [(_gap(notes, g[k]), k) for k in range(len(g) - 1)]
        best_gap, k = max(gaps)
        if best_gap <= 0.0:
            # continuous voiced stretch: split at the note boundary nearest the middle
            mid = notes[g[0]]["start"] + _span(notes, g) / 2.0
            k = int(np.argmin([abs(notes[idx]["end"] - mid) for idx in g[:-1]]))
        left, right = g[: k + 1], g[k + 1:]
        if guard and (len(left) < MIN_PHRASE_NOTES or len(right) < MIN_PHRASE_NOTES
                      or _span(notes, left) < MIN_PHRASE_S or _span(notes, right) < MIN_PHRASE_S):
            out.append(g)
            continue
        stack.append(right)
        stack.append(left)
    return out


def _merge_short(notes: List[Dict], groups: List[List[int]]) -> List[List[int]]:
    groups = [list(g) for g in groups]
    while len(groups) > 1:
        cand = None
        for i, g in enumerate(groups):
            if len(g) < MIN_PHRASE_NOTES or _span(notes, g) < MIN_PHRASE_S:
                options = []
                if i > 0:
                    gp = _gap(notes, groups[i - 1][-1])
                    if gp < HARD_SPLIT_GAP_S:
                        options.append((gp, i - 1))
                if i < len(groups) - 1:
                    gn = _gap(notes, g[-1])
                    if gn < HARD_SPLIT_GAP_S:
                        options.append((gn, i + 1))
                if options:
                    cand = (i, min(options)[1])
                    break
        if cand is None:
            break
        i, j = cand
        if j < i:
            groups[j] = groups[j] + groups[i]
        else:
            groups[j] = groups[i] + groups[j]
        del groups[i]
    return groups


def _tags_and_difficulty(notes: List[Dict], g: List[int], song_range: Dict[str, float]) -> Tuple[List[str], int]:
    ns = [notes[i] for i in g]
    midis = np.array([n["midi"] for n in ns], dtype=np.float64)
    med = float(np.median(midis))
    p95, p05 = float(song_range["p95"]), float(song_range["p05"])
    low, high = float(song_range["lowMidi"]), float(song_range["highMidi"])
    top15 = high - 0.15 * max(high - low, 1e-6)
    tags: List[str] = []
    if np.any(midis >= p95) or np.any((midis >= med + 2) & (midis >= top15)):
        tags.append("high-note")
    if np.any(midis <= p05):
        tags.append("low-note")
    if any(n["end"] - n["start"] >= LONG_HOLD_S for n in ns):
        tags.append("long-hold")
    if any(n["run"] for n in ns):
        tags.append("run")
    if any(abs(midis[k + 1] - midis[k]) >= WIDE_LEAP_ST for k in range(len(midis) - 1)):
        tags.append("wide-leap")
    if any(n["slideIn"] for n in ns):
        tags.append("slide")
    if any(n["vibrato"] for n in ns):
        tags.append("vibrato")
    span = _span(notes, g)
    if span > 0 and len(ns) / span >= FAST_NOTES_PER_S and len(ns) >= 4:
        tags.append("fast")

    score = 1.0
    span_st = float(midis.max() - midis.min())
    score += min(1.5, span_st / 10.0)
    if "high-note" in tags:
        score += 0.75
    if med >= top15:
        score += 0.5
    if "run" in tags or "fast" in tags:
        score += 0.75
    if "wide-leap" in tags:
        score += 0.5
    if "slide" in tags:
        score += 0.5
    if "vibrato" in tags or "long-hold" in tags:
        score += 0.5
    if span > 8.0:
        score += 0.25
    return tags, int(max(1, min(5, round(score))))


def build_phrases(notes: List[Dict], duration: float, song_range: Dict[str, float]) -> Tuple[List[Dict], List[float]]:
    """Returns (phrases, breaths); sets note['phrase'] and note['breathBefore']."""
    if not notes:
        return [], []
    breaths = detect_breaths(notes)
    groups = _split_groups(notes)
    groups = _cap_long(notes, groups, guard=False)
    groups = _merge_short(notes, groups)
    groups = _cap_long(notes, groups, guard=True)
    groups.sort(key=lambda g: g[0])

    phrases: List[Dict] = []
    for idx, g in enumerate(groups):
        tags, diff = _tags_and_difficulty(notes, g, song_range)
        start = max(0.0, float(notes[g[0]]["start"]) - PHRASE_PAD_S)
        end = min(float(duration), float(notes[g[-1]]["end"]) + PHRASE_PAD_S)
        for i in g:
            notes[i]["phrase"] = idx
        phrases.append({
            "index": idx,
            "start": round(start, 3),
            "end": round(end, 3),
            "noteIds": [int(i) for i in g],
            "text": "",
            "difficulty": diff,
            "tags": tags,
        })
    return phrases, breaths
