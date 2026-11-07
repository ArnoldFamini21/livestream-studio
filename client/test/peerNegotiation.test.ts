import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerNegotiation, getIceRestartDelayMs, getPoliteRecoveryDelayMs } from '../src/utils/peerNegotiation.ts';

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
  pauseRemote = false;
  releaseRemote: (() => void) | undefined;
  async createOffer(options?: RTCOfferOptions) {
    this.offers.push(options);
    if (this.pauseOffer) await new Promise<void>(resolve => { this.releaseOffer = resolve; });
    return { type: 'offer', sdp: 'local offer' } as RTCSessionDescriptionInit;
  }
  async createAnswer() { return { type: 'answer', sdp: 'local answer' } as RTCSessionDescriptionInit; }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    if (sdp.type === 'rollback') { this.signalingState = 'stable'; return; }
    this.localDescription = sdp;
    this.signalingState = sdp.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remoteCalls++;
    if (this.pauseRemote) await new Promise<void>(resolve => { this.releaseRemote = resolve; });
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

test('ICE restart backoff doubles up to a minute and never stops', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((attempt) => getIceRestartDelayMs(attempt, 5_000, 60_000)), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  // The polite side always waits well past the impolite side's restart.
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.ok(getPoliteRecoveryDelayMs(attempt, 5_000, 60_000) > getIceRestartDelayMs(attempt, 5_000, 60_000) + 4_000);
  }
});

test('the impolite side keeps restarting a failed link with growing delays', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new FakePeer();
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, () => {}, () => true, 5_000, 10_000, 1_500, { minRollbackAgeMs: 0, rebuildAfterAttempts: 100 });
  pc.connectionState = 'failed';
  negotiation.connectionStateChanged();
  const elapsedToOffer: number[] = [];
  let elapsed = 0;
  for (let step = 0; step < 6 * 60; step++) {
    t.mock.timers.tick(1_000);
    elapsed += 1_000;
    await settle();
    if (pc.offers.length > elapsedToOffer.length) elapsedToOffer.push(elapsed);
    // Each restart is "answered" but the network is still down.
    if (pc.signalingState === 'have-local-offer') await negotiation.receiveAnswer(remoteAnswer);
  }
  assert.deepEqual(elapsedToOffer.slice(0, 5), [5_000, 15_000, 35_000, 75_000, 135_000]);
  assert.ok(pc.offers.length >= 7, `still retrying after six minutes (${pc.offers.length} restarts)`);
  assert.ok(pc.offers.every((offer) => offer?.iceRestart));
  negotiation.dispose();
});

test('the polite side waits for the other side to restart instead of colliding with it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new FakePeer();
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, true, () => {}, () => true, 5_000, 10_000, 1_500, { minRollbackAgeMs: 0, rebuildAfterAttempts: 100 });
  pc.connectionState = 'failed';
  negotiation.connectionStateChanged();
  // The impolite side's restart offer arrives before the polite watch expires.
  t.mock.timers.tick(5_000);
  await negotiation.receiveOffer({ ...remoteOffer, sdp: 'restart 1' });
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(pc.offers.length, 0, 'no polite restart while the other side is restarting');
  // Nothing more arrives: the polite side finally restarts on its own.
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(pc.offers.length, 1);
  assert.deepEqual(pc.offers[0], { iceRestart: true });
  negotiation.dispose();
});

test('rebuilds the connection after repeated failed restarts, once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new FakePeer();
  let rebuilds = 0;
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, () => {}, () => true, 1_000, 10_000, 1_500, {
    minRollbackAgeMs: 0,
    rebuildAfterAttempts: 3,
    onRecoveryExhausted: () => { rebuilds++; },
  });
  pc.connectionState = 'failed';
  negotiation.connectionStateChanged();
  for (let step = 0; step < 60; step++) {
    t.mock.timers.tick(1_000);
    await settle();
    if (pc.signalingState === 'have-local-offer') await negotiation.receiveAnswer(remoteAnswer);
  }
  assert.equal(pc.offers.length, 3);
  assert.equal(rebuilds, 1);
  negotiation.connectionStateChanged();
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(rebuilds, 1);
  negotiation.dispose();
});

