import assert from 'node:assert/strict';
import test from 'node:test';
import { getCleanedDurationSeconds, getTrackAlignmentSeconds, mapKeepRangesToTrack } from '../src/utils/editListExport.ts';
import { MIX_SAMPLE_RATE, clampMixGain, defaultTrackMixSetting, mixRecordingAudio, type RecordingMixSource } from '../src/utils/recordingTrackMix.ts';
import { encodePcm16Wav } from '../src/utils/wavEncoder.ts';

function wav(value: number, duration: number, sampleRate = MIX_SAMPLE_RATE) {
  return encodePcm16Wav([new Float32Array(duration * sampleRate).fill(value)], sampleRate);
}

const origin = Date.parse('2026-08-22T02:00:00Z');
function capture(startOffset: number) {
  return {
    sourceId: `track-${startOffset}`, sourceKind: 'audio', sourceLabel: 'Mic', mimeType: 'audio/wav',
    startedAt: new Date(origin + startOffset).toISOString(), trackCount: 0, tracks: [],
    timeline: { timeOrigin: origin, startMs: origin + startOffset, segmentIndex: 0, pauses: [] },
  };
}

const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 0.0001, `${value} differs from ${expected}`);

test('mixes timestamp-aligned PCM stems and keeps cuts, gains, mutes and starts on one clock', async () => {
  const tracks = [{ capture: capture(0) }, { capture: capture(400) }];
  const alignment = getTrackAlignmentSeconds(tracks, 0);
  assert.deepEqual(alignment, [0, -0.4]);
  const keep = [{ startSeconds: 0.1, endSeconds: 0.8 }, { startSeconds: 1, endSeconds: 1.4 }];
  const segments = alignment.map((shift) => mapKeepRangesToTrack(keep, shift));
  const sources: RecordingMixSource[] = [
    { label: 'Host', blob: wav(0.25, 2), segments: segments[0], gainDb: -6, muted: false },
    { label: 'Guest', blob: wav(0.125, 0.8, 44_100), segments: segments[1], gainDb: 0, muted: false },
    { label: 'Muted and unavailable', blob: new Blob(), segments: segments[0], gainDb: 12, muted: true },
  ];
  const blocks = [];
  for await (const block of mixRecordingAudio({ sources, durationSeconds: getCleanedDurationSeconds(keep) })) blocks.push(block);
  assert.deepEqual(blocks.map(({ timestamp, data }) => [timestamp, data.length]), [[0, 48000], [1, 4800]]);
  const at = (seconds: number) => blocks[Math.floor(seconds)].data[Math.round((seconds % 1) * MIX_SAMPLE_RATE)];
  const host = 0.25 * 10 ** (-6 / 20);
  near(at(0), 0);
  near(at(0.2), host);
  near(at(0.299), host);
  near(at(0.4), host + 0.125);
  near(at(0.7), 0);
  near(at(0.8), host + 0.125);
  near(at(0.96), host);
  near(at(1.05), host);
});

test('gives a failed track’s name and observes a cancelled render', async () => {
  const source = {
    label: 'Guest', blob: new Blob(['missing']), gainDb: 0, muted: false,
    segments: [{ sourceStart: 0, sourceEnd: 1, recordStart: 0 }],
  };
  await assert.rejects(mixRecordingAudio({ sources: [source], durationSeconds: 1 }).next(), /Could not read Guest/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(mixRecordingAudio({ sources: [source], durationSeconds: 1 }, abort.signal).next(), { name: 'AbortError' });
});

test('limits controls and avoids playing a regular mic and its lossless copy by default', () => {
  const tracks = [{ id: '1', label: 'Host audio' }, { id: '2', label: 'Host mic (lossless)' }, { id: '3', label: 'Guest mic (lossless)' }];
  assert.deepEqual(tracks.map((track) => defaultTrackMixSetting(track, tracks).muted), [false, true, false]);
  assert.deepEqual([-100, 100, 4.2, NaN].map(clampMixGain), [-24, 12, 4, 0]);
});
