import type { Lyrics, LyricLine, SongAnalysis } from '../types';

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
