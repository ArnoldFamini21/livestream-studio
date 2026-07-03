import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getBrowserRecordingFormatSummary,
  getPreferredAudioRecordingMimeType,
  getPreferredVideoRecordingMimeType,
  getRecordingBlobFormatKind,
  getRecordingFileExtension,
  summarizeRecordingFileFormats,
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

  it('classifies recording blobs by the saved local file format', () => {
    assert.equal(getRecordingBlobFormatKind(new Blob(['video'], { type: 'video/mp4' })), 'mp4-video');
    assert.equal(getRecordingBlobFormatKind(new Blob(['audio'], { type: 'audio/mp4;codecs=mp4a.40.2' })), 'm4a-audio');
    assert.equal(getRecordingBlobFormatKind(new Blob(['video'], { type: 'video/webm;codecs=vp9,opus' })), 'webm');
    assert.equal(getRecordingBlobFormatKind(new Blob(['data'], { type: 'application/octet-stream' })), 'other');
  });

  it('summarizes browser-native MP4-compatible fallback recording files', () => {
    const summary = summarizeRecordingFileFormats([
      { blob: new Blob(['program'], { type: 'video/mp4;codecs=avc1,mp4a.40.2' }) },
      { blob: new Blob(['mic'], { type: 'audio/mp4' }) },
    ]);

    assert.equal(summary.totalFiles, 2);
    assert.equal(summary.mp4VideoCount, 1);
    assert.equal(summary.m4aAudioCount, 1);
    assert.equal(summary.webmCount, 0);
    assert.equal(summary.allBrowserMp4Compatible, true);
    assert.equal(summary.hasBrowserMp4CompatibleFiles, true);
    assert.match(summary.label, /MP4\/M4A/);
    assert.match(summary.detail, /without WebM fallback/);
  });

  it('summarizes mixed browser fallback recording files', () => {
    const summary = summarizeRecordingFileFormats([
      { blob: new Blob(['program'], { type: 'video/mp4' }) },
      { blob: new Blob(['guest'], { type: 'video/webm;codecs=vp8,opus' }) },
    ]);

    assert.equal(summary.totalFiles, 2);
    assert.equal(summary.mp4VideoCount, 1);
    assert.equal(summary.webmCount, 1);
    assert.equal(summary.allBrowserMp4Compatible, false);
    assert.equal(summary.hasBrowserMp4CompatibleFiles, true);
    assert.match(summary.label, /Mixed MP4\/WebM/);
    assert.match(summary.detail, /single final MP4 mix/);
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
