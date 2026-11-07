/**
 * Turn getUserMedia failures into something a guest can act on: what went
 * wrong (blocked, busy, missing), which device it affects, and how to fix it
 * in the browser they are actually using.
 */

export type MediaAccessErrorKind =
  | 'permission-denied'
  | 'in-use'
  | 'not-found'
  | 'insecure-context'
  | 'constraints'
  | 'unknown';

export type MediaAccessDevice = 'camera' | 'microphone' | 'both';

export interface MediaAccessProblem {
  kind: MediaAccessErrorKind;
  device: MediaAccessDevice;
  message: string;
}

export type BrowserFamily = 'ios' | 'safari' | 'chrome' | 'edge' | 'firefox' | 'android' | 'other';

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export function classifyMediaAccessError(error: unknown): MediaAccessErrorKind {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission-denied';
    case 'SecurityError':
      return 'insecure-context';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'constraints';
    default:
      return 'unknown';
  }
}

/** A blocked permission will not change by asking again, and asking again can re-prompt in Safari. */
export function isMediaPermissionBlock(error: unknown): boolean {
  const kind = classifyMediaAccessError(error);
  return kind === 'permission-denied' || kind === 'insecure-context';
}

/**
 * Whether a short wait and one more try is worth it. Safari in particular
 * fails transiently right after another stream on the same camera stopped.
 */
export function isTransientMediaAccessError(kind: MediaAccessErrorKind): boolean {
  return kind === 'in-use' || kind === 'unknown' || kind === 'not-found';
}

function deviceNoun(device: MediaAccessDevice): string {
  switch (device) {
    case 'camera': return 'camera';
    case 'microphone': return 'microphone';
    case 'both': return 'camera and microphone';
  }
}

export function describeMediaAccessProblem(kind: MediaAccessErrorKind, device: MediaAccessDevice): string {
  const noun = deviceNoun(device);
  const capitalized = noun.charAt(0).toUpperCase() + noun.slice(1);
  switch (kind) {
    case 'permission-denied':
      return `${capitalized} access is blocked for this site.`;
    case 'insecure-context':
      return `This browser blocked the ${noun} because the page is not secure. Open the studio link over https.`;
    case 'in-use':
      return `Your ${noun} ${device === 'both' ? 'are' : 'is'} busy or did not start. Another app or tab may be using ${device === 'both' ? 'them' : 'it'}.`;
    case 'not-found':
      return `No ${noun} was found. Connect one and try again.`;
    case 'constraints':
      return `The selected ${noun} could not start with these settings.`;
    case 'unknown':
      return `Your ${noun} could not start.`;
  }
}

export function createMediaAccessProblem(error: unknown, device: MediaAccessDevice): MediaAccessProblem {
  const kind = classifyMediaAccessError(error);
  return { kind, device, message: describeMediaAccessProblem(kind, device) };
}

/** The same problem, now about one device only (the other one started). */
export function withMediaAccessDevice(problem: MediaAccessProblem, device: MediaAccessDevice): MediaAccessProblem {
  return { kind: problem.kind, device, message: describeMediaAccessProblem(problem.kind, device) };
}

interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  platform?: string;
}

export function detectBrowserFamily(nav: NavigatorLike | undefined = typeof navigator === 'undefined' ? undefined : navigator): BrowserFamily {
  const ua = nav?.userAgent || '';
  // iPadOS reports a desktop Mac user agent; touch support gives it away.
  const isIos = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (nav?.maxTouchPoints || 0) > 1);
  if (isIos) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}

/** Step-by-step help for the problem in this browser. Empty when retrying is all there is to do. */
export function getMediaAccessHelpSteps(kind: MediaAccessErrorKind, browser: BrowserFamily): string[] {
  if (kind === 'permission-denied') {
    switch (browser) {
      case 'ios':
        return [
          'Tap "aA" (or the page menu) in the address bar, then Website Settings.',
          'Set Camera and Microphone to Allow, then tap Try again.',
          'Still blocked? Open the Settings app > Safari (or your browser) > Camera and Microphone and choose Allow.',
        ];
      case 'safari':
        return [
          'In the menu bar choose Safari > Settings for This Website.',
          'Set Camera and Microphone to Allow, then click Try again.',
          'If nothing changes, check System Settings > Privacy & Security > Camera and Microphone.',
        ];
      case 'firefox':
        return [
          'Click the camera icon at the left of the address bar.',
          'Remove the "Blocked" entries for camera and microphone, then click Try again and choose Allow.',
        ];
      case 'android':
        return [
          'Tap the lock or settings icon next to the address, then Permissions.',
          'Allow Camera and Microphone, then tap Try again.',
          'If they are greyed out, allow them for your browser in Android Settings > Apps.',
        ];
      case 'chrome':
      case 'edge':
        return [
          'Click the camera or lock icon at the left of the address bar.',
          'Set Camera and Microphone to Allow, then click Try again.',
          'On a Mac, also check System Settings > Privacy & Security > Camera and Microphone.',
        ];
      case 'other':
        return [
          'Open this site\'s permissions from the address bar.',
          'Allow the camera and microphone, then try again.',
        ];
    }
  }
  if (kind === 'in-use') {
    return [
      'Close other apps that may be using it (Zoom, Teams, FaceTime, OBS) and other tabs with this studio open.',
      'Then try again. Unplugging and reconnecting an external device can also help.',
    ];
  }
  if (kind === 'not-found') {
    return ['Connect a camera or microphone (or check it is switched on), then try again.'];
  }
  if (kind === 'constraints') {
    return ['Pick another device or a lower video quality in Settings, then try again.'];
  }
  return [];
}
