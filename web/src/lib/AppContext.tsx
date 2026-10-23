import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Profile, SessionRecord } from './types';
import { loadProfile, saveProfile, saveSession, listAttempts, listSongs, listSessions } from './store/db';
import { uid } from './music/notes';
import { buildRecap } from './plan';
import { health, type Health } from './api';

interface AppState {
  profile: Profile | null;
  updateProfile: (patch: Partial<Profile> | ((p: Profile) => Profile)) => Promise<void>;
  session: SessionRecord;
  noteActivity: (seconds: number) => void;
  registerAttempt: (id: string, songId: string) => void;
  registerExercise: (id: string) => void;
  endSession: () => Promise<SessionRecord>;
  server: Health | null;
  serverChecked: boolean;
  recheckServer: () => Promise<void>;
  restBanner: 'none' | 'soft' | 'strong';
  dismissRest: () => void;
}

const Ctx = createContext<AppState | null>(null);

const newSession = (): SessionRecord => ({
  id: uid(),
  startedAt: Date.now(),
  endedAt: null,
  activeSeconds: 0,
  songIds: [],
  phraseAttemptIds: [],
  exerciseResultIds: [],
  recap: null,
});

export function AppProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<SessionRecord>(() => {
    const s = newSession();
    localStorage.setItem('voicecoach.sessionId', s.id);
    return s;
  });
  const [server, setServer] = useState<Health | null>(null);
  const [serverChecked, setServerChecked] = useState(false);
  const [restBanner, setRestBanner] = useState<'none' | 'soft' | 'strong'>('none');
  const restDismissedAt = useRef<number>(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    loadProfile().then(setProfile);
    // resume the session in progress after a reload (sessions end explicitly or after 3 h idle)
    (async () => {
      const all = await listSessions();
      const open = all.filter((s) => s.endedAt === null && Date.now() - s.startedAt < 3 * 3600000);
      const last = open[open.length - 1];
      if (last && last.id !== sessionRef.current.id) {
        sessionRef.current = last;
        setSession(last);
        localStorage.setItem('voicecoach.sessionId', last.id);
      }
    })();
  }, []);

  const recheckServer = useCallback(async () => {
    const h = await health();
    setServer(h);
    setServerChecked(true);
  }, []);
  useEffect(() => {
    recheckServer();
  }, [recheckServer]);

  const updateProfile = useCallback(async (patch: Partial<Profile> | ((p: Profile) => Profile)) => {
    const base = await loadProfile();
    const next = typeof patch === 'function' ? patch(base) : { ...base, ...patch };
    await saveProfile(next);
    setProfile(next);
  }, []);

  const persist = useCallback((s: SessionRecord) => {
    setSession(s);
    saveSession(s).catch(() => {});
  }, []);

  const noteActivity = useCallback(
    (seconds: number) => {
      const s = { ...sessionRef.current, activeSeconds: sessionRef.current.activeSeconds + seconds };
      sessionRef.current = s;
      persist(s);
      // vocal health: suggest rest after 20 and 40 minutes of active singing
      const mins = s.activeSeconds / 60;
      const sinceDismiss = (Date.now() - restDismissedAt.current) / 60000;
      if (mins >= 40 && sinceDismiss > 10) setRestBanner('strong');
      else if (mins >= 20 && sinceDismiss > 10) setRestBanner('soft');
    },
    [persist],
  );

  const registerAttempt = useCallback(
    (id: string, songId: string) => {
      const cur = sessionRef.current;
      const s = {
        ...cur,
        phraseAttemptIds: [...cur.phraseAttemptIds, id],
        songIds: cur.songIds.includes(songId) ? cur.songIds : [...cur.songIds, songId],
      };
      sessionRef.current = s;
      persist(s);
    },
    [persist],
  );

  const registerExercise = useCallback(
    (id: string) => {
      const cur = sessionRef.current;
      const s = { ...cur, exerciseResultIds: [...cur.exerciseResultIds, id] };
      sessionRef.current = s;
      persist(s);
    },
    [persist],
  );

  const endSession = useCallback(async () => {
    const cur = sessionRef.current;
    const all = await listAttempts();
    const songs = await listSongs();
    const ids = new Set(cur.phraseAttemptIds);
    const mine = all.filter((a) => ids.has(a.id));
    const prev = all.filter((a) => !ids.has(a.id) && a.date < cur.startedAt);
    const recap = buildRecap(mine, prev, songs);
    const ended: SessionRecord = { ...cur, endedAt: Date.now(), recap };
    await saveSession(ended);
    const fresh = newSession();
    sessionRef.current = fresh;
    localStorage.setItem('voicecoach.sessionId', fresh.id);
    setSession(fresh);
    setRestBanner('none');
    return ended;
  }, []);

  const dismissRest = useCallback(() => {
    restDismissedAt.current = Date.now();
    setRestBanner('none');
  }, []);

  const value = useMemo<AppState>(
    () => ({
      profile,
      updateProfile,
      session,
      noteActivity,
      registerAttempt,
      registerExercise,
      endSession,
      server,
      serverChecked,
      recheckServer,
      restBanner,
      dismissRest,
    }),
    [profile, updateProfile, session, noteActivity, registerAttempt, registerExercise, endSession, server, serverChecked, recheckServer, restBanner, dismissRest],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
