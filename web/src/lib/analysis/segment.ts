import type { Dynamic, MelodyTrack, Phrase, PhraseTag, RefNote, SongAnalysis, KeyInfo } from '../types';
import { hzToMidi, median, mean, std, percentile, NOTE_NAMES } from '../music/notes';

/** Build a SongAnalysis from a frame-wise melody (used by the browser fallback and exercises). */
export function buildAnalysis(melody: MelodyTrack, duration: number, mode: SongAnalysis['mode'], warnings: string[] = []): SongAnalysis {
  const hop = melody.hop;
  const hz = cleanMelody(melody.hz, hop);
  const midiF = hz.map((h) => (h > 0 ? hzToMidi(h) : NaN));
  let notes = segmentNotes(midiF, melody.rmsDb, melody.t0, hop);
  annotateNotes(notes, midiF, melody.rmsDb, melody.t0, hop);
  if (mode === 'mix') {
    // prune quiet, very low notes between phrases: almost always bass or chord pickup
    const loud = notes.filter((n) => n.loudnessDb >= -12);
    if (loud.length >= 4) {
      const p10 = percentile(loud.map((n) => n.midi), 10);
      const keep = notes.filter((n) => !(n.loudnessDb < -12 && n.midi < p10 - 12));
      if (keep.length !== notes.length) {
        for (const n of notes) {
          if (keep.includes(n)) continue;
          const a = Math.max(0, Math.floor((n.start - melody.t0) / hop));
          const b = Math.min(hz.length, Math.ceil((n.end - melody.t0) / hop));
          for (let k = a; k < b; k++) {
            hz[k] = 0;
            midiF[k] = NaN;
          }
        }
        notes = keep.map((n, i) => ({ ...n, id: i }));
      }
    }
  }
  const { phrases, breaths } = buildPhrases(notes, duration);
  notes.forEach((n) => {
    const prev = notes[n.id - 1];
    n.breathBefore = prev ? n.start - prev.end >= 0.25 : n.start > 0.3;
  });
  const voiced = midiF.filter((m) => !isNaN(m));
  const range = {
    lowMidi: voiced.length ? percentile(voiced, 2) : 48,
    highMidi: voiced.length ? percentile(voiced, 98) : 72,
    p05: voiced.length ? percentile(voiced, 5) : 48,
    p95: voiced.length ? percentile(voiced, 95) : 72,
  };
  return {
    version: 1,
    mode,
    duration,
    key: estimateKeyFromNotes(notes),
    tempoBpm: null,
    melody: { t0: melody.t0, hop, hz: Array.from(hz), rmsDb: Array.from(melody.rmsDb) },
    notes,
    phrases,
    breaths,
    range,
    warnings,
  };
}

