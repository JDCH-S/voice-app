import type { SongAnalysis } from './types';

export const DEFAULT_SERVER = 'http://localhost:8765';

let serverUrl = localStorage.getItem('voicecoach.server') || DEFAULT_SERVER;

export function getServerUrl() {
  return serverUrl;
}

export function setServerUrl(u: string) {
  serverUrl = u.replace(/\/$/, '');
  localStorage.setItem('voicecoach.server', serverUrl);
}

export interface Health {
  ok: boolean;
  separation: 'demucs' | 'unavailable';
  device: string;
  version: string;
}

export interface JobStatus {
  status: 'queued' | 'decoding' | 'quick' | 'separating' | 'finalizing' | 'done' | 'failed';
  progress: number;
  message: string;
  meta: { title: string | null; artist: string | null; duration: number; tags: Record<string, string> } | null;
  quickReady: boolean;
  finalReady: boolean;
  error: string | null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

export async function health(timeoutMs = 2500): Promise<Health | null> {
  try {
    const r = await withTimeout(fetch(`${serverUrl}/health`), timeoutMs);
    if (!r.ok) return null;
    return (await r.json()) as Health;
  } catch {
    return null;
  }
}

export async function startAnalysis(file: Blob, filename: string, separate: boolean): Promise<string> {
  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('separate', separate ? 'true' : 'false');
  const r = await fetch(`${serverUrl}/analyze`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`Analysis server error ${r.status}`);
  const j = (await r.json()) as { jobId: string };
  return j.jobId;
}

export async function jobStatus(jobId: string): Promise<JobStatus> {
  const r = await fetch(`${serverUrl}/jobs/${jobId}`);
  if (!r.ok) throw new Error(`Job ${jobId} not found`);
  return (await r.json()) as JobStatus;
}

export async function jobAnalysis(jobId: string, stage: 'quick' | 'final'): Promise<SongAnalysis> {
  const r = await fetch(`${serverUrl}/jobs/${jobId}/analysis/${stage}`);
  if (!r.ok) throw new Error(`Analysis not ready`);
  return (await r.json()) as SongAnalysis;
}

export async function jobStem(jobId: string, kind: 'vocals' | 'instrumental'): Promise<{ blob: Blob; mime: string }> {
  const r = await fetch(`${serverUrl}/jobs/${jobId}/stems/${kind}`);
  if (!r.ok) throw new Error(`Stem ${kind} not available`);
  const blob = await r.blob();
  return { blob, mime: r.headers.get('content-type') || blob.type || 'audio/mpeg' };
}

export async function deleteJob(jobId: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/jobs/${jobId}`, { method: 'DELETE' });
  } catch {
    /* best effort */
  }
}

export async function identify(url: string): Promise<{ title: string | null; artist: string | null; source: string }> {
  const r = await fetch(`${serverUrl}/identify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw new Error('Could not identify that link');
  return (await r.json()) as { title: string | null; artist: string | null; source: string };
}

export async function searchLyrics(
  title: string,
  artist: string,
  duration?: number,
): Promise<{ found: boolean; synced: string | null; plain: string | null }> {
  const r = await fetch(`${serverUrl}/lyrics/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, artist, duration }),
  });
  if (!r.ok) throw new Error('Lyrics lookup failed');
  return (await r.json()) as { found: boolean; synced: string | null; plain: string | null };
}
