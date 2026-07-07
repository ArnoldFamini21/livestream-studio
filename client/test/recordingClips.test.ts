import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_CLIP_DURATION_SECONDS,
  buildClipFileName,
  buildClipLabel,
  clampClipRangeToDuration,
  formatClipTimecode,
  getClipCaptureProgress,
  getClipDurationSeconds,
  getClipFileExtension,
  getClipRangeIssue,
  getClipTrackKind,
  pickClipRecorderMimeType,
  roundClipSeconds,
} from '../src/utils/recordingClips.ts';

describe('getClipRangeIssue', () => {
  it('accepts a valid range inside the track duration', () => {
    assert.equal(getClipRangeIssue({ startSeconds: 5, endSeconds: 35 }, 120), null);
  });

  it('accepts a valid range when the track duration is unknown', () => {
    assert.equal(getClipRangeIssue({ startSeconds: 0, endSeconds: 12.5 }, null), null);
  });

  it('requires a start point', () => {
    assert.equal(getClipRangeIssue({ endSeconds: 10 }), 'Set a clip start point first');
    assert.equal(getClipRangeIssue({ startSeconds: Number.NaN, endSeconds: 10 }), 'Set a clip start point first');
    assert.equal(getClipRangeIssue({ startSeconds: -1, endSeconds: 10 }), 'Set a clip start point first');
  });

  it('requires an end point', () => {
    assert.equal(getClipRangeIssue({ startSeconds: 5 }), 'Set a clip end point first');
    assert.equal(getClipRangeIssue({ startSeconds: 5, endSeconds: Number.NaN }), 'Set a clip end point first');
  });

  it('rejects an end point at or before the start point', () => {
    assert.equal(
      getClipRangeIssue({ startSeconds: 20, endSeconds: 20 }),
      'The clip end must be after the clip start'
    );
    assert.equal(
      getClipRangeIssue({ startSeconds: 20, endSeconds: 8 }),
      'The clip end must be after the clip start'
    );
  });

  it('rejects clips shorter than the minimum duration', () => {
    assert.equal(
      getClipRangeIssue({ startSeconds: 10, endSeconds: 10.4 }),
      'Clips must be at least 1 second long'
    );
  });

  it('rejects clips longer than the maximum duration', () => {
    assert.equal(
      getClipRangeIssue({ startSeconds: 0, endSeconds: MAX_CLIP_DURATION_SECONDS + 1 }),
      `Clips are limited to ${Math.round(MAX_CLIP_DURATION_SECONDS / 60)} minutes`
    );
  });

  it('rejects a start point beyond the end of the track', () => {
    assert.equal(
      getClipRangeIssue({ startSeconds: 130, endSeconds: 140 }, 120),
      'The clip start is beyond the end of this track'
    );
  });
});

describe('clampClipRangeToDuration', () => {
  it('clamps the end point to the track duration', () => {
    assert.deepEqual(
      clampClipRangeToDuration({ startSeconds: 10, endSeconds: 500 }, 60),
      { startSeconds: 10, endSeconds: 60 }
    );
  });

  it('keeps the range unchanged when the duration is unknown', () => {
    assert.deepEqual(
      clampClipRangeToDuration({ startSeconds: 10, endSeconds: 500 }, null),
      { startSeconds: 10, endSeconds: 500 }
    );
    assert.deepEqual(
      clampClipRangeToDuration({ startSeconds: 10, endSeconds: 500 }, Number.POSITIVE_INFINITY),
      { startSeconds: 10, endSeconds: 500 }
    );
  });

  it('clamps negative start points to zero', () => {
    assert.deepEqual(
      clampClipRangeToDuration({ startSeconds: -3, endSeconds: 20 }, 60),
      { startSeconds: 0, endSeconds: 20 }
    );
  });

  it('keeps the end point at or after the clamped start point', () => {
    assert.deepEqual(
      clampClipRangeToDuration({ startSeconds: 80, endSeconds: 90 }, 60),
      { startSeconds: 60, endSeconds: 60 }
    );
  });
});

describe('formatClipTimecode', () => {
  it('formats minutes and seconds', () => {
    assert.equal(formatClipTimecode(0), '0:00');
    assert.equal(formatClipTimecode(65), '1:05');
  });

  it('includes hours for long recordings', () => {
    assert.equal(formatClipTimecode(3671), '1:01:11');
  });

  it('includes tenths of a second when present', () => {
    assert.equal(formatClipTimecode(12.34), '0:12.3');
    assert.equal(formatClipTimecode(12.0), '0:12');
  });

  it('falls back for invalid values', () => {
    assert.equal(formatClipTimecode(Number.NaN), '--:--');
    assert.equal(formatClipTimecode(-2), '--:--');
  });
});

