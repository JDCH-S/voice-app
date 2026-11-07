import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { coachChat, coachStatus, setCoachKey, type CoachStatus } from '../lib/api';
import { deleteCoachThread, listAttempts, listCoachThreads, listSessions, listSongs, saveCoachThread } from '../lib/store/db';
import type { CoachMessage, CoachThread, PhraseAttempt, SessionRecord, SongRecord } from '../lib/types';
import { buildCoachContext, contextBytes, type CoachContext } from '../lib/coachContext';
import { uid } from '../lib/music/notes';

type Availability = 'checking' | 'no-server' | 'no-coach' | CoachStatus;

const MAX_MESSAGES_SENT = 20;

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t;
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'The analysis service did not answer. Is it running? Check the address under Settings.';
  return m;
}

export default function Coach() {
  const { profile, server, serverChecked, recheckServer, session } = useApp();
  const [params, setParams] = useSearchParams();
  const [avail, setAvail] = useState<Availability>('checking');
  const [threads, setThreads] = useState<CoachThread[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [pending, setPending] = useState<CoachThread | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ attempts: PhraseAttempt[]; songs: SongRecord[]; sessions: SessionRecord[] } | null>(null);
  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // the opening question handed over by another page (e.g. the session recap)
  useEffect(() => {
    const q = params.get('q');
    if (q) {
      setDraft(q);
      setCurrentId(null);
      setParams({}, { replace: true });
      setTimeout(() => boxRef.current?.focus(), 50);
    }
  }, [params, setParams]);

  const checkStatus = useCallback(async () => {
    setAvail('checking');
    const st = await coachStatus();
    if (st) {
      setAvail(st);
      return;
    }
    // no coach endpoint: is the service itself up?
    await recheckServer();
    setAvail((prev) => (prev === 'checking' ? 'no-server' : prev));
  }, [recheckServer]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);
  // refine "no server" vs "server without coach" once the health check has answered
  useEffect(() => {
    if (avail === 'no-server' && serverChecked && server?.ok) setAvail('no-coach');
  }, [avail, server, serverChecked]);

  useEffect(() => {
    listCoachThreads().then((t) => {
      setThreads(t);
      if (!params.get('q') && t.length) setCurrentId((c) => c ?? t[0].id);
    });
    (async () => {
      const [attempts, songs, sessions] = await Promise.all([listAttempts(), listSongs(), listSessions()]);
      setData({ attempts, songs, sessions });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const context: CoachContext | null = useMemo(() => {
    if (!profile || !data) return null;
    const sessions = data.sessions.some((s) => s.id === session.id) ? data.sessions.map((s) => (s.id === session.id ? session : s)) : [...data.sessions, session];
    return buildCoachContext(profile, data.attempts, data.songs, sessions);
  }, [profile, data, session]);

  const current = pending ?? threads.find((t) => t.id === currentId) ?? null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [current?.messages.length, sending]);

  const ready = typeof avail === 'object' && avail.available;

  async function send(textIn: string) {
    const text = textIn.trim();
    if (!text || sending || !context) return;
    const base: CoachThread = current ?? { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), title: titleFrom(text), messages: [] };
    const userMsg: CoachMessage = { role: 'user', content: text, date: Date.now() };
    const optimistic: CoachThread = { ...base, title: base.messages.length ? base.title : titleFrom(text), messages: [...base.messages, userMsg], updatedAt: Date.now() };
    setPending(optimistic);
    setDraft('');
    setError(null);
    setSending(true);
    try {
      const history = optimistic.messages.slice(-MAX_MESSAGES_SENT).map((m) => ({ role: m.role, content: m.content }));
      const reply = await coachChat(history, context);
      const done: CoachThread = { ...optimistic, messages: [...optimistic.messages, { role: 'assistant', content: reply, date: Date.now() }], updatedAt: Date.now() };
      await saveCoachThread(done);
      setThreads((ts) => [done, ...ts.filter((t) => t.id !== done.id)]);
      setCurrentId(done.id);
      setPending(null);
    } catch (e) {
      // keep the question in the box so nothing is lost
      setError(errorText(e));
      setDraft(text);
      setPending(null);
      if (/401|key/i.test(String((e as Error).message))) checkStatus();
    } finally {
      setSending(false);
    }
  }

  async function saveKey() {
    const k = key.trim();
    if (!k) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const st = await setCoachKey(k);
      setAvail(st);
      setKey('');
      if (!st.available) setKeyError(st.message || 'The key was saved but the coach is still not available.');
    } catch (e) {
      setKeyError(errorText(e));
    } finally {
      setKeyBusy(false);
    }
  }

  async function removeThread(id: string) {
    if (!confirm('Delete this chat?')) return;
    await deleteCoachThread(id);
    setThreads((ts) => ts.filter((t) => t.id !== id));
    if (currentId === id) setCurrentId(null);
  }

  if (!profile) return null;

  const latestSong = data?.songs[0] ?? null;
  const quick = [
    'Why do I go flat on high notes?',
    'Plan my week',
    latestSong ? `Is "${latestSong.title}" too hard for me?` : 'Which song should I learn first?',
    'What should I warm up with today?',
  ];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Coach</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            A vocal coach who has seen your numbers: range, scores, the issues that keep coming back. Short, honest answers that name the exercise to do.
          </p>
        </div>
        <button onClick={() => setCurrentId(null)} disabled={!ready && current === null} className="primary">
          New chat
        </button>
      </div>

      {avail === 'checking' && <div className="card muted small">Checking whether the coach is available…</div>}

      {avail === 'no-server' && (
        <div className="card col" style={{ gap: 10 }}>
          <h3>The coach needs the analysis service</h3>
          <p className="small muted" style={{ margin: 0 }}>
            The coach runs through the analysis service (the Python program that also isolates vocals), which keeps your key off the browser. It is not reachable
            right now. Start Voice Coach with the start file, or check the server address under <Link to="/settings">Settings</Link>. Everything else in the app
            works without it.
          </p>
          <div>
            <button onClick={checkStatus}>Check again</button>
          </div>
        </div>
      )}

      {avail === 'no-coach' && (
        <div className="card col" style={{ gap: 10 }}>
          <h3>This analysis service has no coach yet</h3>
          <p className="small muted" style={{ margin: 0 }}>
            The service answered, but it does not offer the coach endpoints. Update it to the current version (restart with the start file so it reinstalls) and
            check again.
          </p>
          <div>
            <button onClick={checkStatus}>Check again</button>
          </div>
        </div>
      )}

      {typeof avail === 'object' && !avail.available && (
        <div className="card col" style={{ gap: 10, borderColor: '#c7cdfd', background: 'var(--accent-soft)' }}>
          <h3>Set up the coach</h3>
          <p className="small" style={{ margin: 0 }}>
            {avail.message || 'The coach needs an Anthropic API key.'} The key is saved by the analysis service on this computer (in its private folder), never in the
            browser, and it is only used for your coach questions. Your audio is never sent.
          </p>
          <div className="row">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
              style={{ maxWidth: 420, flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveKey();
              }}
            />
            <button className="primary" onClick={saveKey} disabled={keyBusy || !key.trim()}>
              {keyBusy ? 'Saving…' : 'Save key'}
            </button>
            <button onClick={checkStatus} disabled={keyBusy}>
              Check again
            </button>
          </div>
          {keyError && <div className="banner bad small">{keyError}</div>}
          <div className="tiny muted">
            Model: {avail.model || 'default'} · key source: {avail.keySource === 'none' ? 'none yet' : avail.keySource}
          </div>
        </div>
      )}

      <div className="coach-layout">
        <div className="card col" style={{ gap: 8 }}>
          <div className="row between">
            <b className="small">Chats</b>
            <span className="tiny muted">{threads.length}</span>
          </div>
          <div className="coach-threads">
            {threads.length === 0 && <div className="tiny muted">No chats yet.</div>}
            {threads.map((t) => (
              <button key={t.id} className={`coach-thread ${t.id === currentId && !pending ? 'current' : ''}`} onClick={() => setCurrentId(t.id)}>
                <span className="title">{t.title}</span>
                <span className="tiny muted">
                  {t.messages.length} messages · {new Date(t.updatedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
          {context && (
            <div className="tiny muted" style={{ marginTop: 8 }}>
              The coach sees: your level and goals, your range, your last {context.recentAttempts.length} takes, the issues that repeat, your {context.songs.length} song
              {context.songs.length === 1 ? '' : 's'} and your streak ({(contextBytes(context) / 1024).toFixed(1)} kB of numbers, no audio).
            </div>
          )}
        </div>

        <div className="card col" style={{ gap: 12 }}>
          {current ? (
            <div className="row between">
              <h3 style={{ margin: 0 }}>{current.title}</h3>
              {!pending && (
                <button className="ghost small danger" onClick={() => removeThread(current.id)}>
                  Delete
                </button>
              )}
            </div>
          ) : (
            <h3 style={{ margin: 0 }}>New chat</h3>
          )}
          <div className="coach-messages">
            {!current && (
              <div className="muted small">
                Ask anything about your singing. The coach answers from your real results, so "why do I go flat on high notes?" gets a specific answer, not a
                generic one.
              </div>
            )}
            {current?.messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.content}
                <span className="when">{new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
            {sending && (
              <div className="msg assistant pending">
                <span className="typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          {error && <div className="banner bad small">{error}</div>}
          <div className="quick-prompts">
            {quick.map((q) => (
              <button key={q} onClick={() => (ready ? send(q) : setDraft(q))} disabled={sending || !context}>
                {q}
              </button>
            ))}
          </div>
          <div className="coach-compose">
            <textarea
              ref={boxRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={ready ? 'Ask the coach… (Enter to send, Shift+Enter for a new line)' : 'The coach is not available yet; your question will wait here.'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (ready) send(draft);
                }
              }}
            />
            <button className="primary" onClick={() => send(draft)} disabled={!ready || sending || !draft.trim() || !context}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          <div className="tiny muted">Vocal health first: if anything hurts, stop. The coach is not a doctor; see an ENT or a speech therapist for pain or hoarseness that lasts.</div>
        </div>
      </div>
    </div>
  );
}