test('restartNow skips the backoff when the network comes back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new FakePeer();
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, () => {}, () => true, 5_000, 10_000, 1_500, { minRollbackAgeMs: 0 });
  pc.connectionState = 'disconnected';
  negotiation.connectionStateChanged();
  negotiation.restartNow();
  await settle();
  assert.deepEqual(pc.offers, [{ iceRestart: true }]);
  pc.connectionState = 'connected';
  negotiation.connectionStateChanged();
  negotiation.restartNow();
  await settle();
  assert.equal(pc.offers.length, 1, 'a connected link is left alone');
  negotiation.dispose();
});

test('a young unanswered restart offer is not rolled back by the next attempt', async () => {
  const pc = new FakePeer();
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, () => {}, () => true, 5_000, 10_000, 1_500, { minRollbackAgeMs: 60_000 });
  await negotiation.offer(true);
  assert.equal(pc.signalingState, 'have-local-offer');
  await negotiation.offer(true);
  assert.equal(pc.offers.length, 1);
  assert.equal(pc.signalingState, 'have-local-offer');
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

test('impolite peer answers an offer that arrives while the previous answer is still being applied', async () => {
  // Seen with relayed connections: the polite peer answers our offer, then sends
  // its own offer; it arrives while our side is still applying that answer.
  // Checking for a collision on arrival dropped it, and neither side recovered.
  const { pc, negotiation, sent } = setup(false);
  await negotiation.offer();
  pc.pauseRemote = true;
  const applyingAnswer = negotiation.receiveAnswer(remoteAnswer);
  await settle();
  assert.equal(pc.signalingState, 'have-local-offer');
  const followUp = negotiation.receiveOffer({ ...remoteOffer, sdp: 'follow-up offer' });
  pc.pauseRemote = false;
  pc.releaseRemote!();
  await Promise.all([applyingAnswer, followUp]);
  assert.deepEqual(sent.map(d => d.type), ['offer', 'answer']);
  assert.equal(pc.remoteDescription?.sdp, 'follow-up offer');
  assert.equal(pc.signalingState, 'stable');
});

test('recovery re-offers when the previous offer was never answered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new FakePeer();
  const sent: RTCSessionDescriptionInit[] = [];
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, d => sent.push(d), () => true, 10, 10_000, 1_500, { minRollbackAgeMs: 0 });
  await negotiation.offer();
  assert.equal(pc.signalingState, 'have-local-offer');
  pc.connectionState = 'failed';
  negotiation.connectionStateChanged();
  t.mock.timers.tick(10);
  await settle();
  assert.deepEqual(sent.map(d => d.type), ['offer', 'offer']);
  assert.deepEqual(pc.offers.at(-1), { iceRestart: true });
  assert.equal(pc.signalingState, 'have-local-offer');
  negotiation.dispose();
});

test('restarts ICE when a connection never leaves "new", impolite side first', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const make = (polite: boolean) => {
    const pc = new FakePeer();
    pc.connectionState = 'new';
    const sent: RTCSessionDescriptionInit[] = [];
    const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, polite, d => sent.push(d), () => true, 5, 100, 1_500, { minRollbackAgeMs: 0 });
    return { pc, sent, negotiation };
  };
  const impolite = make(false);
  const polite = make(true);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(impolite.pc.offers, [{ iceRestart: true }]);
  assert.equal(polite.pc.offers.length, 0);
  // The impolite restart is answered and the polite side connects: no restart of its own.
  polite.pc.connectionState = 'connected';
  polite.negotiation.connectionStateChanged();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(polite.pc.offers.length, 0);
  // Still stuck: one more restart, then it stops.
  impolite.pc.signalingState = 'stable';
  t.mock.timers.tick(100);
  await settle();
  impolite.pc.signalingState = 'stable';
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(impolite.pc.offers.length, 2);
  impolite.negotiation.dispose();
  polite.negotiation.dispose();
});

