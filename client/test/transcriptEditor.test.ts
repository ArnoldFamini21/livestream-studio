import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTranscriptEditorDocument,
  buildTranscriptEdl,
  findTranscriptFillerRuns,
  findTranscriptSilenceGaps,
  getKeptTranscriptText,
  isTranscriptEditEmpty,
  mapSourceTimeToEditedTime,
  normalizeTranscriptWordText,
  summarizeTranscriptEdit,
} from '../src/utils/transcriptEditor.ts';

function words(entries: Array<[string, number, number]>) {
  return entries.map(([text, startSeconds, endSeconds]) => ({ text, startSeconds, endSeconds }));
}

const SAMPLE = words([
  ['So', 0, 0.3],
  ['um', 0.32, 0.6],
  ['welcome', 0.62, 1.1],
  ['to', 1.1, 1.2],
  ['the', 1.2, 1.35],
  ['show.', 1.35, 1.9],
  ['Today', 3.4, 3.9],
  ['we', 3.9, 4.0],
  ['ship.', 4.0, 4.6],
]);

describe('transcript editor document', () => {
  it('normalizes words into a monotonic timeline with gap metadata', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 5.5);

    assert.equal(doc.words.length, 9);
    assert.equal(doc.durationSeconds, 5.5);
    assert.equal(doc.words[0].id, 'w0');
    assert.equal(doc.words[1].normalized, 'um');
    assert.equal(doc.words[5].normalized, 'show');
    assert.equal(doc.words[6].gapBeforeSeconds, 1.5);
  });

  it('drops unusable timings and repairs overlapping words', () => {
    const doc = buildTranscriptEditorDocument(words([
      ['first', 1, 2],
      ['overlapping', 1.5, 2.5],
      ['  ', 3, 3.5],
      ['backwards', 5, 4],
    ]));

    assert.deepEqual(doc.words.map((word) => word.text), ['first', 'overlapping']);
    assert.equal(doc.words[1].startSeconds, 2);
    assert.equal(doc.words[1].endSeconds, 2.5);
    assert.equal(doc.durationSeconds, 2.5);
  });

  it('falls back to the last word end when no duration is supplied', () => {
    assert.equal(buildTranscriptEditorDocument(SAMPLE).durationSeconds, 4.6);
    assert.equal(buildTranscriptEditorDocument([]).durationSeconds, 0);
  });

  it('strips punctuation when normalizing words for matching', () => {
    assert.equal(normalizeTranscriptWordText('Um,'), 'um');
    assert.equal(normalizeTranscriptWordText("don't."), "don't");
    assert.equal(normalizeTranscriptWordText('—'), '');
  });
});

describe('transcript silence detection', () => {
  it('reports gaps over the threshold, including a trailing gap', () => {
    const gaps = findTranscriptSilenceGaps(buildTranscriptEditorDocument(SAMPLE, 5.5));

    assert.deepEqual(gaps.map((gap) => gap.id), ['g6', 'g9']);
    assert.deepEqual(gaps[0], {
      id: 'g6',
      startSeconds: 1.9,
      endSeconds: 3.4,
      durationSeconds: 1.5,
      beforeWordIndex: 6,
    });
    assert.equal(gaps[1].durationSeconds, 0.9);
  });

  it('honors a custom threshold', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 4.6);
    assert.equal(findTranscriptSilenceGaps(doc, 2).length, 0);
    assert.equal(findTranscriptSilenceGaps(doc, 0.01).length, 3);
  });
});

