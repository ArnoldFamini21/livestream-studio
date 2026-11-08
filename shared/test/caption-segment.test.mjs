import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_CAPTION_SEGMENT_DURATION_MS,
  MAX_CAPTION_SEGMENT_TEXT_LENGTH,
  sanitizeCaptionSegment,
  sanitizeCaptionsState,
} from '../dist/index.js';

const now = Date.parse('2026-11-08T10:00:00.000Z');

describe('caption segment validation', () => {
  it('keeps clean fields and never trusts the sender identity', () => {
    const clean = sanitizeCaptionSegment({
      participantId: 'forged',
      speakerName: 'Someone else',
      segmentId: 'cap-1',
      text: '  Hello\n  there\u0007 ',
      startMs: now,
      endMs: now + 1500.4,
      final: true,
    });
    assert.deepEqual(clean, { segmentId: 'cap-1', text: 'Hello there', startMs: now, endMs: now + 1500, final: true });
    assert.equal('participantId' in clean, false);
  });

  it('caps text and duration and rejects malformed segments', () => {
    const long = sanitizeCaptionSegment({ segmentId: 'a', text: 'x'.repeat(2000), startMs: now, endMs: now + 120_000, final: 'yes' });
    assert.equal(long.text.length, MAX_CAPTION_SEGMENT_TEXT_LENGTH);
    assert.equal(long.endMs - long.startMs, MAX_CAPTION_SEGMENT_DURATION_MS);
    assert.equal(long.final, false);
    assert.equal(sanitizeCaptionSegment(null), null);
    assert.equal(sanitizeCaptionSegment({ segmentId: 'bad id!', text: 'hi', startMs: now, endMs: now }), null);
    assert.equal(sanitizeCaptionSegment({ segmentId: 'a', text: '   ', startMs: now, endMs: now }), null);
    assert.equal(sanitizeCaptionSegment({ segmentId: 'a', text: 'hi', startMs: now, endMs: now - 1 }), null);
    assert.equal(sanitizeCaptionSegment({ segmentId: 'a', text: 'hi', startMs: 'soon', endMs: now }), null);
  });

  it('validates the captions on/off state and its language', () => {
    assert.deepEqual(sanitizeCaptionsState({ enabled: true, language: 'fil-PH', from: 'x' }), { enabled: true, language: 'fil-PH' });
    assert.deepEqual(sanitizeCaptionsState({ enabled: false, language: '<script>' }), { enabled: false, language: 'en-US' });
    assert.equal(sanitizeCaptionsState({ enabled: 'yes' }), null);
  });
});
