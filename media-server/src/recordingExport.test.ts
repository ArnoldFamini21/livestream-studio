import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecordingAudioStemArgs,
  createRecordingExportCommands,
  createRecordingMp4Args,
  normalizeRecordingExportVideoOptions,
  sanitizeExportBasename,
  validateRecordingExportTracks,
  type RecordingExportTrack,
} from './recordingExport.js';

const programTrack: RecordingExportTrack = {
  id: 'program-mix',
  label: 'Program mix',
  kind: 'program',
  path: '/tmp/recordings/program.webm',
  mimeType: 'video/webm',
  hasAudio: true,
  hasVideo: true,
};

const hostAudioTrack: RecordingExportTrack = {
  id: 'host-audio',
  label: 'Host audio',
  kind: 'audio',
  path: '/tmp/recordings/host-audio.webm',
  mimeType: 'audio/webm',
  hasAudio: true,
};

describe('recording export FFmpeg command builders', () => {
  it('sanitizes export basenames for portable output files', () => {
    assert.equal(sanitizeExportBasename(' Launch <Demo> / Review '), 'Launch_Demo_Review');
    assert.equal(sanitizeExportBasename('...'), 'recording-export');
  });

  it('validates local recording export tracks', () => {
    assert.equal(validateRecordingExportTracks([programTrack, hostAudioTrack]), null);
    assert.match(validateRecordingExportTracks([]) || '', /required/);
    assert.match(validateRecordingExportTracks([{ ...programTrack, id: 'bad id' }]) || '', /id/);
    assert.match(validateRecordingExportTracks([{ ...programTrack, path: 'https://example.com/program.webm' }]) || '', /local file path/);
    assert.match(validateRecordingExportTracks([programTrack, { ...programTrack }]) || '', /unique/);
  });

  it('builds H.264/AAC MP4 args from the program mix track', () => {
    const command = createRecordingMp4Args({
      tracks: [hostAudioTrack, programTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
      video: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 12_000_000 },
      audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 192_000 },
    });

    assert.equal(command.outputPath, '/tmp/exports/Launch_Demo.mp4');
    assert.equal(command.args.includes('/tmp/recordings/program.webm'), true);
    assert.equal(command.args.includes('libx264'), true);
    assert.equal(command.args.includes('aac'), true);
    assert.equal(command.args.includes('+faststart'), true);
    assert.equal(command.args.includes('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1'), true);
    assert.equal(command.args.includes('[aout]'), false);
    assert.equal(command.args.at(-1), '/tmp/exports/Launch_Demo.mp4');
  });

  it('mixes isolated audio tracks when the selected video track has no usable audio', () => {
    const cameraTrack: RecordingExportTrack = {
      id: 'host-camera',
      label: 'Host camera',
      kind: 'video',
      path: '/tmp/recordings/host-camera.webm',
      mimeType: 'video/webm',
      hasAudio: false,
      hasVideo: true,
    };
    const guestAudioTrack: RecordingExportTrack = {
      id: 'guest-audio',
      label: 'Guest audio',
      kind: 'audio',
      path: '/tmp/recordings/guest-audio.webm',
      mimeType: 'audio/webm',
      hasAudio: true,
    };
    const command = createRecordingMp4Args({
      tracks: [cameraTrack, hostAudioTrack, guestAudioTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Audio Mix',
    });

    const filterIndex = command.args.indexOf('-filter_complex');
    assert.ok(filterIndex > -1);
    assert.match(command.args[filterIndex + 1], /\[1:a:0\]\[2:a:0\]amix=inputs=2/);
    assert.equal(command.args.includes('[vout]'), true);
    assert.equal(command.args.includes('[aout]'), true);
  });

  it('builds WAV and MP3 stem commands for isolated audio exports', () => {
    const wav = createRecordingAudioStemArgs(hostAudioTrack, '/tmp/exports', 'Launch Demo', 'wav', {
      sampleRate: 48_000,
      channelCount: 1,
    });
    const mp3 = createRecordingAudioStemArgs(hostAudioTrack, '/tmp/exports', 'Launch Demo', 'mp3', {
      sampleRate: 48_000,
      channelCount: 2,
      audioBitsPerSecond: 192_000,
    });

    assert.equal(wav.outputPath, '/tmp/exports/Launch_Demo_Host_audio.wav');
    assert.equal(wav.args.includes('pcm_s16le'), true);
    assert.equal(wav.args.includes('-vn'), true);
    assert.equal(mp3.outputPath, '/tmp/exports/Launch_Demo_Host_audio.mp3');
    assert.equal(mp3.args.includes('libmp3lame'), true);
    assert.equal(mp3.args.includes('192k'), true);
  });

  it('builds the full export command set with MP4 plus WAV/MP3 stems', () => {
    const commands = createRecordingExportCommands({
      tracks: [programTrack, hostAudioTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Full Export',
    });

    assert.equal(commands.mp4.outputPath, '/tmp/exports/Full_Export.mp4');
    assert.deepEqual(
      commands.stems.map((command) => command.outputPath),
      [
        '/tmp/exports/Full_Export_Program_mix.wav',
        '/tmp/exports/Full_Export_Program_mix.mp3',
        '/tmp/exports/Full_Export_Host_audio.wav',
        '/tmp/exports/Full_Export_Host_audio.mp3',
      ]
    );
  });

  it('bounds oversized output video settings to a 4K-class export', () => {
    const normalized = normalizeRecordingExportVideoOptions({
      width: 7680,
      height: 4320,
      frameRate: 120,
      videoBitsPerSecond: 100_000_000,
    });

    assert.ok(normalized.width * normalized.height <= 3840 * 2160);
    assert.equal(normalized.width % 2, 0);
    assert.equal(normalized.height % 2, 0);
    assert.equal(normalized.frameRate, 60);
    assert.equal(normalized.videoBitsPerSecond, 50_000_000);
  });
});
