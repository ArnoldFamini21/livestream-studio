import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MediaStreamTrack, RTCPeerConnection, RtpPacket } from 'werift';
import { SfuMediaTransport, type SfuSessionDescription } from './sfuTransport.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class Signal<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  subscribe(listener: (value: T) => void) { this.listeners.push(listener); }
  emit(value: T) { this.listeners.forEach((listener) => listener(value)); }
}

class FakePeerConnection {
  readonly onIceCandidate = new Signal<Record<string, unknown>>();
  readonly transceivers: Array<{
    onTrack: Signal<MediaStreamTrack>;
    sender: { track: unknown };
    mid: string;
  }> = [];
  offerGate?: ReturnType<typeof deferred>;
  closeGate?: ReturnType<typeof deferred>;
  closeCalls = 0;
  localDescription: SfuSessionDescription | null = null;

  constructor(readonly id: number) {}
  async createOffer() {
    if (this.offerGate) await this.offerGate.promise;
    return { type: 'offer' as const, sdp: `offer-${this.id}` };
  }
  async setLocalDescription(description: SfuSessionDescription) { this.localDescription = description; }
  addTransceiver(track: unknown) {
    const transceiver = {
      onTrack: new Signal<MediaStreamTrack>(),
      sender: { track },
      mid: String(this.transceivers.length),
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  async close() {
    this.closeCalls += 1;
    if (this.closeGate) await this.closeGate.promise;
  }
}

const PRODUCERS = [{ producerId: 'bob', hasVideo: true, hasAudio: true }];

function createHarness(configurePeer?: (peer: FakePeerConnection) => void) {
  const peers: FakePeerConnection[] = [];
  const ice: string[] = [];
  const transport = new SfuMediaTransport({
    onIceCandidate: (_id, _side, candidate) => ice.push(candidate.candidate),
  }, () => {
    const peer = new FakePeerConnection(peers.length);
    configurePeer?.(peer);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  });
  return { transport, peers, ice };
}

describe('SFU transport lifecycle ownership', () => {
  it('does not install an older publish attempt after waiting for an old PC to close', async () => {
    const { transport, peers } = createHarness();
    await transport.createPublishOffer('alice', ['h'], true);
    const closing = peers[0].closeGate = deferred();
    const stale = transport.createPublishOffer('alice', ['h'], true);
    const current = await transport.createPublishOffer('alice', ['h'], true);
    closing.resolve();

    await assert.rejects(stale, /superseded/);
    assert.equal(current.sdp, 'offer-1');
    assert.equal(peers.length, 2, 'the superseded attempt must not allocate a new PC');
    assert.equal(peers[1].closeCalls, 0);
    assert.equal(transport.getPublisherCount(), 1);
    await transport.closeAll();
  });

  it('discards an offer that resolves after a newer publisher owns the participant', async () => {
    const offerGate = deferred();
    const { transport, peers } = createHarness((peer) => {
      if (peer.id === 0) peer.offerGate = offerGate;
    });
    const stale = transport.createPublishOffer('alice', ['h'], true);
    const current = await transport.createPublishOffer('alice', ['h'], true);
    offerGate.resolve();
    await assert.rejects(stale, /superseded/);
    assert.equal(current.sdp, 'offer-1');
    assert.equal(peers[1].closeCalls, 0);
    await transport.closeAll();
  });

  it('detaches both sides before awaiting shutdown so an old close cannot remove a new subscriber', async () => {
    const { transport, peers } = createHarness();
    await transport.createPublishOffer('alice', ['h'], true);
    await transport.createSubscribeOffer('alice', PRODUCERS);
    const closingPublisher = peers[0].closeGate = deferred();
    const closing = transport.closeParticipant('alice');
    assert.equal(peers[1].closeCalls, 1, 'the old subscriber closes before the publisher finishes');

    await transport.createPublishOffer('alice', ['h'], true);
    await transport.createSubscribeOffer('alice', PRODUCERS);
    closingPublisher.resolve();
    await closing;
    assert.equal(peers[2].closeCalls, 0);
    assert.equal(peers[3].closeCalls, 0);
    assert.equal(transport.getPublisherCount(), 1);
    assert.equal(transport.getSubscriberCount(), 1);
    await transport.closeAll();
  });

  it('does not return an old subscription offer after the subscriber is replaced', async () => {
    const { transport, peers } = createHarness();
    // Install a first subscriber so its next offer can be delayed.
    await transport.createSubscribeOffer('alice', PRODUCERS);
    const gate = peers[0].offerGate = deferred();
    const stale = transport.createSubscribeOffer('alice', PRODUCERS);
    await transport.closeParticipant('alice');
    const current = await transport.createSubscribeOffer('alice', PRODUCERS);
    gate.resolve();

    await assert.rejects(stale, /superseded/);
    assert.equal(current.description.sdp, 'offer-1');
    assert.equal(peers[1].closeCalls, 0);
    assert.equal(transport.getSubscriberCount(), 1);
    await transport.closeAll();
  });

  it('ignores ICE and already-subscribed RTP callbacks from a replaced publisher', async () => {
    const { transport, peers, ice } = createHarness();
    await transport.createPublishOffer('alice', ['h'], true);
    const video = { rid: 'h', onReceiveRtp: new Signal<RtpPacket>() };
    const audio = { onReceiveRtp: new Signal<RtpPacket>() };
    peers[0].transceivers[0].onTrack.emit(video as unknown as MediaStreamTrack);
    peers[0].transceivers[1].onTrack.emit(audio as unknown as MediaStreamTrack);
    await transport.createPublishOffer('alice', ['h'], true);

    peers[0].onIceCandidate.emit({ candidate: 'old-publish-ice' });
    video.onReceiveRtp.emit({} as RtpPacket);
    audio.onReceiveRtp.emit({} as RtpPacket);
    assert.deepEqual(ice, []);
    assert.deepEqual(transport.getPublisherRidCounts('alice'), {});
    assert.equal(transport.getPublisherAudioPacketCount('alice'), 0);
    peers[1].onIceCandidate.emit({ candidate: 'current-publish-ice' });
    assert.deepEqual(ice, ['current-publish-ice']);
    await transport.closeAll();
  });

  it('cancels a publish attempt waiting to allocate its PC when the room closes', async () => {
    const { transport, peers } = createHarness();
    await transport.createPublishOffer('alice', ['h'], true);
    const gate = peers[0].closeGate = deferred();
    const pending = transport.createPublishOffer('alice', ['h'], true);
    await transport.closeAll();
    gate.resolve();
    await assert.rejects(pending, /superseded/);
    assert.equal(transport.getPublisherCount(), 0);
    assert.equal(peers.length, 1);
  });
});
