import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CLEANUP_OPTIONS,
  buildCleanedTranscriptText,
  buildCleanupPlan,
  formatRemovedTime,
  isFillerWord,
  skipCutAt,
  spliceAudioChannels,
  toCleanedTime,
  type CleanupOptions,
  type TranscriptWord,
} from '../src/utils/transcriptCleanup.ts';

const w = (word: string, start: number, end: number): TranscriptWord => ({ word, start, end });

// "Welcome, um, to the show. [2.6s pause] I I think we're ready."
const WORDS = [
  w('Welcome,', 0.5, 0.9),
  w('um,', 1.1, 1.4),
  w('to', 1.6, 1.7),
  w('the', 1.75, 1.9),
  w('show.', 1.95, 2.4),
  w('I', 5.0, 5.1),
  w('I', 5.2, 5.3),
  w('think', 5.35, 5.6),
  w("we're", 5.65, 5.9),
  w('ready.', 5.95, 6.4),
];

const opts = (overrides: Partial<CleanupOptions> = {}): CleanupOptions => ({ ...DEFAULT_CLEANUP_OPTIONS, ...overrides });

describe('transcript cleanup', () => {
  it('recognizes filler words regardless of punctuation and case', () => {
    for (const filler of ['um', 'Um,', 'uh...', 'UHM', 'hmm?', 'erm']) assert.equal(isFillerWord(filler), true, filler);
    for (const word of ['like', 'so', 'umbrella', 'I', 'hum']) assert.equal(isFillerWord(word), false, word);
  });

  it('cuts fillers, stutters, and long pauses into keep ranges', () => {
    const plan = buildCleanupPlan(WORDS, 7, opts());
    assert.deepEqual(plan.counts, { filler: 1, repeat: 1, manual: 0, pause: 1 });
    // The stuttered first "I" sits inside the long pause, so the pause cut removes it too.
    assert.deepEqual(plan.cuts.map((cut) => cut.reason), ['filler', 'pause']);

    const filler = plan.cuts.find((cut) => cut.reason === 'filler')!;
    assert.ok(filler.start >= 0.9 + 0.03 && filler.end <= 1.6 - 0.03, 'filler cut stays clear of its neighbours');
    const pause = plan.cuts.find((cut) => cut.reason === 'pause')!;
    assert.deepEqual([pause.start, pause.end], [2.6, 5], 'the pause up to the kept "I" keeps 0.2s on each side');
    assert.ok(pause.end <= 5.2, 'the second "I" is kept');

    assert.equal(buildCleanedTranscriptText(plan), "Welcome, to the show. I think we're ready.");
    assert.ok(Math.abs(plan.removedSeconds - (7 - plan.keepRanges.reduce((t, r) => t + r.endSeconds - r.startSeconds, 0))) < 0.002);
    for (let i = 1; i < plan.keepRanges.length; i += 1) {
      assert.ok(plan.keepRanges[i].startSeconds > plan.keepRanges[i - 1].endSeconds, 'keep ranges are ordered and disjoint');
    }
  });

  it('trims silence before the first word and after the last', () => {
    const plan = buildCleanupPlan([w('Hello', 3, 3.5), w('there.', 3.6, 4)], 9, opts());
    assert.deepEqual(plan.keepRanges, [{ startSeconds: 2.8, endSeconds: 4.2 }]);
    assert.equal(plan.counts.pause, 2);
  });

  it('honours restored cuts, manual cuts, and switched-off categories', () => {
    const base = buildCleanupPlan(WORDS, 7, opts());
    const pauseId = base.cuts.find((cut) => cut.reason === 'pause')!.id;
    const restored = buildCleanupPlan(WORDS, 7, opts({ restored: new Set(['word:1', pauseId]) }));
    assert.deepEqual(restored.counts, { filler: 0, repeat: 1, manual: 0, pause: 0 });
    assert.equal(restored.words[1].removed, false);
    assert.equal(restored.words[1].reason, 'filler', 'a restored filler is still marked, so it can be cut again');

    const manual = buildCleanupPlan(WORDS, 7, opts({ removeFillers: false, removeRepeats: false, shortenPauses: false, manualWords: new Set([8]) }));
    assert.deepEqual(manual.counts, { filler: 0, repeat: 0, manual: 1, pause: 0 });
    assert.equal(buildCleanedTranscriptText(manual), "Welcome, um, to the show. I I think ready.");

    const none = buildCleanupPlan(WORDS, 7, opts({ removeFillers: false, removeRepeats: false, shortenPauses: false }));
    assert.deepEqual(none.keepRanges, [{ startSeconds: 0, endSeconds: 7 }]);
    assert.equal(none.removedSeconds, 0);
  });

  it('cuts a stutter between words that flow together', () => {
    const plan = buildCleanupPlan([w('I', 1, 1.1), w('I', 1.2, 1.3), w('think.', 1.35, 1.7)], 2, opts({ shortenPauses: false }));
    assert.deepEqual(plan.cuts.map((cut) => [cut.reason, cut.start, cut.end]), [['repeat', 0.98, 1.12]]);
  });

  it('keeps deliberate repetition like "very, very"', () => {
    const plan = buildCleanupPlan([w('very,', 1, 1.3), w('very', 1.4, 1.7), w('good.', 1.75, 2)], 2, opts());
    assert.equal(plan.counts.repeat, 0);
  });

  it('absorbs a filler inside a long pause into that one pause cut', () => {
    const plan = buildCleanupPlan([w('So', 0, 0.3), w('uh', 1.5, 1.7), w('next.', 3.5, 3.9)], 4, opts());
    assert.deepEqual(plan.cuts.map((cut) => cut.reason), ['pause']);
    assert.deepEqual(plan.counts, { filler: 1, repeat: 0, manual: 0, pause: 1 });
  });

  it('skips cuts during preview and maps times onto the cleaned timeline', () => {
    const ranges = [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }];
    assert.equal(skipCutAt(ranges, 1), null);
    assert.equal(skipCutAt(ranges, 2.5), 3);
    assert.equal(skipCutAt(ranges, 6), Number.POSITIVE_INFINITY);
    assert.equal(toCleanedTime(ranges, 4), 3);
    assert.equal(toCleanedTime(ranges, 2.5), 2);
    assert.equal(formatRemovedTime(42.4), '42s');
    assert.equal(formatRemovedTime(125), '2m 5s');
  });

  it('splices audio with fades at the joins only', () => {
    const sampleRate = 1000;
    const channel = new Float32Array(3000).fill(1);
    const [out] = spliceAudioChannels([channel], sampleRate, [{ startSeconds: 0, endSeconds: 1 }, { startSeconds: 2, endSeconds: 3 }], 0.01);
    assert.equal(out.length, 2000);
    assert.equal(out[0], 1, 'the recording start is not faded');
    assert.ok(out[999] < 0.2 && out[1000] < 0.2, 'the join fades out and back in');
    assert.equal(out[500], 1);
    assert.equal(out[1999], 1, 'the recording end is not faded');
  });
});
