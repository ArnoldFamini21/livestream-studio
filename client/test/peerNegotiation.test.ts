import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerNegotiation } from '../src/utils/peerNegotiation.ts';

class FakePeer extends EventTarget {
  signalingState = 'stable';
  connectionState = 'connected';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  offers: (RTCOfferOptions | undefined)[] = [];
  candidates: RTCIceCandidateInit[] = [];
  remoteCalls = 0;
  releaseOffer: (() => void) | undefined;
  pauseOffer = false;
  rejectRemote = false;
  async createOffer(options?: RTCOfferOptions) {
    this.offers.push(options);
    if (this.pauseOffer) await new Promise<void>(resolve => { this.releaseOffer = resolve; });
    return { type: 'offer', sdp: 'local offer' } as RTCSessionDescriptionInit;
  }
  async createAnswer() { return { type: 'answer', sdp: 'local answer' } as RTCSessionDescriptionInit; }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    this.localDescription = sdp;
    this.signalingState = sdp.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remoteCalls++;
    if (this.rejectRemote) throw new Error('stale SDP');
    this.remoteDescription = sdp;
    this.signalingState = sdp.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) { this.candidates.push(candidate); }
}
const remoteOffer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'remote offer' };
const remoteAnswer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'remote answer' };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(polite = true) {
  const pc = new FakePeer();
  const sent: RTCSessionDescriptionInit[] = [];
  let current = true;
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, polite, d => sent.push(d), () => current);
  return { pc, sent, negotiation, replace: () => { current = false; } };
}

test('answers a restart on the same established connection', async () => {
  const { pc, negotiation, sent } = setup();
  await negotiation.receiveOffer(remoteOffer);
  assert.equal(pc.signalingState, 'stable');
  assert.equal(sent[0].type, 'answer');
  await negotiation.receiveOffer({ ...remoteOffer, sdp: 'restart offer' });
  assert.equal(pc.remoteCalls, 2);
  assert.equal(sent.length, 2);
});

test('polite peer resolves simultaneous offers, including async createOffer', async () => {
  const { pc, negotiation, sent } = setup();
  pc.pauseOffer = true;
  const offering = negotiation.offer();
  await settle();
  const receiving = negotiation.receiveOffer(remoteOffer);
  pc.releaseOffer!();
  await Promise.all([offering, receiving]);
  assert.deepEqual(sent.map(d => d.type), ['offer', 'answer']);
  assert.equal(pc.signalingState, 'stable');
});

test('impolite peer ignores a colliding offer but preserves candidates reused in the answer', async () => {
  const { pc, negotiation, sent } = setup(false);
  pc.pauseOffer = true;
  const offering = negotiation.offer();
  await settle();
  const receiving = negotiation.receiveOffer(remoteOffer);
  pc.releaseOffer!();
  await Promise.all([offering, receiving]);
  await negotiation.receiveCandidate({ candidate: 'reused after rollback' });
  assert.equal(pc.remoteCalls, 0);
  assert.equal(pc.candidates.length, 0);
  await negotiation.receiveAnswer(remoteAnswer);
  await negotiation.receiveCandidate({ candidate: 'accepted' });
  assert.equal(pc.candidates.length, 2);
  assert.deepEqual(sent.map(d => d.type), ['offer']);
});

test('duplicate answers do not change an established connection', async () => {
  const { pc, negotiation } = setup();
  await negotiation.offer();
  await negotiation.receiveAnswer(remoteAnswer);
  await negotiation.receiveAnswer(remoteAnswer);
  assert.equal(pc.remoteCalls, 1);
  assert.equal(pc.signalingState, 'stable');
});

test('buffers early candidates and bounds the buffer', async () => {
  const { pc, negotiation } = setup();
  for (let i = 0; i < 60; i++) await negotiation.receiveCandidate({ candidate: String(i) });
  assert.equal(pc.candidates.length, 0);
  await negotiation.receiveOffer(remoteOffer);
  assert.equal(pc.candidates.length, 50);
  assert.equal(pc.candidates[0].candidate, '10');
});

test('a rejected signal does not poison subsequent recovery', async () => {
  const { pc, negotiation } = setup();
  pc.rejectRemote = true;
  await assert.rejects(negotiation.receiveOffer(remoteOffer));
  pc.rejectRemote = false;
  await negotiation.receiveOffer(remoteOffer);
  assert.equal(pc.signalingState, 'stable');
});

test('late offer completion cannot publish after a peer is replaced', async () => {
  const { pc, negotiation, sent, replace } = setup();
  pc.pauseOffer = true;
  const offering = negotiation.offer();
  await settle();
  replace();
  pc.releaseOffer!();
  await offering;
  assert.equal(sent.length, 0);
  assert.equal(pc.localDescription, null);
});

test('failed links restart ICE and recovery is bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pc, negotiation } = setup();
  pc.connectionState = 'failed';
  negotiation.connectionStateChanged();
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual(pc.offers, [{ iceRestart: true }]);
  await negotiation.receiveAnswer(remoteAnswer);
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(pc.offers.length, 2);
  await negotiation.receiveAnswer(remoteAnswer);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(pc.offers.length, 2);
  negotiation.dispose();
});

test('brief disconnect and disposal both cancel recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pc, negotiation } = setup();
  pc.connectionState = 'disconnected';
  negotiation.connectionStateChanged();
  negotiation.connectionStateChanged();
  pc.connectionState = 'connected';
  negotiation.connectionStateChanged();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(pc.offers.length, 0);
  pc.connectionState = 'failed';
  negotiation.connectionStateChanged();
  negotiation.dispose();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(pc.offers.length, 0);
});

test('sends a follow-up offer when the connection needs renegotiation', async () => {
  const { pc, negotiation, sent } = setup();
  // The answerer's own camera needs a new m-line after the first exchange.
  await negotiation.receiveOffer(remoteOffer);
  assert.deepEqual(sent.map((d) => d.type), ['answer']);
  pc.dispatchEvent(new Event('negotiationneeded'));
  await settle();
  assert.deepEqual(sent.map((d) => d.type), ['answer', 'offer']);
  assert.equal(pc.signalingState, 'have-local-offer');
});

test('queues a renegotiation behind an offer being answered', async () => {
  const { pc, negotiation, sent } = setup();
  const answering = negotiation.receiveOffer(remoteOffer);
  pc.dispatchEvent(new Event('negotiationneeded'));
  await answering;
  await settle();
  assert.deepEqual(sent.map((d) => d.type), ['answer', 'offer']);
});

test('ignores renegotiation after the peer is replaced', async () => {
  const { pc, sent, replace } = setup();
  replace();
  pc.dispatchEvent(new Event('negotiationneeded'));
  await settle();
  assert.equal(sent.length, 0);
});
