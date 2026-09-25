import { mkdir, mkdtemp, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HlsViewerCounter,
  prepareHlsRoomDir,
  removeHlsWriterDir,
  sweepStaleHlsWriterDirs,
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
    assert.equal(isServableHlsFile('seg100000.ts'), true);
    assert.equal(isServableHlsFile('seg-room-Ab12Cd-00001.ts'), true);
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

  it('keeps a restarted broadcast intact when the previous writer is cleaned up', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hls-restart-'));
    try {
      const previous = await prepareHlsRoomDir('same-room', root);
      await writeFile(path.join(previous, 'stream.m3u8'), 'old stream');
      const current = await prepareHlsRoomDir('same-room', root);
      await writeFile(path.join(current, 'stream.m3u8'), 'new stream');
      assert.notEqual(previous, current);
      const oldArgs = createFfmpegHlsArgs(previous);
      const newArgs = createFfmpegHlsArgs(current);
      assert.notEqual(path.basename(oldArgs[oldArgs.indexOf('-hls_segment_filename') + 1]), path.basename(newArgs[newArgs.indexOf('-hls_segment_filename') + 1]), 'segment URLs must not collide across broadcasts');
      await removeHlsWriterDir(previous);
      assert.equal(await readFile(path.join(current, 'stream.m3u8'), 'utf8'), 'new stream');
      await assert.rejects(prepareHlsRoomDir('../escape', root), /Invalid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('sweeps writer folders left by a crash, and nothing else', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hls-sweep-'));
    try {
      const leftover = await prepareHlsRoomDir('TwypUGS5cl', root);
      await writeFile(path.join(leftover, `seg-${path.basename(leftover)}-00001.ts`), 'old');
      await writeFile(path.join(leftover, 'stream.m3u8'), '#EXTM3U');
      // Named like a writer folder, but holding something else.
      await mkdir(path.join(root, 'unrelated-folder'));
      await writeFile(path.join(root, 'unrelated-folder', 'photo.jpg'), 'keep');
      await writeFile(path.join(root, 'notes.txt'), 'keep');
      assert.equal(await sweepStaleHlsWriterDirs(root), 1);
      assert.deepEqual((await readdir(root)).sort(), ['notes.txt', 'unrelated-folder']);
      assert.equal(await sweepStaleHlsWriterDirs(path.join(root, 'missing')), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
