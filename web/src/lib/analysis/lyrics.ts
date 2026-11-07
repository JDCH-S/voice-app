import type { Lyrics, LyricLine, SongAnalysis, WordTiming } from '../types';

/** Parse LRC ("[mm:ss.xx] text") or plain text into lyric lines. */
export function parseLyrics(text: string, source: Lyrics['source'] = 'manual'): Lyrics {
  const lines: LyricLine[] = [];
  let synced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line);
    if (m) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      const body = m[3].replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
      if (body) {
        lines.push({ t, text: body });
        synced = true;
      }
      continue;
    }
    if (/^\[[a-z]+:.*\]$/i.test(line)) continue; // LRC metadata tags
    lines.push({ t: null, text: line });
  }
  return { source: lines.length ? source : 'none', synced, lines };
}

const emptyLyrics = (): Lyrics => ({ source: 'none', synced: false, lines: [] });

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Attach lyric text to phrases and words to notes. Mutates and returns `analysis`.
 * Synced lines are matched by time; unsynced lines are spread across phrases in order.
 */
export function alignLyrics(analysis: SongAnalysis, lyrics: Lyrics | null): SongAnalysis {
  const ly = lyrics ?? emptyLyrics();
  for (const n of analysis.notes) n.lyric = null;
  for (const p of analysis.phrases) p.text = '';
  if (ly.lines.length === 0) return analysis;

  const phrases = analysis.phrases;
  if (ly.synced) {
    const lines = ly.lines.filter((l) => l.t !== null) as { t: number; text: string }[];
    lines.sort((a, b) => a.t - b.t);
    // each line spans [t, next.t)
    for (let i = 0; i < lines.length; i++) {
      const t0 = lines[i].t;
      const t1 = i + 1 < lines.length ? lines[i + 1].t : analysis.duration;
      // notes whose start lies inside the window (allow lines to start a bit early)
      const ids = analysis.notes.filter((n) => n.start >= t0 - 0.35 && n.start < t1 - 0.35).map((n) => n.id);
      assignWords(analysis, ids, words(lines[i].text));
    }
    for (const p of phrases) {
      const ws = p.noteIds.map((id) => analysis.notes[id].lyric).filter(Boolean) as string[];
      const dedup: string[] = [];
      for (const w of ws) if (dedup[dedup.length - 1] !== w) dedup.push(w);
      p.text = dedup.join(' ');
      if (!p.text) {
        const line = lines.filter((l) => l.t >= p.start - 0.5 && l.t <= p.end).map((l) => l.text);
        p.text = line.join(' / ');
      }
    }
    return analysis;
  }

  // Unsynced: spread lines over phrases proportionally to phrase count.
  const lines = ly.lines.map((l) => l.text);
  if (phrases.length === 0) return analysis;
  const perPhrase = lines.length / phrases.length;
  phrases.forEach((p, i) => {
    const a = Math.floor(i * perPhrase);
    const b = Math.max(a + 1, Math.floor((i + 1) * perPhrase));
    const text = lines.slice(a, Math.min(lines.length, b)).join(' / ');
    p.text = text;
    assignWords(analysis, p.noteIds, words(text.replace(/\s\/\s/g, ' ')));
  });
  return analysis;
}

// ---------- word-level alignment (speech-recognition timing) ----------

/** Seconds of overlap between [a0,a1] and [b0,b1] (0 when disjoint). */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Attach recognised words (with their true timing) to the notes and phrases of an analysis.
 * Each word goes to the note that overlaps it most in time; a word that overlaps no note goes to
 * the nearest note that starts within 0.3 s of it, otherwise it is kept on the phrase only.
 * Several words on one note are joined with spaces. Phrase text is the words sung inside the
 * phrase, in time order. Mutates and returns `analysis`. Falls back to `alignLyrics` when `words`
 * is empty and `fallback` is given.
 */