describe('pickClipRecorderMimeType', () => {
  it('prefers VP9 WebM for video clips when supported', () => {
    assert.equal(
      pickClipRecorderMimeType(true, () => true),
      'video/webm;codecs=vp9,opus'
    );
  });

  it('falls back to MP4 when WebM is unsupported', () => {
    assert.equal(
      pickClipRecorderMimeType(true, (type) => type.startsWith('video/mp4')),
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
    );
  });

  it('uses audio candidates for audio-only clips', () => {
    assert.equal(
      pickClipRecorderMimeType(false, (type) => type === 'audio/webm'),
      'audio/webm'
    );
  });

  it('returns null when nothing is supported', () => {
    assert.equal(pickClipRecorderMimeType(true, () => false), null);
  });

  it('treats probe failures as unsupported', () => {
    assert.equal(
      pickClipRecorderMimeType(false, (type) => {
        if (type.includes('opus')) throw new Error('probe failed');
        return type === 'audio/webm';
      }),
      'audio/webm'
    );
  });
});

describe('getClipFileExtension', () => {
  it('maps container mime types to file extensions', () => {
    assert.equal(getClipFileExtension('video/webm;codecs=vp9,opus', true), 'webm');
    assert.equal(getClipFileExtension('audio/webm', false), 'webm');
    assert.equal(getClipFileExtension('video/mp4', true), 'mp4');
    assert.equal(getClipFileExtension('audio/mp4;codecs=mp4a.40.2', false), 'm4a');
  });

  it('falls back to webm for unknown types', () => {
    assert.equal(getClipFileExtension('application/octet-stream', true), 'webm');
    assert.equal(getClipFileExtension('', false), 'webm');
  });
});

describe('buildClipFileName', () => {
  it('builds a sanitized clip file name with the time range', () => {
    assert.equal(
      buildClipFileName('Launch <Demo> & Review', 'Host Camera', { startSeconds: 5, endSeconds: 65 }, 'webm'),
      'Launch_Demo_&_Review_clip_Host_Camera_0m05s-1m05s.webm'
    );
  });

  it('falls back when the source name is empty', () => {
    assert.equal(
      buildClipFileName('   ', '///', { startSeconds: 0, endSeconds: 30 }, 'mp4'),
      'clip_clip_clip_0m00s-0m30s.mp4'
    );
  });
});

describe('buildClipLabel', () => {
  it('describes the source track and range', () => {
    assert.equal(
      buildClipLabel('Host Camera', { startSeconds: 5, endSeconds: 65 }),
      'Host Camera clip 0:05-1:05'
    );
  });
});

describe('getClipCaptureProgress', () => {
  it('reports the fraction of the clip range covered', () => {
    const range = { startSeconds: 10, endSeconds: 20 };
    assert.equal(getClipCaptureProgress(10, range), 0);
    assert.equal(getClipCaptureProgress(15, range), 0.5);
    assert.equal(getClipCaptureProgress(20, range), 1);
  });

  it('clamps values outside the range', () => {
    const range = { startSeconds: 10, endSeconds: 20 };
    assert.equal(getClipCaptureProgress(5, range), 0);
    assert.equal(getClipCaptureProgress(50, range), 1);
    assert.equal(getClipCaptureProgress(Number.NaN, range), 0);
  });

  it('returns zero for an empty range', () => {
    assert.equal(getClipCaptureProgress(10, { startSeconds: 10, endSeconds: 10 }), 0);
  });
});

describe('getClipDurationSeconds', () => {
  it('returns the clip length', () => {
    assert.equal(getClipDurationSeconds({ startSeconds: 5, endSeconds: 35 }), 30);
  });

  it('never returns a negative duration', () => {
    assert.equal(getClipDurationSeconds({ startSeconds: 35, endSeconds: 5 }), 0);
  });
});

describe('roundClipSeconds', () => {
  it('rounds to tenths of a second', () => {
    assert.equal(roundClipSeconds(12.345), 12.3);
    assert.equal(roundClipSeconds(12.35), 12.4);
  });
});

describe('getClipTrackKind', () => {
  it('keeps audio and screen source kinds', () => {
    assert.equal(getClipTrackKind('audio', false), 'audio');
    assert.equal(getClipTrackKind('screen', true), 'screen');
  });

  it('keeps video-like kinds for video captures', () => {
    assert.equal(getClipTrackKind('video', true), 'video');
    assert.equal(getClipTrackKind('program', true), 'program');
    assert.equal(getClipTrackKind('iso', true), 'iso');
  });

  it('downgrades video-like kinds for audio-only captures', () => {
    assert.equal(getClipTrackKind('program', false), 'audio');
  });

  it('infers a kind when the source kind is unknown', () => {
    assert.equal(getClipTrackKind(undefined, true), 'video');
    assert.equal(getClipTrackKind(undefined, false), 'audio');
  });
});
