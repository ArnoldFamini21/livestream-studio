import type { StreamDestination } from '@studio/shared';
import { buildLivePreflightChecklist, type LivePreflightSessionHealth } from './livePreflight.ts';
import { getEnabledDestinationPreflightIssue, getStreamDestinationIssue } from './streamDestinations.ts';
import { formatHeldCountdown, type HeldWatchState } from './heldBroadcastState.ts';

/**
 * What the host sees at the top of the studio while a broadcast waits on the
 * slate. Decided here, from the media server's answer (through the watch
 * state), the destinations the host has now, and whether Go Live would be
 * allowed right now. The studio only draws it.
 */

export const HELD_ON_AIR_TEXT = 'Your broadcast is still on the air. Viewers see the "be right back" screen.';
export const HELD_ENDED_TEXT = 'The broadcast ended. Press Go Live to start a new one.';

export type HeldBannerAction = 'continue' | 'open-destinations' | 'dismiss';

export interface HeldBannerView {
  kind: 'continue' | 'needs-key' | 'needs-destination' | 'blocked' | 'ended';
  /** The whole sentence(s), ready to show. */
  message: string;
  /** A second, smaller line (a warning or the reason the button is off). */
  note: string | null;
  buttonLabel: string;
  action: HeldBannerAction;
  buttonDisabled: boolean;
  /** Screen readers hear the change when the broadcast ends; the countdown itself stays quiet. */
  urgent: boolean;
}

type DestinationForBanner = Pick<StreamDestination, 'name' | 'enabled' | 'rtmpUrl' | 'streamKey'>;

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(normalizeName).sort();
  const right = b.map(normalizeName).sort();
  return left.every((name, index) => name === right[index]);
}

function joinNames(names: string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return 'the destination';
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

export function decideHeldBanner(options: {
  watch: HeldWatchState;
  isHost: boolean;
  isLive: boolean;
  destinations: DestinationForBanner[];
  /** Why Go Live is not allowed right now (the same checks as the button), or null. */
  goLiveBlocker: string | null;
  /** Continue was pressed and the broadcast is starting. */
  starting: boolean;
}): HeldBannerView | null {
  const { watch, destinations } = options;
  // Only the host can continue; once live, by any path, there is nothing to say.
  if (!options.isHost || options.isLive) return null;
  if (watch.phase === 'ended') {
    return {
      kind: 'ended',
      message: HELD_ENDED_TEXT,
      note: null,
      buttonLabel: 'Dismiss',
      action: 'dismiss',
      buttonDisabled: false,
      urgent: true,
    };
  }
  if (watch.phase !== 'held') return null;

  const within = `Continue within ${formatHeldCountdown(watch.secondsLeft)}.`;
  const heldNames = watch.destinations.map((destination) => destination.name);
  const heldNameSet = new Set(heldNames.map(normalizeName));

  // A remembered destination comes back without its key; the key is never stored.
  const missingKey = destinations.filter((destination) => (
    !destination.streamKey.trim() && (destination.enabled || heldNameSet.has(normalizeName(destination.name)))
  ));
  if (missingKey.length > 0) {
    return {
      kind: 'needs-key',
      message: `${HELD_ON_AIR_TEXT} Paste the stream key for ${joinNames(missingKey.map((d) => d.name))} first, then continue within ${formatHeldCountdown(watch.secondsLeft)}.`,
      note: null,
      buttonLabel: 'Open destinations',
      action: 'open-destinations',
      buttonDisabled: false,
      urgent: false,
    };
  }

  const enabled = destinations.filter((destination) => destination.enabled);
  if (enabled.length === 0) {
    return {
      kind: 'needs-destination',
      message: `${HELD_ON_AIR_TEXT} Switch on the places to stream to first. ${within}`,
      note: null,
      buttonLabel: 'Open destinations',
      action: 'open-destinations',
      buttonDisabled: false,
      urgent: false,
    };
  }

  const destinationIssue = enabled.map((destination) => getStreamDestinationIssue(destination)).find(Boolean) || null;
  const mismatch = heldNames.length > 0 && !sameNames(heldNames, enabled.map((destination) => destination.name));
  const note = options.goLiveBlocker
    || (mismatch ? 'These are not the places the broadcast is on now, so pressing the button would start a new broadcast instead of continuing it.' : null);
  if (destinationIssue || options.goLiveBlocker) {
    return {
      kind: 'blocked',
      message: `${HELD_ON_AIR_TEXT} ${within}`,
      note: options.goLiveBlocker || destinationIssue,
      buttonLabel: 'Continue broadcast',
      action: 'continue',
      buttonDisabled: true,
      urgent: false,
    };
  }
  return {
    kind: 'continue',
    message: `${HELD_ON_AIR_TEXT} ${within}`,
    note,
    buttonLabel: options.starting ? 'Continuing…' : 'Continue broadcast',
    action: 'continue',
    buttonDisabled: options.starting,
    urgent: false,
  };
}

function getRelayIssue(readiness: { status: 'checking' | 'ready' | 'unavailable'; message: string } | undefined): string | null {
  if (!readiness) return 'Media relay readiness has not been checked.';
  if (readiness.status === 'ready') return null;
  if (readiness.status === 'checking') return 'Media relay readiness check is still running.';
  return readiness.message;
}

/**
 * Why the Go Live button would be off right now, or null when it is on. The
 * same rule as the destinations panel (its "Ready to stream"): the Continue
 * button must never allow what Go Live refuses.
 */
export function getGoLiveBlocker(options: {
  destinations: StreamDestination[];
  relayReadiness: { status: 'checking' | 'ready' | 'unavailable'; message: string } | undefined;
  sessionHealth: LivePreflightSessionHealth | undefined;
  sceneCount: number;
}): string | null {
  const checklist = buildLivePreflightChecklist({
    destinations: options.destinations,
    relayReadiness: options.relayReadiness,
    sessionHealth: options.sessionHealth,
    sceneCount: options.sceneCount,
    outputSummary: '',
  });
  return checklist.blockingIssue
    || getEnabledDestinationPreflightIssue(options.destinations, getRelayIssue(options.relayReadiness));
}
