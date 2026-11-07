import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyBandwidthModeToVideoSender,
  buildPeerBandwidthHealth,
  classifyBandwidthPressure,
  createInitialBandwidthAdaptationState,
  findSelectedCandidatePair,
  getMeshScreenSendCap,
  getMeshVideoSendCap,
  readOutboundVideoStatsSnapshot,
  updateBandwidthAdaptationState,
  type OutboundVideoStatsSnapshot,
} from '../src/utils/webrtcBandwidthAdaptation.ts';
import { assessInboundHealth, readInboundStatsSnapshot } from '../src/utils/webrtcInboundHealth.ts';

function snapshot(timestampMs: number, bytesSent: number, packetsSent: number, packetsLost: number, roundTripTimeMs: number): OutboundVideoStatsSnapshot {
  return { timestampMs, bytesSent, packetsSent, packetsLost, roundTripTimeMs, availableOutgoingBitrateKbps: 4000 };
}

describe('long-distance link health', () => {
  it('reads RTT and bandwidth from the candidate pair in use, not a slower backup pair', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1_000, bytesSent: 10_000, packetsSent: 100 }],
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair-udp' }],
      ['pair-udp', { id: 'pair-udp', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.29, availableOutgoingBitrate: 3_000_000 }],
      ['pair-tls', { id: 'pair-tls', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.9, availableOutgoingBitrate: 400_000 }],
    ]);
    const result = readOutboundVideoStatsSnapshot(report, 0);
    assert.equal(result?.roundTripTimeMs, 290);
    assert.equal(result?.availableOutgoingBitrateKbps, 3000);
    assert.equal(findSelectedCandidatePair(report)?.id, 'pair-udp');
  });

  it('adds losses per outbound stream instead of dividing one stream by all of them', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['camera', { id: 'camera', type: 'outbound-rtp', kind: 'video', timestamp: 1_000, bytesSent: 1, packetsSent: 1_000 }],
      ['screen', { id: 'screen', type: 'outbound-rtp', kind: 'video', timestamp: 1_000, bytesSent: 1, packetsSent: 1_000 }],
      ['ri-camera', { type: 'remote-inbound-rtp', kind: 'video', localId: 'camera', packetsLost: 30 }],
      ['ri-screen', { type: 'remote-inbound-rtp', kind: 'video', localId: 'screen', packetsLost: 50 }],
    ]);
    assert.equal(readOutboundVideoStatsSnapshot(report, 0)?.packetsLost, 80);
  });

  it('treats steady high RTT between continents as distance, but a rise above it as congestion', () => {
    const steady = { bitrateKbps: 1500, packetLossRatio: 0.005, roundTripTimeMs: 320, availableOutgoingBitrateKbps: 3000 };
    assert.equal(classifyBandwidthPressure(steady, 300), 'stable');
    assert.equal(classifyBandwidthPressure({ ...steady, roundTripTimeMs: 480 }, 300), 'balanced');
    assert.equal(classifyBandwidthPressure({ ...steady, roundTripTimeMs: 760 }, 300), 'constrained');
    assert.equal(classifyBandwidthPressure({ ...steady, jitterMs: 90 }, 300), 'balanced');

    // A Manila-US call at 330 ms stays at full quality.
    let state = createInitialBandwidthAdaptationState();
    for (let i = 0; i < 6; i++) {
      state = updateBandwidthAdaptationState(state, snapshot(i * 5_000, i * 900_000, i * 800, 0, 330 + (i % 2) * 10));
    }
    assert.equal(state.mode, 'full');
    assert.ok((state.baselineRttMs ?? 0) >= 330 && (state.baselineRttMs ?? 0) <= 340);
    // Queueing on top of it does trigger adaptation.
    state = updateBandwidthAdaptationState(state, snapshot(30_000, 6 * 900_000, 6 * 800, 0, 800));
    assert.equal(state.mode, 'constrained');
  });

  it('grades the media a guest sends us, including audio-only guests and relayed links', () => {
    const stats = (audioReceived: number, audioLost: number, concealed: number, samples: number) => new Map<string, Record<string, unknown>>([
      ['in-audio', { type: 'inbound-rtp', kind: 'audio', timestamp: 0, packetsReceived: audioReceived, packetsLost: audioLost, jitter: 0.012, concealedSamples: concealed, totalSamplesReceived: samples }],
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.31 }],
      ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay' }],
      ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' }],
    ]);
    const first = readInboundStatsSnapshot(stats(1_000, 0, 0, 48_000), 1_000);
    const clean = readInboundStatsSnapshot(stats(1_250, 2, 100, 288_000), 6_000);
    const good = assessInboundHealth(first, clean);
    assert.equal(good.quality, 'good');
    assert.equal(good.audioOnly, true);
    assert.equal(good.relayed, true);
    assert.equal(good.roundTripTimeMs, 310);

    const lossy = readInboundStatsSnapshot(stats(1_450, 40, 30_000, 288_000), 6_000);
    assert.equal(assessInboundHealth(first, lossy).quality, 'poor');

    // Combined badge: we send no video (camera off), but their audio arriving cleanly counts.
    const health = buildPeerBandwidthHealth(createInitialBandwidthAdaptationState(), 10, good);
    assert.equal(health.quality, 'good');
    assert.equal(health.outboundQuality, 'unknown');
    assert.equal(health.inboundQuality, 'good');
    assert.equal(health.relayed, true);
    assert.equal(health.audioOnly, true);

    // Connected with nothing flowing (SFU active): the link is fine, not "warming up" forever.
    const idle = assessInboundHealth(first, readInboundStatsSnapshot(stats(1_000, 0, 0, 48_000), 6_000));
    assert.equal(idle.quality, 'unknown');
    assert.equal(buildPeerBandwidthHealth(createInitialBandwidthAdaptationState(), 10, idle).quality, 'good');
  });

  it('caps what each mesh peer gets as guests are added', () => {
    assert.deepEqual(getMeshVideoSendCap(1), { maxLongEdge: 1920, maxBitrate: 2_500_000, maxFramerate: 30 });
    assert.equal(getMeshVideoSendCap(2).maxLongEdge, 1280);
    assert.equal(getMeshVideoSendCap(3).maxBitrate, 1_500_000);
    assert.ok(getMeshVideoSendCap(5).maxBitrate < getMeshVideoSendCap(4).maxBitrate);
    assert.equal(getMeshScreenSendCap(2, 'text').maxFramerate, 15);
    assert.equal(getMeshScreenSendCap(2, 'motion').maxFramerate, 30);
  });

  it('scales a 1080p camera down to 720p for a three-guest mesh', async () => {
    let applied: RTCRtpSendParameters | null = null;
    const sender = {
      track: { kind: 'video', readyState: 'live', getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) },
      getParameters: () => ({ encodings: [{ rid: 'h', maxBitrate: 2_800_000, scaleResolutionDownBy: 1 }] }),
      setParameters: async (parameters: RTCRtpSendParameters) => { applied = parameters; },
    } as unknown as RTCRtpSender;
    assert.equal(await applyBandwidthModeToVideoSender(sender, 'full', getMeshVideoSendCap(3)), true);
    const encoding = (applied as unknown as RTCRtpSendParameters).encodings[0];
    assert.equal(encoding.scaleResolutionDownBy, 1.5);
    assert.equal(encoding.maxBitrate, 1_500_000);
    assert.equal(encoding.maxFramerate, 30);
  });
});
