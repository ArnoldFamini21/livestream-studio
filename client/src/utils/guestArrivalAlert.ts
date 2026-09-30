import { acquireAudioContext, releaseAudioContext } from './audioContext.ts';

/**
 * A guest reaching the green room is easy to miss while the host is busy
 * with another panel or another tab. Hosts hear a short chime (on their own
 * speakers only: it is never connected to the broadcast mix), and when the
 * studio tab is in the background they also get a system notification.
 */

/** Guests arriving together get one chime, not a burst. */
export const ARRIVAL_CHIME_MIN_GAP_MS = 2_000;

export interface ArrivalAlertInput {
  tabHidden: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  lastChimeAt: number | null;
  now: number;
}

export interface ArrivalAlertPlan {
  chime: boolean;
  notify: boolean;
}

export function planArrivalAlert(input: ArrivalAlertInput): ArrivalAlertPlan {
  return {
    chime: input.lastChimeAt === null || input.now - input.lastChimeAt >= ARRIVAL_CHIME_MIN_GAP_MS,
    notify: input.tabHidden && input.notificationPermission === 'granted',
  };
}

function currentNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Ask for notification permission from a host's click (browsers ignore or
 * penalize requests that are not tied to a gesture). Asks only once.
 */
export function requestArrivalNotificationPermission(): void {
  if (currentNotificationPermission() !== 'default') return;
  try {
    void Notification.requestPermission().catch(() => {});
  } catch {
    // Older Safari: callback form only; not worth supporting for a courtesy alert.
  }
}

function playArrivalChime(): void {
  let context: AudioContext;
  try {
    context = acquireAudioContext();
  } catch {
    return;
  }
  try {
    const start = context.currentTime + 0.02;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    gain.connect(context.destination);
    [660, 880].forEach((frequency, index) => {
      const tone = context.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      tone.connect(gain);
      tone.start(start + index * 0.14);
      tone.stop(start + 0.5);
    });
    window.setTimeout(() => {
      gain.disconnect();
      releaseAudioContext();
    }, 800);
  } catch {
    releaseAudioContext();
  }
}

let lastChimeAt: number | null = null;

export function alertGuestArrival(name: string, studioName: string): void {
  const now = Date.now();
  const plan = planArrivalAlert({
    tabHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    notificationPermission: currentNotificationPermission(),
    lastChimeAt,
    now,
  });
  if (plan.chime) {
    lastChimeAt = now;
    playArrivalChime();
  }
  if (plan.notify) {
    try {
      const notification = new Notification(`${name} is waiting to join`, {
        body: `${studioName}: open the studio to let them in.`,
        tag: 'studio-guest-waiting',
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }
}
