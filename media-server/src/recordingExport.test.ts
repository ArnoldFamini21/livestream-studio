import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecordingAudioStemArgs,
  createRecordingExportCommands,
  createRecordingIsolatedVideoArgs,
  createRecordingMp4Args,
  getClipVideoGeometry,
  getRecordingExportClipIssue,
  normalizeRecordingExportClipRange,
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

const hostVideoTrack: RecordingExportTrack = {
  id: 'host-camera',
  label: 'Host camera',
  kind: 'video',
  path: '/tmp/recordings/host-camera.webm',
  mimeType: 'video/webm',
  hasAudio: true,
  hasVideo: true,
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

  it('builds H.265/AAC MP4 args with Apple-compatible HEVC tagging', () => {
    const command = createRecordingMp4Args({
      tracks: [programTrack],
      outputDirectory: '/tmp/exports',
      basename: 'HEVC Demo',
      video: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 10_000_000, codec: 'h265' },
    });

    assert.equal(command.outputPath, '/tmp/exports/HEVC_Demo.mp4');
    assert.equal(command.args.includes('libx265'), true);
    assert.equal(command.args.includes('libx264'), false);
    assert.equal(command.args.includes('-tag:v'), true);
    assert.equal(command.args.includes('hvc1'), true);
    assert.equal(command.args.includes('-x265-params'), true);
    assert.equal(command.args.includes('log-level=error'), true);
    assert.equal(command.args.includes('+faststart'), true);
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

  it('builds isolated MP4 args for participant video exports', () => {
    const command = createRecordingIsolatedVideoArgs(hostVideoTrack, '/tmp/exports', 'Launch Demo', {
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitsPerSecond: 6_000_000,
    });

    assert.equal(command.artifactId, 'isolated-video-host-camera');
    assert.equal(command.outputPath, '/tmp/exports/Launch_Demo_Host_camera_video.mp4');
    assert.equal(command.args.includes('/tmp/recordings/host-camera.webm'), true);
    assert.equal(command.args.includes('libx264'), true);
    assert.equal(command.args.includes('aac'), true);
    assert.equal(command.args.includes('-map'), true);
    assert.equal(command.args.includes('0:v:0'), true);
    assert.equal(command.args.includes('0:a:0?'), true);
    assert.equal(command.args.includes('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1'), true);
  });

  it('uses H.265 for isolated participant MP4 exports when requested', () => {
    const command = createRecordingIsolatedVideoArgs(hostVideoTrack, '/tmp/exports', 'Launch Demo', {
      codec: 'h265',
    });

    assert.equal(command.args.includes('libx265'), true);
    assert.equal(command.args.includes('libx264'), false);
    assert.equal(command.args.includes('hvc1'), true);
    assert.equal(command.args.includes('aac'), true);
  });

  it('builds the full export command set with MP4 plus WAV/MP3 stems', () => {
    const commands = createRecordingExportCommands({
      tracks: [programTrack, hostVideoTrack, hostAudioTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Full Export',
    });

    assert.equal(commands.mp4.outputPath, '/tmp/exports/Full_Export.mp4');
    assert.deepEqual(
      commands.isolatedVideos.map((command) => [command.artifactId, command.outputPath]),
      [
        ['isolated-video-host-camera', '/tmp/exports/Full_Export_Host_camera_video.mp4'],
      ]
    );
    assert.deepEqual(
      commands.stems.map((command) => command.outputPath),
      [
        '/tmp/exports/Full_Export_Program_mix.wav',
        '/tmp/exports/Full_Export_Program_mix.mp3',
        '/tmp/exports/Full_Export_Host_camera.wav',
        '/tmp/exports/Full_Export_Host_camera.mp3',
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
    assert.equal(normalized.codec, 'h264');
  });

  it('normalizes optional export video codecs', () => {
    assert.equal(normalizeRecordingExportVideoOptions({ codec: 'h265' }).codec, 'h265');
    assert.equal(normalizeRecordingExportVideoOptions({ codec: 'h264' }).codec, 'h264');
    assert.equal(normalizeRecordingExportVideoOptions({ codec: 'vp9' as never }).codec, 'h264');
  });
});

describe('recording export clip ranges', () => {
  it('accepts valid clip ranges and rejects invalid ones', () => {
    assert.equal(getRecordingExportClipIssue(null), null);
    assert.equal(getRecordingExportClipIssue(undefined), null);
    assert.equal(getRecordingExportClipIssue({ startSeconds: 5, endSeconds: 65 }), null);
    assert.match(getRecordingExportClipIssue({ startSeconds: -1, endSeconds: 10 }) || '', /start/i);
    assert.match(getRecordingExportClipIssue({ startSeconds: 5 }) || '', /end/i);
    assert.match(getRecordingExportClipIssue({ startSeconds: 10, endSeconds: 10 }) || '', /after/i);
    assert.match(getRecordingExportClipIssue({ startSeconds: 10, endSeconds: 10.2 }) || '', /at least/i);
    assert.match(getRecordingExportClipIssue({ startSeconds: 0, endSeconds: 7 * 60 * 60 }) || '', /limited/i);
    assert.match(getRecordingExportClipIssue({ startSeconds: 'x', endSeconds: 10 }) || '', /start/i);
    assert.match(getRecordingExportClipIssue('clip') || '', /invalid/i);
  });

  it('normalizes clip ranges to millisecond precision', () => {
    assert.deepEqual(
      normalizeRecordingExportClipRange({ startSeconds: 1.23456, endSeconds: 30.98765 }),
      { startSeconds: 1.235, endSeconds: 30.988, aspect: 'source' }
    );
    assert.equal(normalizeRecordingExportClipRange(null), null);
    assert.throws(() => normalizeRecordingExportClipRange({ startSeconds: 20, endSeconds: 5 }), /after/);
  });

  it('trims the final MP4 with an input seek and output duration', () => {
    const command = createRecordingMp4Args({
      tracks: [hostAudioTrack, hostVideoTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
      clip: { startSeconds: 5, endSeconds: 65 },
    });

    assert.equal(command.outputPath, '/tmp/exports/Launch_Demo_clip_0m05s-1m05s.mp4');
    assert.equal(command.label, 'Final MP4 clip');
    const firstSeek = command.args.indexOf('-ss');
    assert.ok(firstSeek > -1);
    assert.equal(command.args[firstSeek + 1], '5.000');
    assert.equal(command.args[firstSeek + 2], '-i');
    assert.equal(command.args.filter((arg) => arg === '-ss').length, 2);
    const durationIndex = command.args.indexOf('-t');
    assert.ok(durationIndex > -1);
    assert.equal(command.args[durationIndex + 1], '60.000');
    assert.ok(durationIndex < command.args.indexOf('-movflags'));
  });

  it('seeks every input before mixing clipped audio tracks', () => {
    const command = createRecordingMp4Args({
      tracks: [hostAudioTrack, hostVideoTrack, { ...hostAudioTrack, id: 'guest-audio', label: 'Guest audio', path: '/tmp/recordings/guest-audio.webm' }],
      outputDirectory: '/tmp/exports',
      basename: 'Clip Mix',
      clip: { startSeconds: 2.5, endSeconds: 12.5 },
    });

    const inputCount = command.args.filter((arg) => arg === '-i').length;
    const seekCount = command.args.filter((arg) => arg === '-ss').length;
    assert.equal(seekCount, inputCount);
    command.args.forEach((arg, index) => {
      if (arg === '-ss') {
        assert.equal(command.args[index + 1], '2.500');
        assert.equal(command.args[index + 2], '-i');
      }
    });
  });

  it('applies clip ranges to isolated videos and audio stems', () => {
    const isolated = createRecordingIsolatedVideoArgs(
      hostVideoTrack,
      '/tmp/exports',
      'Launch_Demo',
      {},
      {},
      { startSeconds: 5, endSeconds: 65 }
    );
    const stem = createRecordingAudioStemArgs(
      hostAudioTrack,
      '/tmp/exports',
      'Launch_Demo',
      'wav',
      {},
      { startSeconds: 5, endSeconds: 65 }
    );

    assert.equal(isolated.outputPath, '/tmp/exports/Launch_Demo_Host_camera_video_clip_0m05s-1m05s.mp4');
    assert.equal(isolated.label, 'Host camera isolated MP4 clip');
    assert.equal(isolated.args[isolated.args.indexOf('-ss') + 1], '5.000');
    assert.equal(isolated.args[isolated.args.indexOf('-t') + 1], '60.000');
    assert.equal(stem.outputPath, '/tmp/exports/Launch_Demo_Host_audio_clip_0m05s-1m05s.wav');
    assert.equal(stem.label, 'Host audio WAV stem clip');
    assert.equal(stem.args[stem.args.indexOf('-ss') + 1], '5.000');
    assert.equal(stem.args[stem.args.indexOf('-t') + 1], '60.000');
  });

  it('threads the clip range through full export command plans', () => {
    const commands = createRecordingExportCommands({
      tracks: [hostAudioTrack, hostVideoTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
      clip: { startSeconds: 0, endSeconds: 30 },
    });

    assert.ok(commands.mp4.outputPath.includes('_clip_0m00s-0m30s'));
    for (const command of [commands.mp4, ...commands.isolatedVideos, ...commands.stems]) {
      assert.ok(command.args.includes('-ss'), `${command.label} should seek to the clip start`);
      assert.ok(command.args.includes('-t'), `${command.label} should bound the clip duration`);
    }
  });

  it('leaves commands untouched when no clip range is set', () => {
    const commands = createRecordingExportCommands({
      tracks: [hostAudioTrack, hostVideoTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
    });

    for (const command of [commands.mp4, ...commands.isolatedVideos, ...commands.stems]) {
      assert.equal(command.args.includes('-ss'), false);
      assert.equal(command.args.includes('-t'), false);
      assert.equal(command.outputPath.includes('_clip_'), false);
    }
  });
});

describe('recording export clip aspect presets', () => {
  it('validates clip aspect values', () => {
    assert.equal(getRecordingExportClipIssue({ startSeconds: 0, endSeconds: 30, aspect: 'vertical' }), null);
    assert.equal(getRecordingExportClipIssue({ startSeconds: 0, endSeconds: 30, aspect: 'square' }), null);
    assert.match(
      getRecordingExportClipIssue({ startSeconds: 0, endSeconds: 30, aspect: 'portrait' }) || '',
      /aspect/i
    );
  });

  it('normalizes missing aspect to source', () => {
    assert.deepEqual(
      normalizeRecordingExportClipRange({ startSeconds: 0, endSeconds: 30 }),
      { startSeconds: 0, endSeconds: 30, aspect: 'source' }
    );
    assert.equal(
      normalizeRecordingExportClipRange({ startSeconds: 0, endSeconds: 30, aspect: 'vertical' })?.aspect,
      'vertical'
    );
  });

  it('computes cover-crop geometry for vertical and square clips', () => {
    const video = normalizeRecordingExportVideoOptions({ width: 1920, height: 1080 });
    const vertical = getClipVideoGeometry(video, { startSeconds: 0, endSeconds: 30, aspect: 'vertical' });
    assert.equal(vertical.height, 1080);
    assert.equal(vertical.width, 608);
    assert.equal(vertical.width % 2, 0);
    assert.match(vertical.filter, /force_original_aspect_ratio=increase,crop=608:1080/);

    const square = getClipVideoGeometry(video, { startSeconds: 0, endSeconds: 30, aspect: 'square' });
    assert.equal(square.width, 1080);
    assert.equal(square.height, 1080);
    assert.match(square.filter, /crop=1080:1080/);

    const source = getClipVideoGeometry(video, { startSeconds: 0, endSeconds: 30, aspect: 'source' });
    assert.equal(source.width, 1920);
    assert.match(source.filter, /force_original_aspect_ratio=decrease,pad=1920:1080/);
  });

  it('uses the crop filter and aspect suffix in vertical clip MP4 commands', () => {
    const command = createRecordingMp4Args({
      tracks: [hostVideoTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
      clip: { startSeconds: 5, endSeconds: 65, aspect: 'vertical' },
    });

    assert.equal(command.outputPath, '/tmp/exports/Launch_Demo_clip_0m05s-1m05s_9x16.mp4');
    assert.equal(
      command.args.includes('scale=608:1080:force_original_aspect_ratio=increase,crop=608:1080,setsar=1'),
      true
    );
  });

  it('applies square aspect to isolated clip exports', () => {
    const command = createRecordingIsolatedVideoArgs(
      hostVideoTrack,
      '/tmp/exports',
      'Launch_Demo',
      {},
      {},
      { startSeconds: 0, endSeconds: 30, aspect: 'square' }
    );

    assert.match(command.outputPath, /_clip_0m00s-0m30s_1x1\.mp4$/);
    assert.equal(
      command.args.includes('scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,setsar=1'),
      true
    );
  });
});

describe('recording export audio normalization', () => {
  it('leaves audio filters untouched by default', () => {
    const command = createRecordingMp4Args({
      tracks: [hostAudioTrack, hostVideoTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
    });
    assert.equal(command.args.some((arg) => typeof arg === 'string' && arg.includes('loudnorm')), false);
  });

  it('chains loudnorm after the amix filter for mixed audio', () => {
    const command = createRecordingMp4Args({
      tracks: [hostAudioTrack, hostVideoTrack, { ...hostAudioTrack, id: 'guest-audio', label: 'Guest audio', path: '/tmp/recordings/guest-audio.webm' }],
      outputDirectory: '/tmp/exports',
      basename: 'Louder Demo',
      normalizeAudio: true,
    });
    const filterIndex = command.args.indexOf('-filter_complex');
    assert.ok(filterIndex > -1);
    assert.match(command.args[filterIndex + 1], /amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:TP=-1\.5:LRA=11\[aout\]/);
  });

  it('normalizes the program mix single-audio path with -af', () => {
    const command = createRecordingMp4Args({
      tracks: [programTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Program Demo',
      normalizeAudio: true,
    });
    const afIndex = command.args.indexOf('-af');
    assert.ok(afIndex > -1);
    assert.equal(command.args[afIndex + 1], 'loudnorm=I=-14:TP=-1.5:LRA=11');
  });

  it('does not add -af when the primary track has no audio', () => {
    const silentVideo = { ...hostVideoTrack, hasAudio: false };
    const command = createRecordingMp4Args({
      tracks: [silentVideo],
      outputDirectory: '/tmp/exports',
      basename: 'Silent Demo',
      normalizeAudio: true,
    });
    assert.equal(command.args.includes('-af'), false);
  });

  it('normalizes WAV and MP3 stems when requested', () => {
    const wav = createRecordingAudioStemArgs(hostAudioTrack, '/tmp/exports', 'Launch Demo', 'wav', {}, null, true);
    const mp3 = createRecordingAudioStemArgs(hostAudioTrack, '/tmp/exports', 'Launch Demo', 'mp3', {}, null, false);
    assert.equal(wav.args.includes('-af'), true);
    assert.equal(wav.args[wav.args.indexOf('-af') + 1], 'loudnorm=I=-14:TP=-1.5:LRA=11');
    assert.equal(mp3.args.includes('-af'), false);
  });

  it('threads normalizeAudio through full export command plans', () => {
    const commands = createRecordingExportCommands({
      tracks: [hostAudioTrack, hostVideoTrack],
      outputDirectory: '/tmp/exports',
      basename: 'Launch Demo',
      normalizeAudio: true,
    });
    assert.ok(commands.mp4.args.some((arg) => typeof arg === 'string' && arg.includes('loudnorm')));
    assert.ok(commands.stems.every((stem) => stem.args.includes('-af')));
  });
});
