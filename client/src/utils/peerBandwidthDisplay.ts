import type { PeerBandwidthHealth } from './webrtcBandwidthAdaptation.ts';

export function formatPeerBandwidthQualityLabel(health: PeerBandwidthHealth): string {
  switch (health.quality) {
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'poor':
      return 'Poor';
    default:
      return 'Link';
  }
}

export function formatPeerBandwidthHealthTitle(health: PeerBandwidthHealth): string {
  const details = [
    `Mode: ${health.mode}`,
    health.bitrateKbps !== null ? `Video: ${health.bitrateKbps} kbps` : null,
    health.roundTripTimeMs !== null ? `RTT: ${health.roundTripTimeMs} ms` : null,
    health.packetLossPercent !== null ? `Loss: ${health.packetLossPercent}%` : null,
    health.availableOutgoingBitrateKbps !== null ? `Available: ${health.availableOutgoingBitrateKbps} kbps` : null,
  ].filter(Boolean);

  return details.join(' | ');
}
