import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FfmpegProgressParser,
  FfmpegRateMeter,
  ffmpegProgressArgs,
  parseFfmpegBitrateKbps,
  parseFfmpegSpeed,
} from './ffmpegProgress.js';

const REPORT = [
  'frame=300',
  'fps=29.97',
  'stream_0_0_q=-1.0',
  'bitrate=4512.3kbits/s',
  'total_size=5640000',
  'out_time_us=10000000',
  'out_time_ms=10000000',
  'out_time=00:00:10.000000',
  'dup_frames=2',
  'drop_frames=5',
  'speed=0.981x',
  'progress=continue',
].join('\n');

describe('FFmpeg progress parsing', () => {
  it('asks FFmpeg for a report on stderr every two seconds', () => {
    assert.deepEqual(ffmpegProgressArgs(), ['-nostats', '-progress', 'pipe:2', '-stats_period', '2']);
  });

  it('parses a full report and keeps log lines apart', () => {
    const parser = new FfmpegProgressParser();
    const { reports, logLines } = parser.push(`[flv @ 0x1] Non-monotonous DTS\n${REPORT}\n`);
    assert.deepEqual(logLines, ['[flv @ 0x1] Non-monotonous DTS']);
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], {
      frame: 300,
      fps: 29.97,
      bitrateKbps: 4512.3,
      totalSizeBytes: 5_640_000,
      outTimeMs: 10_000,
      speed: 0.981,
      droppedFrames: 5,
      duplicatedFrames: 2,
      ended: false,
    });
  });

  it('joins reports split across chunks and marks the last one', () => {
    const parser = new FfmpegProgressParser();
    const text = `${REPORT.replace('progress=continue', 'progress=end')}\n`;
    const first = parser.push(text.slice(0, 37));
    assert.equal(first.reports.length, 0);
    const second = parser.push(text.slice(37));
    assert.equal(second.reports.length, 1);
    assert.equal(second.reports[0].ended, true);
    assert.equal(second.logLines.length, 0);
  });

  it('measures bitrate and speed over the last interval, not since the start', () => {
    const meter = new FfmpegRateMeter();
    const base = {
      frame: 0, fps: 30, bitrateKbps: 4500, totalSizeBytes: 0, outTimeMs: 0,
      speed: 1, droppedFrames: 0, duplicatedFrames: 0, ended: false,
    };
    assert.deepEqual(meter.sample({ ...base, totalSizeBytes: 5_625_000, outTimeMs: 10_000 }, 10_000), {
      bitrateKbps: 4500,
      speed: 1,
    }, 'the first report uses FFmpeg\'s own figures');
    // The next two seconds carried only one second of media at a third of the bitrate.
    const stalled = meter.sample({ ...base, totalSizeBytes: 5_625_000 + 375_000, outTimeMs: 11_000 }, 12_000);
    assert.equal(stalled.bitrateKbps, 1500);
    assert.equal(stalled.speed, 0.5);
  });

  it('treats N/A values as unknown', () => {
    const parser = new FfmpegProgressParser();
    const { reports } = parser.push('frame=0\nfps=0.00\nbitrate=N/A\nspeed=N/A\nout_time_us=N/A\nprogress=continue\n');
    assert.equal(reports[0].bitrateKbps, null);
    assert.equal(reports[0].speed, null);
    assert.equal(reports[0].outTimeMs, null);
    assert.equal(parseFfmpegBitrateKbps('garbage'), null);
    assert.equal(parseFfmpegSpeed('1.5x'), 1.5);
  });
});
