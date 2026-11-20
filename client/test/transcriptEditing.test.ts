import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEditedClipCaptions,
  createTranscriptEditDraft,
  editTranscriptWordRange,
  limitTranscriptKeepRanges,
  type TranscriptEditDraft,
} from '../src/utils/transcriptEditing.ts';
import { buildCleanupPlan, DEFAULT_CLEANUP_OPTIONS, type TranscriptWord } from '../src/utils/transcriptCleanup.ts';

const transcript: TranscriptWord[] = [
  { word: 'Welcome.', start: 0.3, end: 0.7 },
  { word: 'um', start: 1, end: 1.3 },
  { word: 'delete', start: 1.8, end: 2 },
  { word: 'Thanks.', start: 2.4, end: 2.7 },
];

function plan(draft: TranscriptEditDraft) {
  return buildCleanupPlan(transcript, 3, {
    ...DEFAULT_CLEANUP_OPTIONS,
    removeFillers: draft.removeFillers,
    removeRepeats: draft.removeRepeats,
    shortenPauses: draft.shortenPauses,
    pauseThresholdSeconds: draft.pauseThreshold,
    manualWords: new Set(draft.manualWords),
    restored: new Set(draft.restored),
  });
}

test('cutting a passage removes its words and internal silence without changing the original transcript', () => {
  const original = structuredClone(transcript);
  const draft = createTranscriptEditDraft(false);
  const cut = editTranscriptWordRange(draft, plan(draft).words, [2, 1], true);
  const edited = plan(cut);
  assert.equal(edited.counts.manual, 2);
  assert.deepEqual(edited.keepRanges, [{ startSeconds: 0, endSeconds: 0.98 }, { startSeconds: 2.02, endSeconds: 3 }]);
  assert.deepEqual(transcript, original);
  assert.deepEqual(draft.manualWords, []);
  assert.deepEqual(plan(editTranscriptWordRange(cut, edited.words, [1, 2], false)).cuts, []);
});

test('restoring a passage can override automatic cuts, and can be edited again', () => {
  const draft = { ...createTranscriptEditDraft(false), removeFillers: true };
  assert.equal(plan(draft).words[1].removed, true);
  const restored = editTranscriptWordRange(draft, plan(draft).words, [1, 1], false);
  assert.equal(plan(restored).words[1].removed, false);
  const cut = editTranscriptWordRange(restored, plan(restored).words, [1, 1], true);
  assert.equal(plan(cut).words[1].removed, true);
  assert.equal(plan(editTranscriptWordRange(cut, plan(cut).words, [1, 1], false)).words[1].removed, false);
});

test('caption timing follows the exact exported excerpt and does not carry words across cuts', () => {
  const draft = createTranscriptEditDraft(false);
  const cut = editTranscriptWordRange(draft, plan(draft).words, [1, 2], true);
  const edited = plan(cut);
  const excerpt = limitTranscriptKeepRanges(edited.keepRanges, { startSeconds: 0.4, endSeconds: 2.6 });
  assert.deepEqual(excerpt, [{ startSeconds: 0.4, endSeconds: 0.98 }, { startSeconds: 2.02, endSeconds: 2.6 }]);
  const cues = buildEditedClipCaptions(edited.words, excerpt);
  const words = cues.flatMap((cue) => cue.words);
  assert.deepEqual(words.map((word) => word.text), ['Welcome.', 'Thanks.']);
  assert.equal(words[0].start, 0);
  assert.ok(Math.abs(words[1].start - 0.96) < 1e-6, 'second word shifts past the removed passage');
  assert.ok(cues.every((cue) => cue.start >= 0 && cue.end <= 1.16 + 1e-6));
  assert.deepEqual(buildEditedClipCaptions(edited.words, []), []);
});
