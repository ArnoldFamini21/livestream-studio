/**
 * Session health as one plain status. An average of all checks hid real
 * blockers (no mic and no camera could still score "Ready"), so any blocked
 * essential check decides the status and names itself in the label.
 */

export type HealthStatus = 'good' | 'warning' | 'bad';
export type HealthAudience = 'operator' | 'guest';

export interface HealthCheckLike {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthCheckSummary {
  status: HealthStatus;
  /** Short label for the header pill, e.g. "Good", "Check mic", "Offline". */
  label: string;
  /** Average of the checks, 0-100, kept for the detail panel. */
  score: number;
  /** The check that decided a non-good status, if one did. */
  focusCheckId: string | null;
}

/** Without these the person cannot take part: never averaged away. In priority order. */
export const CRITICAL_HEALTH_CHECK_IDS = ['signaling', 'network', 'browser-media', 'audio', 'video'] as const;

/** Production plumbing a guest cannot act on (and should not be alarmed by). */
export const OPERATOR_ONLY_HEALTH_CHECK_IDS = new Set([
  'turn-relay',
  'media-server',
  'encoding',
  'capacity',
  'storage',
  'participant-connections',
  'production-state',
]);

const CRITICAL_LABELS: Record<(typeof CRITICAL_HEALTH_CHECK_IDS)[number], { bad: string; warning: string }> = {
  signaling: { bad: 'Not connected', warning: 'Reconnecting' },
  network: { bad: 'Offline', warning: 'Weak network' },
  'browser-media': { bad: 'Browser unsupported', warning: 'Check browser' },
  audio: { bad: 'Check mic', warning: 'Check mic' },
  video: { bad: 'Check camera', warning: 'Check camera' },
};

const SECONDARY_LABELS: Record<string, string> = {
  'turn-relay': 'Check relay',
  'media-server': 'Media server',
  encoding: 'Check encoder',
  storage: 'Low storage',
  capacity: 'Many guests',
  'participant-connections': 'Guest connection',
  'production-state': 'Output at risk',
  'media-error': 'Check devices',
};

export function scoreForHealthStatus(status: HealthStatus): number {
  switch (status) {
    case 'good': return 100;
    case 'warning': return 58;
    case 'bad': return 0;
  }
}

function statusFromScore(score: number): HealthStatus {
  if (score >= 80) return 'good';
  if (score >= 50) return 'warning';
  return 'bad';
}

export function filterHealthChecksForAudience<T extends HealthCheckLike>(checks: T[], audience: HealthAudience): T[] {
  if (audience === 'operator') return checks;
  return checks.filter((check) => !OPERATOR_ONLY_HEALTH_CHECK_IDS.has(check.id));
}

export function summarizeHealthChecks(checks: HealthCheckLike[], audience: HealthAudience = 'operator'): HealthCheckSummary {
  const visible = filterHealthChecksForAudience(checks, audience);
  const score = visible.length
    ? Math.round(visible.reduce((sum, check) => sum + scoreForHealthStatus(check.status), 0) / visible.length)
    : 100;
  const byId = new Map(visible.map((check) => [check.id, check]));

  for (const level of ['bad', 'warning'] as const) {
    for (const id of CRITICAL_HEALTH_CHECK_IDS) {
      if (byId.get(id)?.status === level) {
        return { status: level, label: CRITICAL_LABELS[id][level], score, focusCheckId: id };
      }
    }
  }

  const averaged = statusFromScore(score);
  if (averaged === 'good') {
    return { status: 'good', label: audience === 'guest' ? 'All set' : 'Good', score, focusCheckId: null };
  }
  // A non-essential problem: name the worst one for operators; guests just get a nudge.
  const worst = visible.find((check) => check.status === 'bad') || visible.find((check) => check.status === 'warning') || null;
  const label = audience === 'guest'
    ? 'Check setup'
    : (worst && SECONDARY_LABELS[worst.id]) || 'Needs attention';
  return { status: averaged === 'bad' ? 'bad' : 'warning', label, score, focusCheckId: worst?.id ?? null };
}
