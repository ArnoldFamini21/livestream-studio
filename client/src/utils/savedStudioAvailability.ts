/**
 * What a saved studio card should say, given what the studio server reported
 * when the workspace synced. Studios live in the free server's memory, so a
 * restart can forget one the browser still remembers; the card must not keep
 * saying "Ready" and "Enter studio" for it.
 */

export type SavedStudioAvailabilityKind = 'ready' | 'upcoming' | 'ended' | 'unavailable' | 'unchecked';

export interface SavedStudioAvailability {
  kind: SavedStudioAvailabilityKind;
  label: string;
  /** Whether "Enter studio" can work; otherwise offer Recreate / Remove. */
  canEnter: boolean;
}

export interface StudioSyncIssues {
  /** The server answered: no such studio, or not yours (forgotten after a restart, or ended). */
  rejectedStudioIds: ReadonlySet<string>;
  /** The server could not be asked about these. */
  failedStudioIds: ReadonlySet<string>;
}

export const NO_STUDIO_SYNC_ISSUES: StudioSyncIssues = {
  rejectedStudioIds: new Set(),
  failedStudioIds: new Set(),
};

export function getSavedStudioAvailability(
  studio: { id: string; scheduledFor?: string; status?: string },
  issues: StudioSyncIssues,
  nowMs = Date.now()
): SavedStudioAvailability {
  if (issues.rejectedStudioIds.has(studio.id)) return { kind: 'unavailable', label: 'Unavailable', canEnter: false };
  if (studio.status === 'ended') return { kind: 'ended', label: 'Ended', canEnter: false };
  if (issues.failedStudioIds.has(studio.id)) return { kind: 'unchecked', label: "Couldn't check", canEnter: true };
  const scheduledAt = studio.scheduledFor ? Date.parse(studio.scheduledFor) : NaN;
  if (Number.isFinite(scheduledAt) && scheduledAt > nowMs) return { kind: 'upcoming', label: 'Upcoming', canEnter: true };
  return { kind: 'ready', label: 'Ready', canEnter: true };
}

function joinNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted[0] || '';
  if (quoted.length <= 3) return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
  return `${quoted.slice(0, 2).join(', ')} and ${quoted.length - 2} more`;
}

/** The workspace banner, naming the affected studios. Null when nothing is wrong. */
export function describeStudioSyncIssues(
  studios: Array<{ id: string; name: string }>,
  issues: StudioSyncIssues
): string | null {
  const rejected = studios.filter((studio) => issues.rejectedStudioIds.has(studio.id)).map((studio) => studio.name);
  const failed = studios
    .filter((studio) => issues.failedStudioIds.has(studio.id) && !issues.rejectedStudioIds.has(studio.id))
    .map((studio) => studio.name);
  const parts: string[] = [];
  if (rejected.length > 0) {
    parts.push(`${joinNames(rejected)} ${rejected.length === 1 ? 'is' : 'are'} no longer on the studio server (free hosting restarts can clear studios). Recreate or remove ${rejected.length === 1 ? 'it' : 'them'}.`);
  }
  if (failed.length > 0) {
    parts.push(`Couldn't check ${joinNames(failed)} right now; ${failed.length === 1 ? 'it' : 'they'} may still work.`);
  }
  return parts.length ? parts.join(' ') : null;
}
