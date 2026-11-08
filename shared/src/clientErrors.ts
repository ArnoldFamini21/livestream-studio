/**
 * Production diagnostics deliberately accept a vocabulary, not arbitrary text.
 * Exception messages can contain names, transcripts, filenames and credentials;
 * removing email addresses or URL queries alone cannot make them anonymous.
 * Apply this policy both before transport and at the untrusted HTTP boundary.
 */
export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'react', 'media', 'stream', 'recording'] as const;
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number];

const SAFE_MESSAGES = [
  'Network request failed',
  'Dynamic module failed to load',
  'Media device permission denied',
  'Media device unavailable',
  'Media constraints could not be satisfied',
  'Browser storage quota exceeded',
  'Invalid data or syntax',
  'Cannot access an undefined or null value',
  'Invalid function call',
  'Maximum call stack size exceeded',
  'Browser MediaRecorder failed during the live relay.',
  'Live relay stopped after reconnect attempts',
  'Local recording track interrupted',
  'Signaling rate limited',
] as const;

const MESSAGE_PATTERNS: readonly [RegExp, typeof SAFE_MESSAGES[number]][] = [
  [/failed to fetch dynamically imported module|importing a module script failed|loading chunk .+ failed/i, 'Dynamic module failed to load'],
  [/failed to fetch|networkerror|network request failed|load failed/i, 'Network request failed'],
  [/notallowederror|permission denied/i, 'Media device permission denied'],
  [/notfounderror|notreadableerror|requested device not found|could not start video source/i, 'Media device unavailable'],
  [/overconstrainederror|constraintnotsatisfiederror/i, 'Media constraints could not be satisfied'],
  [/quotaexceedederror/i, 'Browser storage quota exceeded'],
  [/syntaxerror|unexpected token/i, 'Invalid data or syntax'],
  [/cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)|undefined is not an object|null is not an object/i, 'Cannot access an undefined or null value'],
  [/is not a function/i, 'Invalid function call'],
  [/maximum call stack size exceeded/i, 'Maximum call stack size exceeded'],
  [/^Live relay stopped after \d+ reconnect attempt\(s\):/, 'Live relay stopped after reconnect attempts'],
  [/^A local recording track \([^)]+\) was interrupted\.$/, 'Local recording track interrupted'],
  [/^Signaling rate limited:/, 'Signaling rate limited'],
];

const ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'DOMException'] as const;

export function sanitizeClientErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const message = value.slice(0, 8000).trim();
  if ((SAFE_MESSAGES as readonly string[]).includes(message)) return message;
  const reactCode = message.match(/(?:Minified React error|React error) #(\d{1,4})\b/);
  if (reactCode) return `React error #${reactCode[1]}`;
  for (const [pattern, replacement] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return replacement;
  }
  const name = ERROR_NAMES.find((candidate) => message === `${candidate}: details omitted` || message.startsWith(`${candidate}:`)) ?? 'Error';
  return `${name}: details omitted`;
}

/** Only immutable bundle hashes and source coordinates; no origin, path or function names. */
export function sanitizeClientErrorStack(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const frames: string[] = [];
  for (const line of value.slice(0, 16_000).split('\n').slice(0, 40)) {
    const safe = line.trim().match(/^asset:([A-Za-z0-9_-]{8}):(\d{1,7}):(\d{1,7})$/);
    const compiled = line.match(/\/assets\/[A-Za-z0-9_$.-]+-([A-Za-z0-9_-]{8})\.js:(\d{1,7}):(\d{1,7})(?:\)|\s|$)/);
    const match = safe ?? compiled;
    if (match) frames.push(`asset:${match[1]}:${match[2]}:${match[3]}`);
    if (frames.length >= 12) break;
  }
  return frames.length ? frames.join('\n') : undefined;
}

export function sanitizeClientErrorPage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let path: string;
  try { path = new URL(value, 'https://redacted.invalid').pathname; } catch { return undefined; }
  if (/^\/studio\/[^/]+\/popout-chat\/?$/.test(path)) return '/studio/:roomId/popout-chat';
  const roomRoute = path.match(/^\/(studio|join|watch)\/[^/]+\/?$/);
  if (roomRoute) return `/${roomRoute[1]}/:roomId`;
  return ['/', '/privacy', '/terms', '/reset-password'].includes(path) ? path : '/other';
}

export function sanitizeClientErrorRelease(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{7,40}$/i.test(value) ? value.toLowerCase() : undefined;
}
