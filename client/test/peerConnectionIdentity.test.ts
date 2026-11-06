import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideIncomingAnswer,
  decideIncomingCandidate,
  decideIncomingOffer,
} from '../src/utils/peerConnectionIdentity.ts';
import { mixScreenAudioWithVoice } from '../src/utils/screenShareAudio.ts';

const established = { pcId: 'pc-ours-2', remotePcId: 'pc-theirs-1', hasLocalDescription: true, hasRemoteDescription: true };
const fresh = { pcId: 'pc-ours-3', remotePcId: null, hasLocalDescription: false, hasRemoteDescription: false };

describe('peer connection identity across reloads and rebuilds', () => {
  it('rebuilds when the other side offers from a new connection (it reloaded but kept its seat)', () => {
    assert.deepEqual(decideIncomingOffer({ pcId: 'pc-theirs-9' }, established), { action: 'rebuild', remotePcId: 'pc-theirs-9' });
  });

  it('accepts restarts and renegotiation from the connection it already knows', () => {
    assert.deepEqual(decideIncomingOffer({ pcId: 'pc-theirs-1', toPcId: 'pc-ours-2' }, established), { action: 'accept', remotePcId: 'pc-theirs-1' });
    assert.deepEqual(decideIncomingOffer({ pcId: 'pc-theirs-1' }, fresh), { action: 'accept', remotePcId: 'pc-theirs-1' });
  });

  it('ignores offers aimed at a connection we replaced, and makes sure the new one offers', () => {
    assert.deepEqual(decideIncomingOffer({ pcId: 'pc-theirs-1', toPcId: 'pc-ours-1' }, fresh), { action: 'ignore', kickStart: true });
    assert.deepEqual(decideIncomingOffer({ pcId: 'pc-theirs-1', toPcId: 'pc-ours-1' }, { ...fresh, hasLocalDescription: true }), { action: 'ignore', kickStart: false });
  });

  it('handles older clients that send no connection ids as before', () => {
    assert.deepEqual(decideIncomingOffer({}, established), { action: 'accept', remotePcId: 'pc-theirs-1' });
    assert.deepEqual(decideIncomingAnswer({}, established), { action: 'accept', remotePcId: 'pc-theirs-1' });
    assert.equal(decideIncomingCandidate({}, established), 'apply');
  });

  it('drops answers and candidates for replaced connections and holds early ones', () => {
    assert.deepEqual(decideIncomingAnswer({ pcId: 'pc-theirs-1', toPcId: 'pc-ours-1' }, established), { action: 'ignore' });
    assert.deepEqual(decideIncomingAnswer({ pcId: 'pc-theirs-5' }, established), { action: 'ignore' });
    assert.deepEqual(decideIncomingAnswer({ pcId: 'pc-theirs-5', toPcId: 'pc-ours-3' }, { ...fresh, hasLocalDescription: true }), { action: 'accept', remotePcId: 'pc-theirs-5' });
    assert.equal(decideIncomingCandidate({ pcId: 'pc-theirs-1', toPcId: 'pc-ours-1' }, established), 'ignore');
    assert.equal(decideIncomingCandidate({ pcId: 'pc-theirs-9' }, established), 'buffer');
    assert.equal(decideIncomingCandidate({ pcId: 'pc-theirs-1', toPcId: 'pc-ours-2' }, established), 'apply');
  });
});

describe('screen share audio on the SFU', () => {
  it('mixes the shared sound with the voice into one published track and cleans up', () => {
    const connected: unknown[] = [];
    let disconnected = 0;
    let stopped = 0;
    const output = { kind: 'audio', stop: () => { stopped++; } };
    const context = {
      createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [output] } }),
      createMediaStreamSource: () => ({ connect: (node: unknown) => connected.push(node), disconnect: () => { disconnected++; } }),
    } as unknown as AudioContext;
    const voice = { readyState: 'live', kind: 'audio' } as MediaStreamTrack;
    const screen = { readyState: 'live', kind: 'audio' } as MediaStreamTrack;
    const originalMediaStream = globalThis.MediaStream;
    globalThis.MediaStream = class { constructor(public tracks: MediaStreamTrack[]) {} } as unknown as typeof MediaStream;
    try {
      const mixed = mixScreenAudioWithVoice(context, voice, screen);
      assert.ok(mixed);
      assert.equal(mixed.track, output);
      assert.equal(connected.length, 2, 'voice and screen sound both feed the mix');
      mixed.dispose();
      assert.equal(disconnected, 2);
      assert.equal(stopped, 1);
      // No voice track (muted device, audio-only share): the shared sound alone.
      connected.length = 0;
      assert.ok(mixScreenAudioWithVoice(context, null, screen));
      assert.equal(connected.length, 1);
    } finally {
      globalThis.MediaStream = originalMediaStream;
    }
  });
});