describe('transcript filler detection', () => {
  it('finds filler words and groups adjacent ones into a single run', () => {
    const doc = buildTranscriptEditorDocument(words([
      ['Well', 0, 0.4],
      ['um', 0.4, 0.6],
      ['uh', 0.6, 0.8],
      ['here', 0.8, 1.2],
      ['we', 1.2, 1.3],
      ['are', 1.3, 1.6],
      ['hmm', 1.6, 1.9],
    ]));
    const runs = findTranscriptFillerRuns(doc);

    assert.deepEqual(runs.map((run) => run.text), ['um uh', 'hmm']);
    assert.deepEqual(runs[0].wordIds, ['w1', 'w2']);
    assert.equal(runs[0].startSeconds, 0.4);
    assert.equal(runs[0].endSeconds, 0.8);
  });

  it('leaves hedges and crutch phrases alone unless they are opted in', () => {
    const doc = buildTranscriptEditorDocument(words([
      ['I', 0, 0.2],
      ['like', 0.2, 0.5],
      ['you', 0.5, 0.7],
      ['know', 0.7, 0.9],
      ['this', 0.9, 1.2],
    ]));

    assert.deepEqual(findTranscriptFillerRuns(doc), []);
    assert.deepEqual(
      findTranscriptFillerRuns(doc, { includePhrases: true }).map((run) => run.text),
      ['you know']
    );
    assert.deepEqual(
      findTranscriptFillerRuns(doc, { includePhrases: true, includeHedges: true }).map((run) => run.text),
      ['like you know']
    );
  });
});

describe('transcript EDL', () => {
  it('returns the whole source when nothing is removed', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 5.5);
    const edl = buildTranscriptEdl(doc);

    assert.deepEqual(edl.segments, [{ startSeconds: 0, endSeconds: 5.5 }]);
    assert.equal(edl.keptSeconds, 5.5);
    assert.equal(edl.removedSeconds, 0);
    assert.equal(isTranscriptEditEmpty(edl), true);
  });

  it('cuts removed words with an inward pad that protects neighbouring onsets', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 5.5);
    const edl = buildTranscriptEdl(doc, { removedWordIds: ['w1'] }, { padSeconds: 0.04 });

    assert.deepEqual(edl.segments, [
      { startSeconds: 0, endSeconds: 0.36 },
      { startSeconds: 0.56, endSeconds: 5.5 },
    ]);
    assert.equal(edl.removedSeconds, 0.2);
    assert.equal(isTranscriptEditEmpty(edl), false);
  });

  it('merges neighbouring cuts instead of leaving unusable slivers', () => {
    const doc = buildTranscriptEditorDocument(words([
      ['So', 0, 0.3],
      ['um', 0.32, 0.6],
      ['uh', 0.62, 0.9],
      ['right', 0.92, 1.4],
    ]), 1.4);
    const edl = buildTranscriptEdl(doc, { removedWordIds: ['w1', 'w2'] });

    assert.deepEqual(edl.segments, [
      { startSeconds: 0, endSeconds: 0.36 },
      { startSeconds: 0.86, endSeconds: 1.4 },
    ]);
  });

  it('trims silence gaps down to a residual pause', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 4.6);
    const edl = buildTranscriptEdl(doc, { trimmedGapIds: ['g6'] }, { padSeconds: 0, silenceKeepSeconds: 0.25 });

    assert.deepEqual(edl.segments, [
      { startSeconds: 0, endSeconds: 2.025 },
      { startSeconds: 3.275, endSeconds: 4.6 },
    ]);
    assert.equal(edl.removedSeconds, 1.25);
  });

  it('drops word-free slivers that are too short to be watchable', () => {
    const doc = buildTranscriptEditorDocument(words([
      ['keep', 0, 2],
      ['cut', 2, 2.5],
      ['cut', 2.6, 3.1],
      ['keep', 3.1, 6],
    ]), 6);
    const edl = buildTranscriptEdl(
      doc,
      { removedWordIds: ['w1', 'w2'] },
      { padSeconds: 0, mergeCutGapSeconds: 0, minSegmentSeconds: 0.35 }
    );

    // The 0.1s of silence between the two cuts holds no surviving word.
    assert.deepEqual(edl.segments, [
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 3.1, endSeconds: 6 },
    ]);
  });

  it('keeps a short segment when a surviving word sits inside it', () => {
    const doc = buildTranscriptEditorDocument(words([
      ['So', 0, 0.3],
      ['um', 0.32, 0.6],
      ['ship.', 0.62, 2.4],
    ]), 2.4);
    const edl = buildTranscriptEdl(doc, { removedWordIds: ['w1'] }, { padSeconds: 0, minSegmentSeconds: 0.35 });

    // "So" only spans 0.3s but the host never asked for it to go.
    assert.deepEqual(edl.segments, [
      { startSeconds: 0, endSeconds: 0.32 },
      { startSeconds: 0.6, endSeconds: 2.4 },
    ]);
  });

  it('abandons the smallest cuts rather than truncating the timeline', () => {
    const entries: Array<[string, number, number]> = [];
    for (let index = 0; index < 900; index += 1) {
      entries.push([index % 2 === 0 ? 'keep' : 'um', index * 0.5, index * 0.5 + 0.4]);
    }
    const doc = buildTranscriptEditorDocument(words(entries), 450);
    const removedWordIds = doc.words.filter((word) => word.normalized === 'um').map((word) => word.id);
    const edl = buildTranscriptEdl(doc, { removedWordIds }, { padSeconds: 0, mergeCutGapSeconds: 0 });

    assert.ok(edl.segments.length <= 400, `expected at most 400 segments, got ${edl.segments.length}`);
    // The recording still runs end to end; only some cuts were given up.
    assert.equal(edl.segments[0].startSeconds, 0);
    assert.equal(edl.segments[edl.segments.length - 1].endSeconds, 450);
    assert.ok(edl.removedSeconds > 0);
  });

  it('ignores unknown ids and handles an empty document', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 5.5);
    assert.deepEqual(
      buildTranscriptEdl(doc, { removedWordIds: ['nope'], trimmedGapIds: ['nope'] }).segments,
      [{ startSeconds: 0, endSeconds: 5.5 }]
    );
    assert.deepEqual(buildTranscriptEdl(buildTranscriptEditorDocument([])), {
      segments: [],
      sourceDurationSeconds: 0,
      keptSeconds: 0,
      removedSeconds: 0,
    });
  });
});

