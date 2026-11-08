import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignTranscriptWords, getClipTranscriptAlignment } from '../src/utils/clipTranscriptAlignment.ts';
import { buildClipCaptionCues } from '../src/utils/clipCaptions.ts';

function capture(sourceKind: string, startedAt: string) {
  return { sourceKind, startedAt, sourceId: sourceKind, mimeType: 'video/webm', tracks: [] };
}

const tracks = [
  { label: 'Program', fileName: 'program.webm', kind: 'program', capture: capture('program', '2026-11-08T10:00:00.000Z') },
  { label: 'Host mic', fileName: 'host-mic.webm', kind: 'audio', capture: capture('audio', '2026-11-08T10:00:01.000Z') },
  // The guest joined (and their ISO began) a minute after the host mic.
  { label: 'Guest camera', fileName: 'guest-iso.webm', kind: 'iso', capture: capture('iso', '2026-11-08T10:01:01.000Z') },
  { label: 'Old file', fileName: 'old.webm', kind: 'video' },
];

describe('clip transcript alignment', () => {
  it('leaves words untouched when the clip is cut from the transcribed track', () => {
    const alignment = getClipTranscriptAlignment(tracks, 'host-mic.webm', tracks[1]);
    assert.deepEqual(alignment, { usable: true, shiftSeconds: 0, note: null });
  });

  it('moves words onto the program timeline, which started 1 s earlier', () => {
    const alignment = getClipTranscriptAlignment(tracks, 'host-mic.webm', tracks[0]);
    assert.equal(alignment.usable, true);
    assert.equal(alignment.shiftSeconds, 1);
    assert.equal(alignment.note, null);
    const words = alignTranscriptWords([{ word: 'Hello', start: 10, end: 10.4 }], alignment.shiftSeconds);
    assert.deepEqual(words, [{ word: 'Hello', start: 11, end: 11.4 }]);
  });

  it('moves words onto a late guest ISO and says whose words they are', () => {
    const alignment = getClipTranscriptAlignment(tracks, 'host-mic.webm', tracks[2]);
    assert.equal(alignment.usable, true);
    assert.equal(alignment.shiftSeconds, -60);
    assert.match(alignment.note ?? '', /Host mic transcript only/);
    const words = alignTranscriptWords([
      { word: 'before', start: 30, end: 30.5 },
      { word: 'edge', start: 59.8, end: 60.3 },
      { word: 'during', start: 75, end: 75.5 },
    ], alignment.shiftSeconds);
    assert.deepEqual(words.map((word) => word.word), ['edge', 'during'], 'words before the ISO began are dropped');
    assert.equal(words[0].start, 0);
    // A 10-20 s clip of the ISO shows what was said 70-80 s into the host mic.
    const cues = buildClipCaptionCues(words, { startSeconds: 10, endSeconds: 20 });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].words[0].text, 'during');
    assert.ok(Math.abs(cues[0].words[0].start - 5) < 1e-9);
  });

  it('turns burned captions off for a file it cannot line up', () => {
    const noTiming = getClipTranscriptAlignment(tracks, 'host-mic.webm', tracks[3]);
    assert.equal(noTiming.usable, false);
    assert.match(noTiming.note, /no capture timing/);
    assert.equal(getClipTranscriptAlignment(tracks, 'missing.webm', tracks[0]).usable, false);
    assert.equal(getClipTranscriptAlignment(tracks, 'host-mic.webm', { fileName: 'elsewhere.webm' }).usable, false);
    assert.equal(getClipTranscriptAlignment(tracks, 'host-mic.webm', null).usable, false);
  });
});
