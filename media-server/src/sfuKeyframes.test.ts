import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RtpHeader, RtpPacket, type MediaStreamTrack, type RTCPeerConnection } from 'werift';
import type { SfuIceConfig } from './sfuIceServers.js';
import { SfuMediaTransport } from './sfuTransport.js';

class Signal<T extends unknown[] = []> {
  private readonly listeners: Array<(...value: T) => void> = [];
  subscribe(listener: (...value: T) => void) { this.listeners.push(listener); }
  emit(...value: T) { this.listeners.forEach((listener) => listener(...value)); }
}

class FakeTransceiver {
  readonly onTrack = new Signal<[MediaStreamTrack]>();
  readonly plis: number[] = [];
  readonly receiver = { sendRtcpPLI: async (ssrc: number) => { this.plis.push(ssrc); } };
  readonly sender: { track: unknown; onPictureLossIndication: Signal };
  constructor(track: unknown, readonly mid: string) {
    this.sender = { track, onPictureLossIndication: new Signal() };
  }
}

class FakePeerConnection {
  readonly onIceCandidate = new Signal<[Record<string, unknown>]>();
  readonly connectionStateChange = new Signal<[string]>();
  readonly transceivers: FakeTransceiver[] = [];
  localDescription: { type: 'offer'; sdp: string } | null = null;
  constructor(readonly withRid: boolean, readonly ice: SfuIceConfig | null) {}
  async createOffer() { return { type: 'offer' as const, sdp: 'offer' }; }
  async setLocalDescription(description: { type: 'offer'; sdp: string }) { this.localDescription = description; }
  addTransceiver(track: unknown) {
    const transceiver = new FakeTransceiver(track, String(this.transceivers.length));
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  async close() {}
}

function packet(ssrc: number) {
  return new RtpPacket(new RtpHeader({ payloadType: 96, sequenceNumber: 1, timestamp: 1, ssrc }), Buffer.alloc(10));
}

function harness(options: { ice?: SfuIceConfig | null; intervalMs?: number } = {}) {
  const peers: FakePeerConnection[] = [];
  const transport = new SfuMediaTransport({}, (withRid, ice) => {
    const peer = new FakePeerConnection(withRid, ice);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  }, {
    ...(options.ice !== undefined ? { resolveIceConfig: async () => options.ice ?? null } : {}),
    keyframeRequestIntervalMs: options.intervalMs ?? 0,
  });
  return { transport, peers };
}

const BOB = [{ producerId: 'bob', hasVideo: true, hasAudio: false }];

describe('SFU keyframe requests', () => {
  it('asks the publisher for a keyframe when a subscriber gets a layer or switches layer', async () => {
    const { transport, peers } = harness();
    await transport.createPublishOffer('bob', ['h', 'l']);
    const publisherVideo = peers[0].transceivers[0];
    transport.injectPublisherRtp('bob', 'h', packet(1111));
    transport.injectPublisherRtp('bob', 'l', packet(2222));
    await transport.createSubscribeOffer('alice', BOB);

    transport.setForwardedLayer('alice', 'bob', 'h');
    transport.setForwardedLayer('alice', 'bob', 'h');
    transport.setForwardedLayer('alice', 'bob', 'l');
    transport.setForwardedLayer('alice', 'bob', null);
    assert.deepEqual(publisherVideo.plis, [1111, 2222], 'one request per new layer, none for a pause');
    assert.equal(transport.getPublisherKeyframeRequestCount('bob'), 2);
  });

  it('waits for the first packet of a layer whose SSRC is not known yet', async () => {
    const { transport, peers } = harness();
    await transport.createPublishOffer('bob', ['h']);
    await transport.createSubscribeOffer('alice', BOB);
    transport.setForwardedLayer('alice', 'bob', 'h');
    assert.deepEqual(peers[0].transceivers[0].plis, []);
    transport.injectPublisherRtp('bob', 'h', packet(4242));
    transport.injectPublisherRtp('bob', 'h', packet(4242));
    assert.deepEqual(peers[0].transceivers[0].plis, [4242]);
  });

  it('asks again once the subscriber connects, and passes on the subscriber\'s own PLIs', async () => {
    const { transport, peers } = harness();
    await transport.createPublishOffer('bob', ['h']);
    transport.injectPublisherRtp('bob', 'h', packet(7));
    await transport.createSubscribeOffer('alice', BOB);
    transport.setForwardedLayer('alice', 'bob', 'h');
    const subscriber = peers[1];
    subscriber.connectionStateChange.emit('connecting');
    subscriber.connectionStateChange.emit('connected');
    subscriber.transceivers[0].sender.onPictureLossIndication.emit();
    assert.deepEqual(peers[0].transceivers[0].plis, [7, 7, 7]);
  });

  it('throttles keyframe requests per layer', async () => {
    const { transport, peers } = harness({ intervalMs: 60_000 });
    await transport.createPublishOffer('bob', ['h']);
    transport.injectPublisherRtp('bob', 'h', packet(9));
    assert.equal(transport.requestKeyframe('bob', 'h'), true);
    assert.equal(transport.requestKeyframe('bob', 'h'), false);
    assert.deepEqual(peers[0].transceivers[0].plis, [9]);
  });

  it('hands the minted TURN config to every new peer connection', async () => {
    const ice: SfuIceConfig = {
      iceServers: [{ urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' }],
      iceTransportPolicy: 'relay',
    };
    const { transport, peers } = harness({ ice });
    await transport.createPublishOffer('bob', ['h']);
    await transport.createSubscribeOffer('alice', BOB);
    assert.deepEqual(peers.map((peer) => peer.ice), [ice, ice]);
    assert.equal(peers[0].withRid, true);
  });

  it('still creates peer connections when TURN cannot be minted', async () => {
    const { transport, peers } = harness({ ice: null });
    await transport.createPublishOffer('bob', ['h']);
    assert.equal(peers[0].ice, null);
    const failing = new SfuMediaTransport({}, (withRid, iceConfig) => {
      const peer = new FakePeerConnection(withRid, iceConfig);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    }, { resolveIceConfig: async () => { throw new Error('Cloudflare down'); } });
    await failing.createSubscribeOffer('alice', BOB);
    assert.equal(peers[1].ice, null);
  });
});
