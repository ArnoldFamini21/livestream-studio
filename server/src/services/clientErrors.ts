import { createHash } from 'node:crypto';
import {
  CLIENT_ERROR_KINDS,
  sanitizeClientErrorMessage,
  sanitizeClientErrorPage,
  sanitizeClientErrorRelease,
  sanitizeClientErrorStack,
  type ClientErrorKind,
} from '@studio/shared';

export { CLIENT_ERROR_KINDS, type ClientErrorKind } from '@studio/shared';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  page?: string;
  release?: string;
  count: number;
}

export function parseClientErrorReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const message = sanitizeClientErrorMessage(input.message);
  if (!message) return null;
  const count = typeof input.count === 'number' ? input.count : 1;
  return {
    kind: CLIENT_ERROR_KINDS.includes(input.kind as ClientErrorKind) ? input.kind as ClientErrorKind : 'error',
    message,
    stack: sanitizeClientErrorStack(input.stack),
    page: sanitizeClientErrorPage(input.page),
    release: sanitizeClientErrorRelease(input.release),
    count: Number.isFinite(count) && count >= 1 ? Math.min(Math.floor(count), 1000) : 1,
  };
}

interface ErrorGroup {
  report: ClientErrorReport;
  fingerprint: string;
  firstSeen: number;
  lastSeen: number;
  total: number;
  pending: number;
}

interface TrackerOptions {
  now?: () => number;
  log?: (line: string) => void;
  maxGroups?: number;
  retentionMs?: number;
  maxLogsPerMinute?: number;
}

/** Bounded, process-local aggregation; only sanitized fields enter this store. */
export function createClientErrorTracker(options: TrackerOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? console.warn;
  const maxGroups = options.maxGroups ?? 128;
  const retentionMs = options.retentionMs ?? 15 * 60_000;
  const maxLogsPerMinute = options.maxLogsPerMinute ?? 120;
  const groups = new Map<string, ErrorGroup>();
  const counts = new Map<ClientErrorKind, number>(CLIENT_ERROR_KINDS.map((kind) => [kind, 0]));
  let logWindow = now();
  let logCount = 0;

  const emit = (group: ErrorGroup, at: number) => {
    if (group.pending === 0) return;
    if (at - logWindow >= 60_000) { logWindow = at; logCount = 0; }
    if (logCount >= maxLogsPerMinute) return;
    logCount += 1;
    try {
      log(JSON.stringify({
        event: 'client_error',
        ...group.report,
        fingerprint: group.fingerprint,
        count: group.pending,
        total: group.total,
        firstSeen: new Date(group.firstSeen).toISOString(),
        lastSeen: new Date(group.lastSeen).toISOString(),
      }));
      group.pending = 0;
    } catch { /* Diagnostics must never break error intake. */ }
  };

  return {
    record(input: unknown) {
      const report = parseClientErrorReport(input);
      if (!report) return;
      const at = now();
      counts.set(report.kind, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(report.kind) ?? 0) + report.count));
      // Release is separate from the fingerprint so operators can compare the
      // same fault across deploys without combining occurrence totals.
      const fingerprint = createHash('sha256').update(JSON.stringify([report.kind, report.message, report.stack ?? ''])).digest('hex').slice(0, 24);
      const key = `${report.release ?? 'unknown'}:${fingerprint}`;
      let group = groups.get(key);
      if (group && at - group.lastSeen >= retentionMs) {
        emit(group, at);
        groups.delete(key);
        group = undefined;
      }
      if (!group) {
        if (groups.size >= maxGroups) {
          const oldest = groups.keys().next().value as string;
          emit(groups.get(oldest)!, at);
          groups.delete(oldest);
        }
        group = { report, fingerprint, firstSeen: at, lastSeen: at, total: report.count, pending: report.count };
        groups.set(key, group);
        emit(group, at);
      } else {
        group.total = Math.min(Number.MAX_SAFE_INTEGER, group.total + report.count);
        group.pending = Math.min(Number.MAX_SAFE_INTEGER, group.pending + report.count);
        group.lastSeen = at;
        groups.delete(key);
        groups.set(key, group);
      }
    },
    flush() {
      const at = now();
      for (const [key, group] of groups) {
        emit(group, at);
        if (at - group.lastSeen >= retentionMs) groups.delete(key);
      }
    },
    counts(): Record<ClientErrorKind, number> {
      return Object.fromEntries(counts) as Record<ClientErrorKind, number>;
    },
    groupCount: () => groups.size,
    reset() {
      groups.clear();
      for (const kind of CLIENT_ERROR_KINDS) counts.set(kind, 0);
      logCount = 0;
      logWindow = now();
    },
  };
}

const tracker = createClientErrorTracker();
export const recordClientError = tracker.record;
export const flushClientErrors = tracker.flush;
export const getClientErrorCounts = tracker.counts;
export const resetClientErrorCounts = tracker.reset;
