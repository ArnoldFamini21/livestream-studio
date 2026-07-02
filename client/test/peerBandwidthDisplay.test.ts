import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatPeerBandwidthHealthTitle,
  formatPeerBandwidthQualityLabel,
} from '../src/utils/peerBandwidthDisplay.ts';
import type { PeerBandwidthHealth } from '../src/utils/webrtcBandwidthAdaptation.ts';

function health(input: Partial<PeerBandwidthHealth> = {}): PeerBandwidthHealth {
  return {
    mode: input.mode ?? 'balanced',
    quality: input.quality ?? 'fair',
    bitrateKbps: 'bitrateKbps' in input ? input.bitrateKbps ?? null : 1850,
    packetLossPercent: 'packetLossPercent' in input ? input.packetLossPercent ?? null : 2.5,
    roundTripTimeMs: 'roundTripTimeMs' in input ? input.roundTripTimeMs ?? null : 220,
    availableOutgoingBitrateKbps:
      'availableOutgoingBitrateKbps' in input ? input.availableOutgoingBitrateKbps ?? null : 3100,
    updatedAtMs: input.updatedAtMs ?? 123,
  };
}

describe('peer bandwidth display helpers', () => {
  it('formats compact quality labels for stage and people badges', () => {
    assert.equal(formatPeerBandwidthQualityLabel(health({ quality: 'good' })), 'Good');
    assert.equal(formatPeerBandwidthQualityLabel(health({ quality: 'fair' })), 'Fair');
    assert.equal(formatPeerBandwidthQualityLabel(health({ quality: 'poor' })), 'Poor');
    assert.equal(formatPeerBandwidthQualityLabel(health({ quality: 'unknown' })), 'Link');
  });

  it('formats bounded tooltip details without null metrics', () => {
    assert.equal(
      formatPeerBandwidthHealthTitle(health()),
      'Mode: balanced | Video: 1850 kbps | RTT: 220 ms | Loss: 2.5% | Available: 3100 kbps'
    );
    assert.equal(
      formatPeerBandwidthHealthTitle(health({
        mode: 'full',
        quality: 'unknown',
        bitrateKbps: null,
        packetLossPercent: null,
        roundTripTimeMs: null,
        availableOutgoingBitrateKbps: null,
      })),
      'Mode: full'
    );
  });
});
