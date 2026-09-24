import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HlsViewerCounter,
  createFfmpegHlsArgs,
  getHlsContentType,
  getHlsRoomDir,
  isServableHlsFile,
  isValidWatchRoomId,
} from './hlsOutput.js';

describe('watch page HLS output', () => {
  it('accepts room ids and serves only the playlist and numbered segments', () => {
    assert.equal(isValidWatchRoomId('TwypUGS5cl'), true);
    assert.equal(isValidWatchRoomId('../etc'), false);
    assert.equal(isValidWatchRoomId(''), false);
    assert.equal(isServableHlsFile('stream.m3u8'), true);
    assert.equal(isServableHlsFile('seg00012.ts'), true);
    assert.equal(isServableHlsFile('seg1.ts'), false);
    assert.equal(isServableHlsFile('../../secret'), false);
    assert.equal(isServableHlsFile('stream.m3u8.bak'), false);
    assert.equal(getHlsContentType('stream.m3u8'), 'application/vnd.apple.mpegurl');
    assert.equal(getHlsContentType('seg00001.ts'), 'video/mp2t');
  });

  it('writes copy-only HLS with short segments and a rolling playlist', () => {
    const args = createFfmpegHlsArgs('/tmp/hls/room');
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', 'pipe:0']);
    assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy']);
    assert.equal(args[args.indexOf('-hls_time') + 1], '2');
    assert.equal(args[args.indexOf('-hls_list_size') + 1], '6');
    assert.match(args[args.indexOf('-hls_flags') + 1], /delete_segments/);
    assert.match(args[args.indexOf('-hls_flags') + 1], /omit_endlist/);
    assert.equal(args[args.length - 1], '/tmp/hls/room/stream.m3u8');
    assert.equal(getHlsRoomDir('abc', '/x'), '/x/abc');
  });

  it('counts distinct recent viewers from playlist requests', () => {
    const counter = new HlsViewerCounter(1000);
    counter.record('1.1.1.1', 0);
    counter.record('2.2.2.2', 100);
    counter.record('1.1.1.1', 500);
    assert.equal(counter.count(600), 2);
    assert.equal(counter.count(1200), 1);
    assert.equal(counter.count(2000), 0);
  });
});
