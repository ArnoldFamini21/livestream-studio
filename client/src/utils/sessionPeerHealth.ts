import type { ParticipantStatus } from '@studio/shared';
import type { PeerBandwidthHealth } from './webrtcBandwidthAdaptation.ts';

export type SessionPeerHealthStatus = 'good' | 'warning' | 'bad';

export interface SessionPeerHealthParticipant {
  id: string;
  name: string;
  status: ParticipantStatus;
  isLocal?: boolean;
  health?: PeerBandwidthHealth | null;
}

export interface SessionPeerHealthSummary {
  status: SessionPeerHealthStatus;
  label: string;
  detail: string;
  remoteCount: number;
  measuredCount: number;
  goodCount: number;
  fairCount: number;
  poorCount: number;
  unknownCount: number;
  poorNames: string[];
  fairNames: string[];
  unknownNames: string[];
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function formatNames(names: string[]): string {
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

export function buildSessionPeerHealthSummary(
  participants: SessionPeerHealthParticipant[]
): SessionPeerHealthSummary {
  const productionPeers = participants.filter((participant) => (
    !participant.isLocal && (participant.status === 'on-stage' || participant.status === 'backstage')
  ));

  const summary: SessionPeerHealthSummary = {
    status: 'good',
    label: 'Guest links ready',
    detail: 'No remote guests are currently on stage or backstage.',
    remoteCount: productionPeers.length,
    measuredCount: 0,
    goodCount: 0,
    fairCount: 0,
    poorCount: 0,
    unknownCount: 0,
    poorNames: [],
    fairNames: [],
    unknownNames: [],
  };

  for (const participant of productionPeers) {
    const quality = participant.health?.quality ?? 'unknown';
    if (quality !== 'unknown') summary.measuredCount += 1;

    if (quality === 'good') {
      summary.goodCount += 1;
    } else if (quality === 'fair') {
      summary.fairCount += 1;
      summary.fairNames.push(participant.name);
    } else if (quality === 'poor') {
      summary.poorCount += 1;
      summary.poorNames.push(participant.name);
    } else {
      summary.unknownCount += 1;
      summary.unknownNames.push(participant.name);
    }
  }

  if (summary.remoteCount === 0) {
    return summary;
  }

  if (summary.poorCount > 0) {
    return {
      ...summary,
      status: 'bad',
      label: 'Guest link blocked',
      detail: `Poor guest connection detected for ${formatNames(summary.poorNames)}.`,
    };
  }

  if (summary.fairCount > 0) {
    return {
      ...summary,
      status: 'warning',
      label: 'Guest link review',
      detail: `Review guest connection for ${formatNames(summary.fairNames)}.`,
    };
  }

  if (summary.unknownCount > 0) {
    return {
      ...summary,
      status: 'warning',
      label: 'Guest link warming up',
      detail: `Waiting for WebRTC telemetry from ${formatNames(summary.unknownNames)}.`,
    };
  }

  return {
    ...summary,
    detail: `${formatCount(summary.goodCount, 'remote guest link')} stable.`,
  };
}