test('the connect watchdog leaves a connection that is making progress alone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new FakePeer();
  pc.connectionState = 'connecting';
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, () => {}, () => true, 5, 100);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(pc.offers.length, 0);
  negotiation.dispose();
});

test('the polite side lets the other side make the first offer, then sends its own', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pc, negotiation, sent } = setup(true);
  pc.connectionState = 'new';
  pc.dispatchEvent(new Event('negotiationneeded'));
  await settle();
  assert.deepEqual(sent, [], 'no offer of its own yet: no collision to take back');
  await negotiation.receiveOffer(remoteOffer);
  await settle();
  assert.deepEqual(sent.map(d => d.type), ['answer', 'offer']);
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(sent.length, 2, 'the fallback does not offer twice');
  negotiation.dispose();
});

test('the polite side offers anyway when the other side never does', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pc, negotiation, sent } = setup(true);
  pc.dispatchEvent(new Event('negotiationneeded'));
  t.mock.timers.tick(1_499);
  await settle();
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(sent.map(d => d.type), ['offer']);
  negotiation.dispose();
});

test('the impolite side offers at once', async () => {
  const { pc, negotiation, sent } = setup(false);
  pc.dispatchEvent(new Event('negotiationneeded'));
  await settle();
  assert.deepEqual(sent.map(d => d.type), ['offer']);
  negotiation.dispose();
});

test('starting a connection: the impolite side offers, the polite side waits for that offer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const impolite = setup(false);
  await impolite.negotiation.start();
  assert.deepEqual(impolite.sent.map(d => d.type), ['offer']);

  const polite = setup(true);
  await polite.negotiation.start();
  await settle();
  assert.deepEqual(polite.sent, [], 'no offer to take back when the other side offers');
  await polite.negotiation.receiveOffer(remoteOffer);
  await settle();
  assert.deepEqual(polite.sent.map(d => d.type), ['answer', 'offer']);
  impolite.negotiation.dispose();
  polite.negotiation.dispose();
});

test('a polite side whose peer never offers still starts the connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { negotiation, sent } = setup(true);
  await negotiation.start();
  t.mock.timers.tick(1_500);
  await settle();
  assert.deepEqual(sent.map(d => d.type), ['offer']);
  negotiation.dispose();
});

test('applies codec preferences and description rewrites around every offer and answer', async () => {
  const pc = new FakePeer();
  const sent: RTCSessionDescriptionInit[] = [];
  const prepared: string[] = [];
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, d => sent.push(d), () => true, 5_000, 10_000, 1_500, {
    beforeCreateDescription: () => { prepared.push(pc.signalingState); },
    transformLocalDescription: (d) => ({ type: d.type, sdp: `${d.sdp} +local` }),
    transformRemoteDescription: (d) => ({ type: d.type, sdp: `${d.sdp} +remote` }),
  });

  await negotiation.offer();
  assert.equal(pc.localDescription?.sdp, 'local offer +local');
  assert.equal(sent[0].sdp, 'local offer +local', 'the rewritten offer is what goes out');
  await negotiation.receiveAnswer(remoteAnswer);
  assert.equal(pc.remoteDescription?.sdp, 'remote answer +remote');

  await negotiation.receiveOffer(remoteOffer);
  assert.equal(pc.remoteDescription?.sdp, 'remote offer +remote');
  assert.equal(pc.localDescription?.sdp, 'local answer +local');
  assert.deepEqual(prepared, ['stable', 'have-remote-offer'], 'codec order is set before createOffer and createAnswer');
  negotiation.dispose();
});

test('a failing codec preference step does not block negotiation', async () => {
  const pc = new FakePeer();
  const sent: RTCSessionDescriptionInit[] = [];
  const negotiation = new PeerNegotiation(pc as unknown as RTCPeerConnection, false, d => sent.push(d), () => true, 5_000, 10_000, 1_500, {
    beforeCreateDescription: () => { throw new Error('InvalidModificationError'); },
  });
  await negotiation.offer();
  assert.equal(sent.length, 1);
  negotiation.dispose();
});
