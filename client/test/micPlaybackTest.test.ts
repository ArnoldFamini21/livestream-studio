import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeMicTestPhase, pickMicTestMimeType } from '../src/utils/micPlaybackTest.ts';

describe('pre-join mic playback test', () => {
  it('prefers Opus in WebM and falls back to MP4 audio for Safari', () => {
    assert.equal(pickMicTestMimeType((type) => type.startsWith('audio/webm')), 'audio/webm;codecs=opus');
    assert.equal(pickMicTestMimeType((type) => type === 'audio/mp4'), 'audio/mp4');
  });

  it('uses the browser default when nothing is supported or the check throws', () => {
    assert.equal(pickMicTestMimeType(undefined), '');
    assert.equal(pickMicTestMimeType(() => { throw new Error('nope'); }), '');
  });

  it('tells the guest what is happening', () => {
    assert.match(describeMicTestPhase('recording', 2), /2s/);
    assert.match(describeMicTestPhase('playing', 0), /Playing back/);
  });
});
