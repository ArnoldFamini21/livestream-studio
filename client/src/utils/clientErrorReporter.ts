/**
 * Sends browser errors to the signaling server's `/api/client-errors` so a
 * failed go-live or crashed studio is visible to the operator, not only in
 * the host's console. Repeats of the same error are folded into one report
 * with a count, each page load has a report budget, and known browser noise
 * is ignored.
 */

import { resolveApiBaseUrl } from './apiClient.ts';

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'react' | 'media' | 'stream' | 'recording';

export interface ClientErrorPayload {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  page?: string;
  release?: string;
  count: number;
}

export interface ClientErrorReporterOptions {
  send: (payload: ClientErrorPayload) => void;
  release?: string;
  getPage?: () => string | undefined;
  now?: () => number;
  /** Identical errors inside this window are counted instead of re-sent. */
  dedupeWindowMs?: number;
  /** Most reports one page load may send. */
  maxReports?: number;
}

export interface ClientErrorReporter {
  report: (kind: ClientErrorKind, error: unknown) => boolean;
  /** Send counts for repeats still waiting in the dedupe window. */
  flush: () => void;
}

const IGNORED_MESSAGES = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /AbortError/i,
  /The play\(\) request was interrupted/i,
];
const IGNORED_STACK_SOURCES = /(chrome|moz|safari(-web)?)-extension:\/\//i;

export function describeClientError(error: unknown): { message: string; stack?: string } | null {
  if (error instanceof Error) {
    return { message: `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`.trim(), stack: error.stack };
  }
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return { message: (error as { message: string }).message };
  }
  if (error === undefined || error === null) return null;
  try {
    return { message: JSON.stringify(error).slice(0, 500) };
  } catch {
    return { message: String(error) };
  }
}

export function isIgnoredClientError(message: string, stack?: string): boolean {
  if (!message.trim()) return true;
  if (IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return true;
  return Boolean(stack && IGNORED_STACK_SOURCES.test(stack));
}

export function createClientErrorReporter(options: ClientErrorReporterOptions): ClientErrorReporter {
  const now = options.now ?? (() => Date.now());
  const dedupeWindowMs = options.dedupeWindowMs ?? 60_000;
  const maxReports = options.maxReports ?? 20;
  const recent = new Map<string, { sentAt: number; pending: number; payload: ClientErrorPayload }>();
  let sent = 0;

  const send = (payload: ClientErrorPayload): boolean => {
    if (sent >= maxReports) return false;
    sent += 1;
    try {
      options.send(payload);
    } catch {
      // Reporting must never throw into the studio.
    }
    return true;
  };

  const flushEntry = (key: string, at: number) => {
    const entry = recent.get(key);
    if (!entry) return;
    if (entry.pending > 0) send({ ...entry.payload, count: entry.pending });
    if (at - entry.sentAt >= dedupeWindowMs) recent.delete(key);
    else entry.pending = 0;
  };

  return {
    report(kind, error) {
      const described = describeClientError(error);
      if (!described || isIgnoredClientError(described.message, described.stack)) return false;
      const at = now();
      const key = `${kind}:${described.message}`;
      const existing = recent.get(key);
      if (existing && at - existing.sentAt < dedupeWindowMs) {
        existing.pending += 1;
        return false;
      }
      if (existing) flushEntry(key, at);
      const payload: ClientErrorPayload = {
        kind,
        message: described.message,
        ...(described.stack ? { stack: described.stack } : {}),
        ...(options.getPage?.() ? { page: options.getPage?.() } : {}),
        ...(options.release ? { release: options.release } : {}),
        count: 1,
      };
      const delivered = send(payload);
      if (delivered) recent.set(key, { sentAt: at, pending: 0, payload });
      return delivered;
    },
    flush() {
      const at = now();
      for (const key of Array.from(recent.keys())) flushEntry(key, at);
    },
  };
}

function beaconSend(url: string) {
  return (payload: ClientErrorPayload) => {
    const body = JSON.stringify(payload);
    // text/plain keeps sendBeacon a simple CORS request (no preflight).
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return;
    }
    void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {});
  };
}

let installed: ClientErrorReporter | null = null;

/** Report an error the app caught itself (for example a failed go-live). */
export function reportClientError(kind: ClientErrorKind, error: unknown): void {
  installed?.report(kind, error);
}

/**
 * Install global handlers once. Only production builds report, unless
 * VITE_CLIENT_ERROR_REPORTING is "true" (or "false" to opt out).
 */
export function installClientErrorReporting(): ClientErrorReporter | null {
  if (installed || typeof window === 'undefined') return installed;
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
  const flag = String(env.VITE_CLIENT_ERROR_REPORTING ?? '').toLowerCase();
  if (flag === 'false' || (!env.PROD && flag !== 'true')) return null;

  const reporter = createClientErrorReporter({
    send: beaconSend(`${resolveApiBaseUrl()}/api/client-errors`),
    release: typeof env.VITE_RELEASE === 'string' ? env.VITE_RELEASE : undefined,
    // Path only: query strings and fragments can carry invite tokens.
    getPage: () => window.location.pathname,
  });
  window.addEventListener('error', (event) => {
    reporter.report('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reporter.report('unhandledrejection', event.reason);
  });
  window.addEventListener('pagehide', () => reporter.flush());
  installed = reporter;
  return reporter;
}
