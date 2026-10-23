import { useEffect, useRef } from 'react';
import type { Level, NoteResult, PitchFrame, SongAnalysis } from '../lib/types';
import { midiToName, NOTE_NAMES } from '../lib/music/notes';
import { tolerances } from '../lib/scoring/score';

export interface PianoRollProps {
  analysis: SongAnalysis;
  semitones: number;
  level: Level;
  /** returns current song time, or null when stopped (then `staticTime` is used) */
  getTime: () => number | null;
  staticTime?: number;
  framesRef: React.MutableRefObject<PitchFrame[]>;
  windowSeconds?: number;
  phrase?: { start: number; end: number } | null;
  results?: Map<number, NoteResult> | null;
  height?: number;
  allowOctave?: boolean;
  /** when true, follow the playhead; when false, keep the phrase in view */
  follow?: boolean;
}

const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);

export default function PianoRoll(props: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const draw = () => {
      const p = propsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth;
      const H = p.height ?? 420;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.height = `${H}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(ctx, W, H, p);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} style={{ width: '100%', height: props.height ?? 420 }} />;
}

function render(ctx: CanvasRenderingContext2D, W: number, H: number, p: PianoRollProps) {
  const { analysis, semitones } = p;
  const gutter = 48;
  const lyricH = 34;
  const topPad = 14;
  const plotH = H - lyricH - topPad;
  const win = p.windowSeconds ?? 6;
  const follow = p.follow ?? true;
  const live = p.getTime();
  let t = live ?? p.staticTime ?? (p.phrase ? p.phrase.start : 0);
  let left: number;
  let right: number;
  if (!follow && p.phrase) {
    const span = Math.max(win, p.phrase.end - p.phrase.start + 1.0);
    left = p.phrase.start - 0.5;
    right = left + span;
  } else {
    left = t - win * 0.3;
    right = left + win;
  }
  const pxPerSec = (W - gutter) / (right - left);
  const xOf = (time: number) => gutter + (time - left) * pxPerSec;

  // pitch range to display
  let lo = Math.floor(analysis.range.lowMidi + semitones) - 3;
  let hi = Math.ceil(analysis.range.highMidi + semitones) + 3;
  if (p.phrase) {
    const ids = analysis.notes.filter((n) => n.end >= p.phrase!.start && n.start <= p.phrase!.end);
    if (ids.length) {
      const pl = Math.min(...ids.map((n) => n.midi)) + semitones - 4;
      const ph = Math.max(...ids.map((n) => n.midi)) + semitones + 4;
      lo = Math.min(lo, pl);
      hi = Math.max(hi, ph);
      // when following a phrase, zoom to it
      if (ph - pl >= 12) {
        lo = pl;
        hi = ph;
      } else {
        const c = (pl + ph) / 2;
        lo = Math.floor(c - 7);
        hi = Math.ceil(c + 7);
      }
    }
  }
  if (hi - lo < 14) {
    const c = (hi + lo) / 2;
    lo = Math.floor(c - 7);
    hi = Math.ceil(c + 7);
  }
  const laneH = plotH / (hi - lo + 1);
  const yOf = (midi: number) => topPad + (hi - midi + 0.5) * laneH;

  // background
  ctx.fillStyle = '#121626';
  ctx.fillRect(0, 0, W, H);
  for (let m = lo; m <= hi; m++) {
    const y = yOf(m) - laneH / 2;
    const pc = ((m % 12) + 12) % 12;
    ctx.fillStyle = WHITE.has(pc) ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.012)';
    ctx.fillRect(gutter, y, W - gutter, laneH);
    if (pc === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(gutter, y + laneH, W - gutter, 1);
    }
  }
  // phrase shading
  if (p.phrase) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const x0 = xOf(p.phrase.start);
    const x1 = xOf(p.phrase.end);
    if (x0 > gutter) ctx.fillRect(gutter, topPad, Math.min(W, x0) - gutter, plotH);
    if (x1 < W) ctx.fillRect(Math.max(gutter, x1), topPad, W - Math.max(gutter, x1), plotH);
  }
  // time grid every second
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let s = Math.ceil(left); s <= right; s++) {
    ctx.fillRect(xOf(s), topPad, 1, plotH);
  }
  // breath markers
  ctx.fillStyle = 'rgba(147, 197, 253, 0.8)';
  ctx.font = '12px system-ui';
  for (const b of analysis.breaths) {
    if (b < left || b > right) continue;
    ctx.fillText('˅', xOf(b) - 3, topPad + 10);
  }

  // reference melody line (f0 frames), faint
  const mel = analysis.melody;
  const i0 = Math.max(0, Math.floor((left - mel.t0) / mel.hop));
  const i1 = Math.min(mel.hz.length - 1, Math.ceil((right - mel.t0) / mel.hop));
  ctx.strokeStyle = 'rgba(199, 210, 254, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let pen = false;
  for (let i = i0; i <= i1; i++) {
    const hz = mel.hz[i];
    if (!hz) {
      pen = false;
      continue;
    }
    const midi = 69 + 12 * Math.log2(hz / 440) + semitones;
    const x = xOf(mel.t0 + i * mel.hop);
    const y = yOf(midi);
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // reference notes
  const results = p.results;
  ctx.font = '600 13px system-ui';
  let lastLyricX = -Infinity;
  for (const n of analysis.notes) {
    if (n.end < left - 1 || n.start > right + 1) continue;
    const m = n.midi + semitones;
    const x0 = xOf(n.start);
    const x1 = xOf(n.end);
    const y = yOf(m);
    const h = Math.max(6, laneH * 0.72);
    const inPhrase = !p.phrase || (n.end >= p.phrase.start && n.start <= p.phrase.end);
    const loudAlpha = 0.55 + 0.45 * Math.max(0, Math.min(1, 1 + n.loudnessDb / 30));
    let fill = `rgba(129, 140, 248, ${inPhrase ? loudAlpha : 0.3})`;
    const r = results?.get(n.id);
    if (r) {
      if (r.status === 'good') fill = `rgba(34, 197, 94, ${loudAlpha})`;
      else if (r.status === 'missed') fill = `rgba(239, 68, 68, ${loudAlpha})`;
      else if (r.status === 'octave') fill = `rgba(56, 189, 248, ${loudAlpha})`;
      else fill = `rgba(245, 158, 11, ${loudAlpha})`;
    }
    const active = live !== null && live >= n.start && live <= n.end;
    // slide-in tail
    if (n.slideIn) {
      ctx.strokeStyle = 'rgba(199, 210, 254, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const xs = xOf(n.start - n.slideIn.duration);
      ctx.moveTo(xs, yOf(n.slideIn.fromMidi + semitones));
      ctx.quadraticCurveTo(x0, yOf(n.slideIn.fromMidi + semitones), x0, y);
      ctx.stroke();
    }
    ctx.fillStyle = fill;
    roundRect(ctx, x0, y - h / 2, Math.max(3, x1 - x0), h, Math.min(6, h / 2));
    ctx.fill();
    if (active) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      roundRect(ctx, x0, y - h / 2, Math.max(3, x1 - x0), h, Math.min(6, h / 2));
      ctx.stroke();
    }
    // vibrato wave
    if (n.vibrato && x1 - x0 > 20) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const amp = Math.min(h * 0.3, 4);
      for (let x = x0 + 4; x < x1 - 4; x += 1) {
        const yy = y + Math.sin(((x - x0) / pxPerSec) * n.vibrato.rate * 2 * Math.PI) * amp;
        if (x === x0 + 4) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // dynamic tag on notable notes
    if (inPhrase && (n.dynamic === 'ff' || n.dynamic === 'pp' || n.dynamic === 'f' || n.dynamic === 'p') && x1 - x0 > 26) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'italic 600 11px serif';
      ctx.fillText(n.dynamic, x0 + 4, y - h / 2 - 2);
      ctx.font = '600 13px system-ui';
    }
    // lyric
    if (n.lyric && x0 > lastLyricX + 6 && x0 >= gutter - 2) {
      ctx.fillStyle = inPhrase ? '#e9ecf5' : 'rgba(233,236,245,0.45)';
      const text = n.lyric;
      ctx.fillText(text, x0, H - 12);
      lastLyricX = x0 + ctx.measureText(text).width;
    }
  }

  // user pitch trail
  const frames = p.framesRef.current;
  const tol = tolerances(p.level).cents;
  if (frames.length) {
    ctx.lineWidth = 3;
    let prevX = -1;
    let prevY = -1;
    let prevT = -1;
    const notes = analysis.notes;
    let ni = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f.t < left) continue;
      if (f.t > right) break;
      if (!(f.hz > 0) || f.clarity < 0.5) {
        prevX = -1;
        continue;
      }
      // nearest reference note active at f.t
      while (ni < notes.length && notes[ni].end < f.t - 0.1) ni++;
      let target: number | null = null;
      for (let k = ni; k < notes.length && notes[k].start <= f.t + 0.1; k++) {
        if (f.t >= notes[k].start - 0.1 && f.t <= notes[k].end + 0.1) {
          target = notes[k].midi + semitones + notes[k].cents / 100;
          break;
        }
      }
      let midi = f.midi;
      let cls: 'on' | 'near' | 'off' | 'none' = 'none';
      if (target !== null) {
        let err = (midi - target) * 100;
        if (p.allowOctave) {
          const oct = Math.round(err / 1200);
          if (oct !== 0) {
            err -= oct * 1200;
            midi -= oct * 12; // draw folded into the target octave
          }
        }
        const a = Math.abs(err);
        cls = a <= tol ? 'on' : a <= tol * 2 ? 'near' : 'off';
      }
      const x = xOf(f.t);
      const y = yOf(midi);
      ctx.strokeStyle = cls === 'on' ? '#22c55e' : cls === 'near' ? '#f59e0b' : cls === 'off' ? '#ef4444' : '#cbd5e1';
      if (prevX >= 0 && f.t - prevT < 0.08) {
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      prevX = x;
      prevY = y;
      prevT = f.t;
    }
  }

  // gutter with note names
  ctx.fillStyle = '#121626';
  ctx.fillRect(0, 0, gutter, H);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(gutter - 1, topPad, 1, plotH);
  ctx.font = '11px system-ui';
  for (let m = lo; m <= hi; m++) {
    const pc = ((m % 12) + 12) % 12;
    const y = yOf(m);
    if (laneH >= 11 || pc === 0 || pc === 5 || pc === 9) {
      ctx.fillStyle = pc === 0 ? '#c7d2fe' : 'rgba(255,255,255,0.45)';
      ctx.fillText(NOTE_NAMES[pc] + (pc === 0 ? Math.floor(m / 12) - 1 : ''), 6, y + 4);
    }
  }

  // playhead
  if (live !== null || follow) {
    const x = xOf(t);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - 1, topPad, 2, plotH);
    ctx.beginPath();
    ctx.moveTo(x - 6, topPad);
    ctx.lineTo(x + 6, topPad);
    ctx.lineTo(x, topPad + 7);
    ctx.fill();
  }
  // current time label
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '11px system-ui';
  ctx.fillText(fmt(t), W - 40, 12);
  void midiToName;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
