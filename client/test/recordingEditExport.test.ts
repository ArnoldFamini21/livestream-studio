import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRecordingEditFileName,
  getRecordingEditDurationSeconds,
  getRecordingEditIssue,
  getRecordingEditProgress,
  MAX_BROWSER_EDIT_SEGMENTS,
} from '../src/utils/recordingEditExport.ts';

const segments = [
  { startSeconds: 0, endSeconds: 12.5 },
  { startSeconds: 14.25, endSeconds: 30 },
];

describe('browser edit export helpers', () => {
  it('measures the kept duration rather than the source span', () => {
    assert.equal(getRecordingEditDurationSeconds(segments), 28.25);
    assert.equal(getRecordingEditDurationSeconds([]), 0);
  });

  it('rejects edits the browser exporter cannot render', () => {
    assert.equal(getRecordingEditIssue(segments), null);
    assert.match(getRecordingEditIssue([]) || '', /removed everything/);
    assert.match(
      getRecordingEditIssue([{ startSeconds: 5, endSeconds: 4 }]) || '',
      /ends before it starts/
    );
    assert.match(
      getRecordingEditIssue([{ startSeconds: 0, endSeconds: 10 }, { startSeconds: 5, endSeconds: 20 }]) || '',
      /overlapping/
    );
    assert.match(
      getRecordingEditIssue([{ startSeconds: 0, endSeconds: 0.4 }]) || '',
      /less than a second/
    );
    assert.match(
      getRecordingEditIssue([{ startSeconds: 0, endSeconds: 3_601 }]) || '',
      /media server instead/
    );
    assert.match(
      getRecordingEditIssue(Array.from({ length: MAX_BROWSER_EDIT_SEGMENTS + 1 }, (_, index) => ({
        startSeconds: index * 2,
        endSeconds: index * 2 + 1,
      }))) || '',
      /media server instead/
    );
  });

  it('reports progress against the edited timeline, not the source timeline', () => {
    assert.equal(getRecordingEditProgress(segments, 0, 0), 0);
    // Halfway through the first kept range is 6.25s of 28.25s.
    assert.ok(Math.abs(getRecordingEditProgress(segments, 0, 6.25) - 6.25 / 28.25) < 1e-9);
    // The whole first range plus nothing of the second.
    assert.ok(Math.abs(getRecordingEditProgress(segments, 1, 14.25) - 12.5 / 28.25) < 1e-9);
    assert.equal(getRecordingEditProgress(segments, 1, 30), 1);
    assert.equal(getRecordingEditProgress([], 0, 5), 0);
  });

  it('names exports by kept duration and cut count', () => {
    assert.equal(
      buildRecordingEditFileName('Launch Demo', 'Program mix', segments, 'webm'),
      'Launch_Demo_edit_Program_mix_2x_0m28s.webm'
    );
  });
});
