import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SfuWebRtcTransport, type SfuPeerConnectionLike } from '../src/utils/sfuWebRtcTransport.ts';
import {
  readInboundTotals,
  SFU_DOWNLINK_CEILING_KBPS,
  SFU_DOWNLINK_FLOOR_KBPS,
  SfuDownlinkEstimator,
} from '../src/utils/sfuDownlinkEstimate.ts';

class StatefulPeer implements SfuPeerConnectionLike {
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  stats: RTCStatsReport | null = null;
  readonly transceivers = [{
    mid: '0',
    direction: 'recvonly',
    receiver: { track: { kind: 'video' } },
    sender: { replaceTrack: async () => {} },
  }] as unknown as RTCRtpTransceiver[];
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async addIceCandidate() {}
  getTransceivers() { return this.transceivers; }
  async getStats() { return this.stats as RTCStatsReport; }
  close() {}
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.({} as Event);
  }
}

const camera = { kind: 'video', readyState: 'live' } as MediaStreamTrack;

function setup() {
  const peer = new StatefulPeer();
  const ready: string[] = [];
  const errors: string[] = [];
  const transport = new SfuWebRtcTransport(() => undefined, {
    createPeerConnection: () => peer,
    onTransportReady: (side) => ready.push(side),
    onError: (message) => errors.push(message),
  });
  transport.setPublishTrack(camera);
  return { peer, ready, errors, transport };
}

describe('SFU transport readiness', () => {
  it('reports publish ready only once ICE and DTLS are connected', async () => {
    const { peer, ready, transport } = setup();
    await transport.handleOffer({ side: 'publish', sdp: 'offer' });
    assert.deepEqual(ready, [], 'an answer alone does not carry media');
    peer.setState('connecting');
    assert.deepEqual(ready, []);
    peer.setState('connected');
    peer.setState('connected');
    assert.deepEqual(ready, ['publish'], 'once per connection');
  });

  it('is ready right away when a connection that is already up is renegotiated', async () => {
    const { peer, ready, transport } = setup();
    await transport.handleOffer({ side: 'publish', sdp: 'offer' });
    peer.setState('connected');
    await transport.handleOffer({ side: 'publish', sdp: 'offer-2' });
    assert.deepEqual(ready, ['publish']);
  });

  it('reports a failed connection as an error so the studio falls back to the mesh', async () => {
    const { peer, ready, errors, transport } = setup();
    await transport.handleOffer({ side: 'publish', sdp: 'offer' });
    peer.setState('failed');
    assert.deepEqual(ready, []);
    assert.deepEqual(errors, ['The SFU publish connection failed.']);
  });

  it('ignores state changes after the transport closed', async () => {
    const { peer, errors, transport } = setup();
    await transport.handleOffer({ side: 'publish', sdp: 'offer' });
    transport.close();
    peer.setState('failed');
    assert.deepEqual(errors, []);
  });
});

function report(entries: Array<Record<string, unknown>>): RTCStatsReport {
  return new Map(entries.map((entry, index) => [String(entry.id ?? index), entry])) as unknown as RTCStatsReport;
}

describe('SFU downlink estimate', () => {
  it('sums inbound streams and reads availableIncomingBitrate from the selected pair', () => {
    const totals = readInboundTotals(report([
      { id: 'v', type: 'inbound-rtp', bytesReceived: 1000, packetsReceived: 10, packetsLost: 1 },
      { id: 'a', type: 'inbound-rtp', bytesReceived: 500, packetsReceived: 5, packetsLost: -2 },
      { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
      { id: 'p', type: 'candidate-pair', availableIncomingBitrate: 2_500_000 },
    ]), 42);
    assert.deepEqual(totals, {
      bytesReceived: 1500, packetsReceived: 15, packetsLost: 1, timestampMs: 42, availableIncomingBitrate: 2_500_000,
    });
  });

  it('uses the browser estimate when there is one', () => {
    const estimator = new SfuDownlinkEstimator();
    assert.equal(estimator.update({ bytesReceived: 0, packetsReceived: 0, packetsLost: 0, timestampMs: 0, availableIncomingBitrate: 1_800_000 }), 1800);
  });

  it('backs off below the arriving rate on heavy loss and climbs back slowly on a clean link', () => {
    const estimator = new SfuDownlinkEstimator(6_000);
    let t = 0;
    let bytes = 0;
    let received = 0;
    let lost = 0;
    const step = (kbps: number, packets: number, lostPackets: number) => {
      t += 1000;
      bytes += (kbps * 1000) / 8;
      received += packets;
      lost += lostPackets;
      return estimator.update({ bytesReceived: bytes, packetsReceived: received, packetsLost: lost, timestampMs: t });
    };
    assert.equal(step(2000, 200, 0), 6000, 'first sample only sets the baseline');
    assert.equal(step(2000, 180, 20), 1700, '10% loss: below the 2000 kbps arriving');
    assert.equal(step(1500, 199, 1), 1836, 'clean: +8%');
    assert.equal(step(1500, 196, 4), 1836, 'some loss: hold');
    for (let i = 0; i < 40; i++) step(1500, 200, 0);
    assert.equal(estimator.currentKbps, SFU_DOWNLINK_CEILING_KBPS);
    for (let i = 0; i < 40; i++) step(100, 100, 50);
    assert.equal(estimator.currentKbps, SFU_DOWNLINK_FLOOR_KBPS);
  });

  it('skips samples with reset counters or too few packets', () => {
    const estimator = new SfuDownlinkEstimator(3_000);
    estimator.update({ bytesReceived: 10_000, packetsReceived: 100, packetsLost: 0, timestampMs: 0 });
    assert.equal(estimator.update({ bytesReceived: 5, packetsReceived: 1, packetsLost: 0, timestampMs: 1000 }), 3000);
    assert.equal(estimator.update({ bytesReceived: 10, packetsReceived: 5, packetsLost: 5, timestampMs: 2000 }), 3000);
  });
});
