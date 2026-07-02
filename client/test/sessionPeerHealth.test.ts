import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSessionPeerHealthSummary, type SessionPeerHealthParticipant } from '../src/utils/sessionPeerHealth.ts';
import type { PeerBandwidthHealth, PeerBandwidthQuality } from '../src/utils/webrtcBandwidthAdaptation.ts';

function health(quality: PeerBandwidthQuality): PeerBandwidthHealth {
  return {
    quality,
    mode: quality === 'poor' ? 'constrained' : quality === 'fair' ? 'balanced' : 'full',
    bitrateKbps: quality === 'poor' ? 420 : quality === 'fair' ? 1400 : 3200,
    packetLossPercent: quality === 'poor' ? 9 : quality === 'fair' ? 4 : 0.4,
    roundTripTimeMs: quality === 'poor' ? 820 : quality === 'fair' ? 430 : 80,
    availableOutgoingBitrateKbps: quality === 'poor' ? 600 : quality === 'fair' ? 1500 : 5200,
    updatedAtMs: 123,
  };
}

function participant(input: Partial<SessionPeerHealthParticipant> = {}): SessionPeerHealthParticipant {
  return {
    id: input.id ?? 'guest-1',
    name: input.name ?? 'Guest',
    status: input.status ?? 'on-stage',
    isLocal: input.isLocal ?? false,
    health: input.health === undefined ? health('good') : input.health,
  };
}

describe('session peer health summary', () => {
  it('reports ready when there are no remote production guests', () => {
    const summary = buildSessionPeerHealthSummary([
      participant({ id: 'host', name: 'Host', isLocal: true }),
      participant({ id: 'waiting', name: 'Waiting Guest', status: 'green-room', health: health('poor') }),
    ]);

    assert.equal(summary.status, 'good');
    assert.equal(summary.remoteCount, 0);
    assert.equal(summary.detail, 'No remote guests are currently on stage or backstage.');
  });

  it('blocks production readiness when any on-stage or backstage guest is poor', () => {
    const summary = buildSessionPeerHealthSummary([
      participant({ id: 'a', name: 'Ari', health: health('good') }),
      participant({ id: 'b', name: 'Blake', status: 'backstage', health: health('poor') }),
      participant({ id: 'c', name: 'Casey', health: health('fair') }),
    ]);

    assert.equal(summary.status, 'bad');
    assert.equal(summary.label, 'Guest link blocked');
    assert.equal(summary.remoteCount, 3);
    assert.equal(summary.goodCount, 1);
    assert.equal(summary.poorCount, 1);
    assert.deepEqual(summary.poorNames, ['Blake']);
    assert.match(summary.detail, /Blake/);
  });

  it('warns for fair or missing telemetry and ignores green-room guests', () => {
    const fairSummary = buildSessionPeerHealthSummary([
      participant({ id: 'a', name: 'Ari', health: health('fair') }),
      participant({ id: 'b', name: 'Blake', status: 'green-room', health: health('poor') }),
    ]);
    assert.equal(fairSummary.status, 'warning');
    assert.equal(fairSummary.fairCount, 1);
    assert.equal(fairSummary.poorCount, 0);

    const unknownSummary = buildSessionPeerHealthSummary([
      participant({ id: 'c', name: 'Casey', health: null }),
    ]);
    assert.equal(unknownSummary.status, 'warning');
    assert.equal(unknownSummary.unknownCount, 1);
    assert.equal(unknownSummary.measuredCount, 0);
    assert.match(unknownSummary.detail, /Casey/);
  });
});