describe('transcript edit summary', () => {
  it('reports what the edit removed and how much tighter the result is', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 4.6);
    const summary = summarizeTranscriptEdit(
      doc,
      { removedWordIds: ['w1', 'unknown'], trimmedGapIds: ['g6', 'unknown'] },
      { padSeconds: 0 }
    );

    assert.equal(summary.removedWordCount, 1);
    assert.equal(summary.trimmedSilenceCount, 1);
    assert.equal(summary.sourceDurationSeconds, 4.6);
    assert.equal(summary.keptSeconds, 3.07);
    assert.equal(summary.removedSeconds, 1.53);
    assert.equal(summary.segmentCount, 3);
    assert.ok(summary.tightenedFraction > 0.33 && summary.tightenedFraction < 0.34);
  });

  it('reads back the transcript that survives the edit', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 4.6);
    assert.equal(
      getKeptTranscriptText(doc, { removedWordIds: ['w1'] }),
      'So welcome to the show. Today we ship.'
    );
  });
});

describe('edited timeline mapping', () => {
  it('maps surviving source time forward and rejects removed time', () => {
    const doc = buildTranscriptEditorDocument(SAMPLE, 4.6);
    const edl = buildTranscriptEdl(doc, { removedWordIds: ['w1'] }, { padSeconds: 0 });

    assert.equal(mapSourceTimeToEditedTime(edl, 0.2), 0.2);
    assert.equal(mapSourceTimeToEditedTime(edl, 0.45), null);
    assert.equal(mapSourceTimeToEditedTime(edl, 0.7), 0.42);
    assert.equal(mapSourceTimeToEditedTime(edl, -1), null);
    assert.equal(mapSourceTimeToEditedTime(edl, 99), null);
  });
});
