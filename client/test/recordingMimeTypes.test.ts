import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getBrowserRecordingFormatSummary,
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

  it('recognizes H.264 MP4 variants reported by Safari and Chromium builds', () => {
    const mimeType = getPreferredVideoRecordingMimeType(mediaRecorderSupporting(new Set([
      'video/webm;codecs=vp9,opus',
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
    ])));

    assert.equal(mimeType, 'video/mp4;codecs=avc1.640028,mp4a.40.2');
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

  it('summarizes browser local recording as MP4 plus M4A when both are supported', () => {
    const summary = getBrowserRecordingFormatSummary(mediaRecorderSupporting(new Set([
      'video/mp4',
      'audio/mp4',
      'video/webm',
    ])));

    assert.equal(summary.supportsVideoMp4, true);
    assert.equal(summary.supportsAudioMp4, true);
    assert.equal(summary.videoExtension, 'mp4');
    assert.equal(summary.audioExtension, 'm4a');
    assert.match(summary.label, /MP4/);
    assert.match(summary.detail, /program tracks as MP4/);
  });

  it('summarizes browser local recording fallback containers when MP4 is unavailable', () => {
    const summary = getBrowserRecordingFormatSummary(mediaRecorderSupporting(new Set([
      'video/webm;codecs=vp8,opus',
      'audio/webm',
    ])));

    assert.equal(summary.supportsVideoMp4, false);
    assert.equal(summary.supportsAudioMp4, false);
    assert.equal(summary.videoExtension, 'webm');
    assert.equal(summary.audioExtension, 'webm');
    assert.match(summary.label, /WEBM/);
    assert.match(summary.detail, /media-server export/);
  });

  it('summarizes unsupported local recording when MediaRecorder has no usable containers', () => {
    const summary = getBrowserRecordingFormatSummary(mediaRecorderSupporting(new Set()));

    assert.equal(summary.videoMimeType, '');
    assert.equal(summary.audioMimeType, '');
    assert.equal(summary.label, 'Local save unsupported');
    assert.match(summary.detail, /does not expose/);
  });
});
