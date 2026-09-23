/**
 * Browser error intake. The studio runs almost entirely in the host's browser,
 * so without this a failed go-live or a crashed compositor is invisible to the
 * operator. Reports are sanitized (no query strings or fragments, which can
 * carry invite and media tokens), truncated, logged as one JSON line, and
 * counted for `/metrics`.
 */

export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'react', 'media', 'stream', 'recording'] as const;
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number];

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  page?: string;
  release?: string;
  userAgent?: string;
  count: number;
}

const MESSAGE_MAX = 500;
const STACK_MAX = 4000;
const SHORT_MAX = 200;
const MAX_COUNT = 1000;

const counts = new Map<ClientErrorKind, number>(CLIENT_ERROR_KINDS.map((kind) => [kind, 0]));

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Remove query strings and fragments from any URL-looking text: they can carry tokens. */
export function redactUrls(value: string): string {
  return value.replace(/(https?:\/\/[^\s?#)'"]+)[?#][^\s)'"]*/g, '$1');
}

export function parseClientErrorReport(body: unknown, userAgent?: string): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  const kind = CLIENT_ERROR_KINDS.includes(input.kind as ClientErrorKind) ? input.kind as ClientErrorKind : 'error';
  const message = text(input.message, MESSAGE_MAX);
  if (!message) return null;
  const stack = text(input.stack, STACK_MAX);
  const page = text(input.page, SHORT_MAX);
  const rawCount = Number(input.count);
  return {
    kind,
    message: redactUrls(message),
    ...(stack ? { stack: redactUrls(stack) } : {}),
    ...(page ? { page: redactUrls(page) } : {}),
    ...(text(input.release, 64) ? { release: text(input.release, 64) } : {}),
    ...(text(userAgent, SHORT_MAX) ? { userAgent: text(userAgent, SHORT_MAX) } : {}),
    count: Number.isFinite(rawCount) && rawCount >= 1 ? Math.min(Math.floor(rawCount), MAX_COUNT) : 1,
  };
}

export function recordClientError(report: ClientErrorReport, log: (line: string) => void = console.warn): void {
  counts.set(report.kind, (counts.get(report.kind) || 0) + report.count);
  log(JSON.stringify({ event: 'client_error', ...report }));
}

export function getClientErrorCounts(): Record<ClientErrorKind, number> {
  return Object.fromEntries(CLIENT_ERROR_KINDS.map((kind) => [kind, counts.get(kind) || 0])) as Record<ClientErrorKind, number>;
}

export function resetClientErrorCounts(): void {
  for (const kind of CLIENT_ERROR_KINDS) counts.set(kind, 0);
}
