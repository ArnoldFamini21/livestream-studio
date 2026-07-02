import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getPreferredAudioRecordingMimeType,
  getPreferredVideoRecordingMimeType,
  getRecordingFileExtension,
} from '../src/utils/recordingMimeTypes.ts';

function mediaRecorderSupporting(types: Set<string>) {
  return {
    isTypeSupported: (mimeType: string) => types.has(mimeType),
  };
}

describe('recording MIME type helpers', () => {
  it('prefers MP4 video recording when the browser supports it', () => {
    const mimeType = getPreferredVideoRecordingMimeType(mediaRecorderSupporting(new Set([
      'video/webm;codecs=vp9,opus',
      'video/mp4',
    ])));

    assert.equal(mimeType, 'video/mp4');
  });

  it('falls back to WebM video recording when MP4 is unavailable', () => {
    const mimeType = getPreferredVideoRecordingMimeType(mediaRecorderSupporting(new Set([
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ])));

    assert.equal(mimeType, 'video/webm;codecs=vp8,opus');
  });

  it('uses m4a extensions for audio-only MP4 recordings', () => {
    assert.equal(getPreferredAudioRecordingMimeType(mediaRecorderSupporting(new Set(['audio/mp4']))), 'audio/mp4');
    assert.equal(getRecordingFileExtension('audio/mp4;codecs=mp4a.40.2'), 'm4a');
    assert.equal(getRecordingFileExtension('video/mp4;codecs=avc1.42E01E,mp4a.40.2'), 'mp4');
    assert.equal(getRecordingFileExtension('video/webm;codecs=vp9,opus'), 'webm');
  });
});
