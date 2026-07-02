import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyBandwidthModeToVideoSender,
  calculateOutboundVideoStatsDelta,
  classifyBandwidthPressure,
  createInitialBandwidthAdaptationState,
  readOutboundVideoStatsSnapshot,
  updateBandwidthAdaptationState,
  type OutboundVideoStatsSnapshot,
} from '../src/utils/webrtcBandwidthAdaptation.ts';

function snapshot(input: Partial<OutboundVideoStatsSnapshot>): OutboundVideoStatsSnapshot {
  return {
    timestampMs: input.timestampMs ?? 0,
    bytesSent: input.bytesSent ?? 0,
    packetsSent: input.packetsSent ?? null,
    packetsLost: input.packetsLost ?? null,
    roundTripTimeMs: input.roundTripTimeMs ?? null,
    availableOutgoingBitrateKbps: input.availableOutgoingBitrateKbps ?? null,
  };
}

function fakeVideoTrack(settings: MediaTrackSettings = { width: 1920, height: 1080, frameRate: 30 }): MediaStreamTrack {
  return {
    kind: 'video',
    readyState: 'live',
    getSettings: () => settings,
  } as MediaStreamTrack;
}

describe('WebRTC bandwidth adaptation', () => {
  it('reads outbound video, remote inbound, and selected candidate-pair stats', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['outbound-video', {
        type: 'outbound-rtp',
        kind: 'video',
        timestamp: 1_000,
        bytesSent: 1_500_000,
        packetsSent: 12_000,
      }],
      ['outbound-audio', {
        type: 'outbound-rtp',
        kind: 'audio',
        timestamp: 1_000,
        bytesSent: 99_999_999,
      }],
      ['remote-inbound-video', {
        type: 'remote-inbound-rtp',
        kind: 'video',
        packetsLost: 240,
        roundTripTime: 0.42,
      }],
      ['candidate', {
        type: 'candidate-pair',
        selected: true,
        currentRoundTripTime: 0.38,
        availableOutgoingBitrate: 1_250_000,
      }],
    ]);

    const result = readOutboundVideoStatsSnapshot(report, 900);

    assert.deepEqual(result, {
      timestampMs: 1_000,
      bytesSent: 1_500_000,
      packetsSent: 12_000,
      packetsLost: 240,
      roundTripTimeMs: 420,
      availableOutgoingBitrateKbps: 1250,
    });
  });

  it('calculates bitrate and classifies pressure from packet loss, RTT, and outgoing bitrate', () => {
    const delta = calculateOutboundVideoStatsDelta(
      snapshot({ timestampMs: 1_000, bytesSent: 100_000, packetsSent: 1_000, packetsLost: 10 }),
      snapshot({
        timestampMs: 6_000,
        bytesSent: 1_100_000,
        packetsSent: 1_900,
        packetsLost: 95,
        roundTripTimeMs: 820,
        availableOutgoingBitrateKbps: 700,
      })
    );

    assert.equal(delta.bitrateKbps, 1600);
    assert.equal(Math.round((delta.packetLossRatio ?? 0) * 1000) / 1000, 0.086);
    assert.equal(classifyBandwidthPressure(delta), 'constrained');
    assert.equal(classifyBandwidthPressure({
      bitrateKbps: 2600,
      packetLossRatio: 0.04,
      roundTripTimeMs: 440,
      availableOutgoingBitrateKbps: 1400,
    }), 'balanced');
    assert.equal(classifyBandwidthPressure({
      bitrateKbps: 3200,
      packetLossRatio: 0.005,
      roundTripTimeMs: 95,
      availableOutgoingBitrateKbps: 5000,
    }), 'stable');
  });

  it('drops immediately under pressure and restores quality only after stable samples', () => {
    let state = createInitialBandwidthAdaptationState();
    state = updateBandwidthAdaptationState(state, snapshot({
      timestampMs: 1_000,
      bytesSent: 100_000,
      packetsSent: 1_000,
      packetsLost: 0,
      roundTripTimeMs: 120,
      availableOutgoingBitrateKbps: 5000,
    }));

    state = updateBandwidthAdaptationState(state, snapshot({
      timestampMs: 6_000,
      bytesSent: 250_000,
      packetsSent: 1_600,
      packetsLost: 80,
      roundTripTimeMs: 820,
      availableOutgoingBitrateKbps: 700,
    }));

    assert.equal(state.mode, 'constrained');

    for (let index = 0; index < 3; index += 1) {
      state = updateBandwidthAdaptationState(state, snapshot({
        timestampMs: 11_000 + index * 5_000,
        bytesSent: 1_500_000 + index * 1_500_000,
        packetsSent: 2_500 + index * 1_000,
        packetsLost: 80,
        roundTripTimeMs: 100,
        availableOutgoingBitrateKbps: 5000,
      }));
    }

    assert.equal(state.mode, 'balanced');

    for (let index = 0; index < 3; index += 1) {
      state = updateBandwidthAdaptationState(state, snapshot({
        timestampMs: 31_000 + index * 5_000,
        bytesSent: 5_000_000 + index * 1_500_000,
        packetsSent: 6_000 + index * 1_000,
        packetsLost: 80,
        roundTripTimeMs: 95,
        availableOutgoingBitrateKbps: 5200,
      }));
    }

    assert.equal(state.mode, 'full');
  });

  it('applies balanced and constrained encoding caps to a video sender', async () => {
    let parameters: RTCRtpSendParameters = {
      encodings: [
        { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2_800_000 },
        { rid: 'm', scaleResolutionDownBy: 2, maxBitrate: 1_200_000 },
        { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 350_000 },
      ],
    };
    const sender = {
      track: fakeVideoTrack(),
      getParameters: () => ({ encodings: parameters.encodings?.map((encoding) => ({ ...encoding })) }),
      setParameters: async (next: RTCRtpSendParameters) => {
        parameters = next;
      },
    } as RTCRtpSender;

    assert.equal(await applyBandwidthModeToVideoSender(sender, 'balanced'), true);
    assert.deepEqual(parameters.encodings?.map((encoding) => encoding.active), [false, true, true]);
    assert.equal(parameters.encodings?.[0]?.maxBitrate, 1_820_000);
    assert.equal(parameters.encodings?.[0]?.maxFramerate, 24);

    assert.equal(await applyBandwidthModeToVideoSender(sender, 'constrained'), true);
    assert.deepEqual(parameters.encodings?.map((encoding) => encoding.active), [false, false, true]);
    assert.equal(parameters.encodings?.[2]?.maxBitrate, 150_000);
    assert.equal(parameters.encodings?.[2]?.maxFramerate, 18);

    assert.equal(await applyBandwidthModeToVideoSender(sender, 'full'), true);
    assert.deepEqual(parameters.encodings?.map((encoding) => encoding.active), [true, true, true]);
    assert.equal(parameters.encodings?.[0]?.maxBitrate, 2_800_000);
    assert.equal(parameters.encodings?.[0]?.maxFramerate, 30);
  });

  it('ignores senders without live video parameters', async () => {
    const sender = {
      track: { kind: 'audio' },
      getParameters: () => ({ encodings: [{ maxBitrate: 96_000 }] }),
      setParameters: async () => {},
    } as RTCRtpSender;

    assert.equal(await applyBandwidthModeToVideoSender(sender, 'constrained'), false);
    assert.equal(readOutboundVideoStatsSnapshot([{ type: 'outbound-rtp', kind: 'audio', bytesSent: 1000 }]), null);
  });
});