/** Median filter, drop short voiced islands, fold short octave glitches. */
export function cleanMelody(hzIn: ArrayLike<number>, hop: number): number[] {
  const n = hzIn.length;
  const hz = new Array<number>(n);
  for (let i = 0; i < n; i++) hz[i] = hzIn[i] || 0;
  // median of 5 within voiced neighbourhoods
  const out = hz.slice();
  for (let i = 2; i < n - 2; i++) {
    if (hz[i] <= 0) continue;
    const win = [hz[i - 2], hz[i - 1], hz[i], hz[i + 1], hz[i + 2]].filter((v) => v > 0);
    out[i] = median(win);
  }
  // bridge unvoiced holes of up to 3 frames when the pitch on both sides agrees
  for (let i = 1; i < n - 1; i++) {
    if (out[i] > 0 || out[i - 1] <= 0) continue;
    let j = i;
    while (j < n && out[j] <= 0 && j - i < 3) j++;
    if (j < n && out[j] > 0 && j - i <= 3 && Math.abs(1200 * Math.log2(out[j] / out[i - 1])) < 60) {
      for (let k = i; k < j; k++) out[k] = out[i - 1] + ((out[j] - out[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  // remove islands shorter than 4 frames (~45 ms)
  const minFrames = Math.max(3, Math.round(0.045 / hop));
  let i = 0;
  while (i < n) {
    if (out[i] > 0) {
      let j = i;
      while (j < n && out[j] > 0) j++;
      if (j - i < minFrames) for (let k = i; k < j; k++) out[k] = 0;
      i = j;
    } else i++;
  }
  // fold octave glitches: runs < 150 ms that sit an octave away from both neighbours
  const maxGlitch = Math.round(0.15 / hop);
  i = 0;
  while (i < n) {
    if (out[i] > 0) {
      let j = i;
      while (j < n && out[j] > 0 && Math.abs(1200 * Math.log2(out[j] / out[i])) < 150) j++;
      const len = j - i;
      const prev = i > 0 ? out[i - 1] : 0;
      const next = j < n ? out[j] : 0;
      if (len < maxGlitch && prev > 0 && next > 0) {
        const r1 = 1200 * Math.log2(out[i] / prev);
        const r2 = 1200 * Math.log2(out[i] / next);
        if (Math.abs(Math.abs(r1) - 1200) < 80 && Math.abs(Math.abs(r2) - 1200) < 80) {
          const f = r1 > 0 ? 0.5 : 2;
          for (let k = i; k < j; k++) out[k] *= f;
        }
      }
      i = Math.max(j, i + 1);
    } else i++;
  }
  return out;
}

function baseNote(id: number, start: number, end: number): RefNote {
  return {
    id,
    start,
    end,
    midi: 60,
    cents: 0,
    hzMedian: 261.6,
    stabilityCents: 0,
    slideIn: null,
    run: false,
    vibrato: null,
    loudnessDb: 0,
    dynamic: 'mf',
    breathBefore: false,
    register: null,
    lyric: null,
    phrase: 0,
  };
}

interface Seg {
  a: number; // first frame
  b: number; // last frame (exclusive)
  runStart: number; // start frame of the voiced run containing it
}

export function segmentNotes(midiF: number[], _rmsDb: ArrayLike<number>, t0: number, hop: number): RefNote[] {
  const n = midiF.length;
  const segs: Seg[] = [];
  const minChangeFrames = 3;
  const minNoteFrames = Math.max(2, Math.round(0.06 / hop));
  let i = 0;
  while (i < n) {
    if (isNaN(midiF[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !isNaN(midiF[j])) j++;
    // voiced run [i, j)
    let segStart = i;
    let ref = midiF[i];
    let k = i + 1;
    while (k < j) {
      // reference pitch of the current segment = running median of the last ~8 frames
      const lo = Math.max(segStart, k - 8);
      const vals = midiF.slice(lo, k);
      ref = median(vals);
      if (Math.abs(midiF[k] - ref) > 0.5) {
        // sustained change?
        let m = k;
        while (m < j && m - k < minChangeFrames && Math.abs(midiF[m] - ref) > 0.5) m++;
        if (m - k >= minChangeFrames || m === j) {
          segs.push({ a: segStart, b: k, runStart: i });
          segStart = k;
          k = k + 1;
          continue;
        }
      }
      k++;
    }
    segs.push({ a: segStart, b: j, runStart: i });
    i = j;
  }
  // merge tiny segments into the nearest neighbour inside the same run
  let merged = true;
  while (merged) {
    merged = false;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      if (seg.b - seg.a >= minNoteFrames) continue;
      const prev = segs[s - 1];
      const next = segs[s + 1];
      const canPrev = prev && prev.runStart === seg.runStart;
      const canNext = next && next.runStart === seg.runStart;
      if (!canPrev && !canNext) {
        segs.splice(s, 1);
        merged = true;
        break;
      }
      const mSeg = median(midiF.slice(seg.a, seg.b));
      const dPrev = canPrev ? Math.abs(median(midiF.slice(prev.a, prev.b)) - mSeg) : Infinity;
      const dNext = canNext ? Math.abs(median(midiF.slice(next.a, next.b)) - mSeg) : Infinity;
      if (dPrev <= dNext) {
        prev.b = seg.b;
        segs.splice(s, 1);
      } else {
        next.a = seg.a;
        segs.splice(s, 1);
      }
      merged = true;
      break;
    }
  }
  // absorb short transition segments (pitch strictly between both neighbours, same voiced run)
  // into the following note: they are the glide into it, not a note of their own
  // A transition is short, sits between its neighbours in pitch, and is itself moving
  // (a note in a fast run is a flat plateau and must survive).
  const maxTransFrames = Math.round(0.1 / hop);
  for (let s = segs.length - 2; s >= 1; s--) {
    const seg = segs[s];
    const prev = segs[s - 1];
    const next = segs[s + 1];
    if (seg.b - seg.a > maxTransFrames) continue;
    if (prev.runStart !== seg.runStart || next.runStart !== seg.runStart) continue;
    const mp = median(midiF.slice(prev.a, prev.b));
    const ms = median(midiF.slice(seg.a, seg.b));
    const mn = median(midiF.slice(next.a, next.b));
    const between = (ms > mp && ms < mn) || (ms < mp && ms > mn);
    const k = Math.min(3, Math.floor((seg.b - seg.a) / 2));
    const head = median(midiF.slice(seg.a, seg.a + Math.max(1, k)));
    const tail = median(midiF.slice(seg.b - Math.max(1, k), seg.b));
    const moving = Math.abs(tail - head) >= 0.5 && Math.sign(tail - head) === Math.sign(mn - mp);
    if (between && moving) {
      next.a = seg.a;
      segs.splice(s, 1);
    }
  }
  return segs.map((s, idx) => {
    const note = baseNote(idx, t0 + s.a * hop, t0 + s.b * hop);
    (note as RefNote & { _a: number; _b: number; _run: number })._a = s.a;
    (note as RefNote & { _a: number; _b: number; _run: number })._b = s.b;
    (note as RefNote & { _a: number; _b: number; _run: number })._run = s.runStart;
    return note;
  });
}

export function annotateNotes(notes: RefNote[], midiF: number[], rmsDb: ArrayLike<number>, _t0: number, hop: number) {
  type N = RefNote & { _a: number; _b: number; _run: number };
  const ns = notes as N[];
  let maxLoud = -Infinity;
  for (let idx = 0; idx < ns.length; idx++) {
    const n = ns[idx];
    const frames = midiF.slice(n._a, n._b);
    const len = frames.length;
    const trim = Math.floor(len * 0.15);
    const core = len > 6 ? frames.slice(trim, len - trim) : frames;
    const med = median(core);
    n.midi = Math.round(med);
    n.cents = Math.max(-50, Math.min(50, (med - n.midi) * 100));
    n.hzMedian = 440 * Math.pow(2, (med - 69) / 12);
    // stability after removing linear trend
    const cents = core.map((m) => (m - med) * 100);
    n.stabilityCents = std(detrend(cents));
    // loudness
    const db: number[] = [];
    for (let k = n._a; k < n._b; k++) db.push(rmsDb[k]);
    n.loudnessDb = db.length ? mean(db) : -60;
    if (n.loudnessDb > maxLoud) maxLoud = n.loudnessDb;
    // vibrato on notes >= 0.35 s
    n.vibrato = null;
    if (len * hop >= 0.35) {
      const v = detectVibrato(detrend(cents), hop);
      if (v) n.vibrato = v;
    }
    // slide-in: look at the frames between the previous note's core and this one's core, same voiced run
    n.slideIn = null;
    const prev = ns[idx - 1];
    if (prev && prev._run === n._run) {
      const glideA = Math.max(prev._a, prev._b - Math.round(0.12 / hop));
      const glideB = Math.min(n._b, n._a + Math.round(0.25 / hop));
      const g = midiF.slice(glideA, glideB);
      const span = Math.abs(prev.midi + prev.cents / 100 - med);
      const dur = countTransitionFrames(g, prev.midi, n.midi) * hop;
      if (span >= 1.5 && dur >= 0.06) n.slideIn = { fromMidi: prev.midi, duration: Math.round(dur * 1000) / 1000 };
    } else {
      // scoop from below at the very start of a run
      const head = midiF.slice(n._a, Math.min(n._b, n._a + Math.round(0.15 / hop)));
      if (head.length >= 4) {
        const first = median(head.slice(0, 2));
        if (med - first >= 1.5) n.slideIn = { fromMidi: Math.round(first), duration: Math.round(head.length * hop * 1000) / 1000 };
      }
    }
  }
  // relative loudness and dynamics
  for (const n of ns) {
    n.loudnessDb = Math.round((n.loudnessDb - maxLoud) * 10) / 10;
    n.dynamic = dynamicFor(n.loudnessDb);
  }
  // runs
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j < ns.length && ns[j].end - ns[j].start < 0.18 && ns[j]._run === ns[i]._run) j++;
    if (j - i >= 3) {
      let stepwise = 0;
      for (let k = i + 1; k < j; k++) if (Math.abs(ns[k].midi - ns[k - 1].midi) <= 2) stepwise++;
      if (stepwise >= (j - i - 1) * 0.6) for (let k = i; k < j; k++) ns[k].run = true;
      i = j - 1;
    }
  }
  for (const n of ns) {
    delete (n as Partial<N>)._a;
    delete (n as Partial<N>)._b;
    delete (n as Partial<N>)._run;
  }
}

function countTransitionFrames(g: number[], fromMidi: number, toMidi: number): number {
  const lo = Math.min(fromMidi, toMidi) + 0.3;
  const hi = Math.max(fromMidi, toMidi) - 0.3;
  let c = 0;
  for (const m of g) if (m > lo && m < hi) c++;
  return c;
}

function detrend(x: number[]): number[] {
  const n = x.length;
  if (n < 3) return x.map(() => 0);
  const xs = x.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(x);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (x[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = den > 0 ? num / den : 0;
  return x.map((v, i) => v - (my + slope * (i - mx)));
}

export function detectVibrato(cents: number[], hop: number): { rate: number; extentCents: number } | null {
  const n = cents.length;
  if (n < 8) return null;
  const fs = 1 / hop;
  // autocorrelation for lags corresponding to 3.5–9 Hz
  const minLag = Math.max(2, Math.floor(fs / 9));
  const maxLag = Math.min(n - 2, Math.ceil(fs / 3.5));
  if (maxLag <= minLag) return null;
  let e0 = 0;
  for (const c of cents) e0 += c * c;
  if (e0 === 0) return null;
  let bestLag = -1;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += cents[i] * cents[i + lag];
    const r = acc / e0;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best < 0.3) return null;
  const rate = fs / bestLag;
  // extent: mean peak-to-peak over cycles
  const sorted = [...cents].sort((a, b) => a - b);
  const extent = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
  if (rate < 4 || rate > 8 || extent < 20) return null;
  return { rate: Math.round(rate * 10) / 10, extentCents: Math.round(extent) };
}

export function dynamicFor(db: number): Dynamic {
  if (db >= -3) return 'ff';
  if (db >= -7) return 'f';
  if (db >= -12) return 'mf';
  if (db >= -18) return 'mp';
  if (db >= -26) return 'p';
  return 'pp';
}

export function buildPhrases(notes: RefNote[], duration: number): { phrases: Phrase[]; breaths: number[] } {
  const breaths: number[] = [];
  if (notes.length === 0) return { phrases: [], breaths };
  // group notes: split at gaps >= 0.25 s
  let groups: number[][] = [];
  let cur: number[] = [notes[0].id];
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].start - notes[i - 1].end;
    if (gap >= 0.25) {
      breaths.push(notes[i - 1].end);
      groups.push(cur);
      cur = [];
    }
    cur.push(notes[i].id);
  }
  groups.push(cur);
  // cap at 12 s by splitting at the largest internal gap
  let changed = true;
  while (changed) {
    changed = false;
    const next: number[][] = [];
    for (const g of groups) {
      const span = notes[g[g.length - 1]].end - notes[g[0]].start;
      if (span > 12 && g.length > 3) {
        let bestI = 1;
        let bestGap = -1;
        for (let i = 1; i < g.length; i++) {
          const gap = notes[g[i]].start - notes[g[i - 1]].end;
          if (gap > bestGap) {
            bestGap = gap;
            bestI = i;
          }
        }
        next.push(g.slice(0, bestI), g.slice(bestI));
        changed = true;
      } else next.push(g);
    }
    groups = next;
  }
  // merge short phrases (< 1 s or < 2 notes) into a neighbour (the closer one in time)
  let merged = true;
  while (merged && groups.length > 1) {
    merged = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const span = notes[g[g.length - 1]].end - notes[g[0]].start;
      if (span >= 1.0 && g.length >= 2) continue;
      const prev = groups[i - 1];
      const nxt = groups[i + 1];
      const dPrev = prev ? notes[g[0]].start - notes[prev[prev.length - 1]].end : Infinity;
      const dNext = nxt ? notes[nxt[0]].start - notes[g[g.length - 1]].end : Infinity;
      if (!prev && !nxt) break;
      if (dPrev <= dNext) {
        groups[i - 1] = prev.concat(g);
      } else {
        groups[i + 1] = g.concat(nxt);
      }
      groups.splice(i, 1);
      merged = true;
      break;
    }
  }
  const allMidi = notes.map((n) => n.midi);
  const p95 = percentile(allMidi, 95);
  const p05 = percentile(allMidi, 5);
  const top15 = percentile(allMidi, 85);
  const phrases: Phrase[] = groups.map((g, index) => {
    const ns = g.map((id) => notes[id]);
    const start = Math.max(0, ns[0].start - 0.05);
    const end = Math.min(duration, ns[ns.length - 1].end + 0.05);
    const tags = new Set<PhraseTag>();
    const medMidi = median(ns.map((n) => n.midi));
    let difficulty = 1;
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      n.phrase = index;
      if (n.midi >= p95 || (n.midi >= medMidi + 2 && n.midi >= top15)) tags.add('high-note');
      if (n.midi <= p05) tags.add('low-note');
      if (n.end - n.start >= 1.2) tags.add('long-hold');
      if (n.run) tags.add('run');
      if (n.slideIn) tags.add('slide');
      if (n.vibrato) tags.add('vibrato');
      if (i > 0 && Math.abs(n.midi - ns[i - 1].midi) >= 7) tags.add('wide-leap');
    }
    const span = end - start;
    if (ns.length / Math.max(0.5, span) >= 5) tags.add('fast');
    difficulty += (tags.has('high-note') ? 1 : 0) + (tags.has('run') || tags.has('fast') ? 1 : 0);
    difficulty += (tags.has('wide-leap') ? 1 : 0) + (tags.has('long-hold') || tags.has('vibrato') ? 0.5 : 0) + (tags.has('slide') ? 0.5 : 0);
    return {
      index,
      start,
      end,
      noteIds: g,
      text: '',
      difficulty: Math.min(5, Math.round(difficulty)),
      tags: [...tags],
    };
  });
  return { phrases, breaths };
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbb += (b[i] - mb) ** 2;
  }
  return da && dbb ? num / Math.sqrt(da * dbb) : 0;
}

/** Rough key estimate from the melody's pitch-class duration histogram (Krumhansl-Schmuckler). */
export function estimateKeyFromNotes(notes: RefNote[]): KeyInfo | null {
  if (notes.length < 8) return null;
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12] += n.end - n.start;
  const scores: { tonic: string; mode: 'major' | 'minor'; r: number }[] = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p: number[]) => p.map((_, i) => p[((i - t) % 12 + 12) % 12]);
    scores.push({ tonic: NOTE_NAMES[t], mode: 'major', r: corr(hist, rot(MAJOR)) });
    scores.push({ tonic: NOTE_NAMES[t], mode: 'minor', r: corr(hist, rot(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  const conf = Math.max(0, Math.min(1, (best.r - scores[1].r) * 4 + 0.3));
  return { tonic: best.tonic, mode: best.mode, confidence: Math.round(conf * 100) / 100 };
}
