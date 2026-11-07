// Daily practice reminder with the Notification API. Honest limits: a browser tab can only
// remind you while it is open (a closed tab cannot run code), and background tabs may fire late.

import type { Profile } from './types';
import { nextReminderAt, parseReminderTime } from './habits';

export type ReminderSupport = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationSupport(): ReminderSupport {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Ask for permission (must be called from a user gesture). */
export async function requestNotificationPermission(): Promise<ReminderSupport> {
  if (notificationSupport() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Show a notification now. Returns false when it could not be shown. */
export function showReminder(title: string, body: string): boolean {
  if (notificationSupport() !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag: 'voicecoach-daily', icon: '/favicon.svg' });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* not allowed */
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** Largest delay setTimeout accepts without overflowing (about 24.8 days). */
const MAX_TIMEOUT = 2147483647;

/**
 * Arm the daily reminder for as long as the app stays open. Fires at the profile's reminder time
 * each day; calls `onFire` so the UI can decide what to say. Returns a cancel function.
 */
export function scheduleReminder(profile: Pick<Profile, 'reminderTime'>, onFire: (at: number) => void, now: () => number = Date.now): () => void {
  if (!parseReminderTime(profile.reminderTime)) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const at = nextReminderAt(profile, now());
    if (at === null) return;
    const delay = Math.min(MAX_TIMEOUT, Math.max(0, at - now()));
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      if (now() >= at - 500) {
        onFire(at);
        // the next occurrence is tomorrow: wait a second so nextReminderAt moves past today's time
        timer = setTimeout(arm, 1500);
      } else arm();
    }, delay);
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/** Plain-words status line for the Settings page. */
export function reminderStatusText(profile: Pick<Profile, 'reminderTime'>, support: ReminderSupport, now: number = Date.now()): string {
  if (!parseReminderTime(profile.reminderTime)) return 'Off.';
  const at = nextReminderAt(profile, now);
  const when = at === null ? '' : ` Next: ${new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`;
  switch (support) {
    case 'unsupported':
      return 'This browser cannot show notifications. The reminder only appears inside the app while it is open.' + when;
    case 'denied':
      return 'Notifications are blocked for this site in your browser settings. The reminder only appears inside the app while it is open.' + when;
    case 'default':
      return 'Notifications are not allowed yet. Set the time again to be asked.' + when;
    case 'granted':
      return 'Notifications allowed. Honest limit: a closed tab cannot remind you, so keep Voice Coach open (a pinned tab works).' + when;
  }
}