export function alignWords(analysis: SongAnalysis, words: WordTiming[] | null | undefined, fallback?: Lyrics | null): SongAnalysis {
  const ws = (words ?? [])
    .filter((w) => w && isFinite(w.t0) && isFinite(w.t1) && typeof w.text === 'string' && w.text.trim())
    .map((w) => ({ ...w, text: w.text.trim() }));
  if (ws.length === 0) return alignLyrics(analysis, fallback ?? null);
  ws.sort((a, b) => a.t0 - b.t0);
  const notes = [...analysis.notes].sort((a, b) => a.start - b.start);
  for (const n of analysis.notes) n.lyric = null;
  for (const p of analysis.phrases) p.text = '';
  const perNote = new Map<number, string[]>();
  const perPhrase = new Map<number, string[]>();
  let cursor = 0;
  for (const w of ws) {
    const t0 = w.t0;
    const t1 = Math.max(w.t1, w.t0 + 0.02);
    while (cursor < notes.length && notes[cursor].end < t0 - 0.3) cursor++;
    let best: (typeof notes)[number] | null = null;
    let bestOv = 0;
    let nearest: (typeof notes)[number] | null = null;
    let nearestD = Infinity;
    for (let i = cursor; i < notes.length; i++) {
      const n = notes[i];
      if (n.start > t1 + 0.3) break;
      const ov = overlap(t0, t1, n.start, n.end);
      if (ov > bestOv) {
        bestOv = ov;
        best = n;
      }
      const d = Math.abs(n.start - t0);
      if (d < nearestD) {
        nearestD = d;
        nearest = n;
      }
    }
    const target = best ?? (nearest && nearestD <= 0.3 ? nearest : null);
    if (target) {
      const arr = perNote.get(target.id) ?? [];
      arr.push(w.text);
      perNote.set(target.id, arr);
      const ph = perPhrase.get(target.phrase) ?? [];
      ph.push(w.text);
      perPhrase.set(target.phrase, ph);
    } else {
      // no note near this word: keep it on the phrase whose span contains it
      const p = analysis.phrases.find((x) => t0 >= x.start - 0.3 && t0 <= x.end + 0.3);
      if (p) {
        const ph = perPhrase.get(p.index) ?? [];
        ph.push(w.text);
        perPhrase.set(p.index, ph);
      }
    }
  }
  for (const [id, arr] of perNote) analysis.notes[id].lyric = arr.join(' ');
  for (const p of analysis.phrases) p.text = (perPhrase.get(p.index) ?? []).join(' ');
  return analysis;
}

/** The recognised word being sung at song time `t` (words sorted by t0), or null. */
export function wordAt(words: WordTiming[], t: number): WordTiming | null {
  if (words.length === 0) return null;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  for (let i = Math.max(0, lo - 1); i <= Math.min(words.length - 1, lo + 1); i++) {
    const w = words[i];
    if (t >= w.t0 && t <= Math.max(w.t1, w.t0 + 0.05)) return w;
  }
  return null;
}

function assignWords(analysis: SongAnalysis, noteIds: number[], ws: string[]) {
  if (noteIds.length === 0 || ws.length === 0) return;
  if (ws.length >= noteIds.length) {
    // more words than notes: group words per note
    const per = ws.length / noteIds.length;
    noteIds.forEach((id, i) => {
      const a = Math.floor(i * per);
      const b = Math.max(a + 1, Math.floor((i + 1) * per));
      analysis.notes[id].lyric = ws.slice(a, b).join(' ');
    });
  } else {
    // fewer words than notes: longer notes get a word, short ones continue the previous word
    const sorted = [...noteIds];
    const per = noteIds.length / ws.length;
    let w = 0;
    sorted.forEach((id, i) => {
      if (i >= Math.floor(w * per) && w < ws.length) {
        analysis.notes[id].lyric = ws[w];
        w++;
      } else {
        analysis.notes[id].lyric = null;
      }
    });
  }
}
