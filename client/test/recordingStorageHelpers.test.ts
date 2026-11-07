import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWavHeader, encodePcmFrames, parseWavHeader, patchWavFileHeader, WAV_HEADER_BYTES } from '../src/utils/wavStream.ts';
import { estimateRecordingBitsPerSecond, getRecordingVideoBitsPerSecond, MAX_RECORDING_VIDEO_BITS_PER_SECOND } from '../src/utils/recordingBitrate.ts';
import {
  assessRecordingStorageHeadroom,
  ensureRecordingFolderAccess,
  getRecordingFolderStatus,
  requestPersistentRecordingStorage,
} from '../src/utils/recordingFolderStore.ts';
import { createScreenWakeLockController } from '../src/utils/screenWakeLock.ts';
import { MemoryDirectoryHandle } from './memoryDirectory.ts';

describe('streaming WAV', () => {
  const format = { sampleRate: 48_000, channels: 1, bitsPerSample: 24 as const };

  it('writes a placeholder header and a final header with real sizes', () => {
    const placeholder = parseWavHeader(createWavHeader(format));
    assert.equal(placeholder?.dataBytes, 0xffffffff);
    const final = parseWavHeader(createWavHeader(format, 288_000));
    assert.deepEqual(final, { riffBytes: 288_036, channels: 1, sampleRate: 48_000, bitsPerSample: 24, dataBytes: 288_000 });
  });

  it('encodes interleaved little-endian PCM with clipping', () => {
    const pcm16 = encodePcmFrames([new Float32Array([0, 1, -1, 2])], 16);
    const view16 = new DataView(pcm16.buffer);
    assert.deepEqual([0, 2, 4, 6].map((offset) => view16.getInt16(offset, true)), [0, 32767, -32768, 32767]);
    const stereo24 = encodePcmFrames([new Float32Array([0.5]), new Float32Array([-0.5])], 24);
    assert.equal(stereo24.byteLength, 6);
    const left = stereo24[0] | (stereo24[1] << 8) | (stereo24[2] << 16);
    assert.equal(left, Math.round(0.5 * 0x7fffff));
  });

  it('patches the header of a file in place without touching the samples', async () => {
    const directory = new MemoryDirectoryHandle('root');
    const handle = await directory.getFileHandle('mic.wav', { create: true });
    const samples = encodePcmFrames([new Float32Array(480).fill(0.25)], 24);
    const writable = await handle.createWritable();
    await writable.write(new Blob([createWavHeader(format), samples]));
    await writable.close();
    await patchWavFileHeader(handle, format, samples.byteLength);
    const bytes = new Uint8Array(await handle.data.arrayBuffer());
    assert.equal(bytes.byteLength, WAV_HEADER_BYTES + samples.byteLength);
    assert.equal(parseWavHeader(bytes)?.dataBytes, samples.byteLength);
    assert.deepEqual([...bytes.subarray(WAV_HEADER_BYTES, WAV_HEADER_BYTES + 6)], [...samples.subarray(0, 6)]);
  });
});

describe('recording bitrate', () => {
  it('scales with resolution and frame rate', () => {
    assert.equal(getRecordingVideoBitsPerSecond({ width: 1280, height: 720, frameRate: 30 }), 5_000_000);
    assert.equal(getRecordingVideoBitsPerSecond({ width: 1920, height: 1080, frameRate: 30 }), 10_000_000);
    assert.equal(getRecordingVideoBitsPerSecond({ width: 3840, height: 2160, frameRate: 30 }), 40_000_000);
    assert.equal(getRecordingVideoBitsPerSecond({ width: 3840, height: 2160, frameRate: 60 }), MAX_RECORDING_VIDEO_BITS_PER_SECOND);
    assert.equal(getRecordingVideoBitsPerSecond({ width: 1920, height: 1080, frameRate: 60 }), 15_000_000);
    assert.equal(getRecordingVideoBitsPerSecond(null), 10_000_000);
  });

  it('estimates the planned rate of a set of sources', () => {
    const videoStream = {
      getVideoTracks: () => [{ readyState: 'live', getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) }],
    } as unknown as MediaStream;
    const audioStream = { getVideoTracks: () => [] } as unknown as MediaStream;
    assert.equal(estimateRecordingBitsPerSecond([
      { kind: 'iso', stream: videoStream },
      { kind: 'audio', stream: audioStream },
      { kind: 'program', stream: videoStream, bitsPerSecond: 10_000_000 },
    ]), 5_256_000 + 256_000 + 10_000_000);
  });
});

describe('recording folder access and storage preflight', () => {
  it('reports permission states and re-grants with one request', async () => {
    assert.equal(await getRecordingFolderStatus(null), 'none');
    const folder = new MemoryDirectoryHandle('SSD', { permission: 'prompt', requestedPermission: 'granted' });
    assert.equal(await getRecordingFolderStatus(folder), 'needs-permission');
    assert.equal(await ensureRecordingFolderAccess(folder), true);
    assert.equal(await getRecordingFolderStatus(folder), 'ready');
    const blocked = new MemoryDirectoryHandle('SSD', { permission: 'denied', requestedPermission: 'denied' });
    assert.equal(await getRecordingFolderStatus(blocked), 'denied');
    assert.equal(await ensureRecordingFolderAccess(blocked), false);
  });

  it('requests persistent storage once', async () => {
    let asked = 0;
    assert.deepEqual(await requestPersistentRecordingStorage({ persisted: async () => false, persist: async () => { asked += 1; return true; } }), { supported: true, persisted: true });
    assert.deepEqual(await requestPersistentRecordingStorage({ persisted: async () => true, persist: async () => { asked += 1; return true; } }), { supported: true, persisted: true });
    assert.equal(asked, 1);
    assert.deepEqual(await requestPersistentRecordingStorage({}), { supported: false, persisted: false });
  });

  it('warns below two hours and blocks below ten minutes of browser storage', () => {
    const bitsPerSecond = 8_000_000; // 1 MB/s = 60 MB per minute
    const mb = 1024 * 1024;
    assert.equal(assessRecordingStorageHeadroom({ estimate: { quota: 60 * mb * 300, usage: 0 }, bitsPerSecond, folderConnected: false }).status, 'ok');
    const warning = assessRecordingStorageHeadroom({ estimate: { quota: 60 * mb * 60, usage: 0 }, bitsPerSecond, folderConnected: false });
    assert.equal(warning.status, 'warning');
    assert.ok(warning.minutesAvailable! >= 60 && warning.minutesAvailable! < 70);
    assert.equal(assessRecordingStorageHeadroom({ estimate: { quota: 60 * mb * 5, usage: 0 }, bitsPerSecond, folderConnected: false }).status, 'critical');
    assert.equal(assessRecordingStorageHeadroom({ estimate: { quota: 1, usage: 1 }, bitsPerSecond, folderConnected: true }).status, 'ok');
    assert.equal(assessRecordingStorageHeadroom({ estimate: null, bitsPerSecond, folderConnected: false }).status, 'unknown');
  });
});

describe('screen wake lock', () => {
  function fakeEnvironment() {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_type: 'visibilitychange', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => listeners.delete(listener),
    };
    const sentinels: Array<{ released: boolean; release(): Promise<void>; fire(): void }> = [];
    const wakeLock = {
      request: async () => {
        const releaseListeners: Array<() => void> = [];
        const sentinel = {
          released: false,
          async release() { sentinel.released = true; },
          addEventListener: (_type: 'release', listener: () => void) => releaseListeners.push(listener),
          fire() { sentinel.released = true; releaseListeners.forEach((listener) => listener()); },
        };
        sentinels.push(sentinel);
        return sentinel;
      },
    };
    return { doc, wakeLock, sentinels, emitVisibility: () => listeners.forEach((listener) => listener()) };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('holds the lock while active and re-acquires it when the page is visible again', async () => {
    const env = fakeEnvironment();
    const statuses: string[] = [];
    const controller = createScreenWakeLockController({ wakeLock: env.wakeLock, document: env.doc, onStatus: (status) => statuses.push(status) });
    controller.setActive(true);
    await tick();
    assert.equal(controller.status(), 'held');
    // The browser drops the lock when the tab is hidden.
    env.doc.visibilityState = 'hidden';
    env.sentinels[0].fire();
    assert.equal(controller.status(), 'released');
    env.doc.visibilityState = 'visible';
    env.emitVisibility();
    await tick();
    assert.equal(env.sentinels.length, 2);
    assert.equal(controller.status(), 'held');
    controller.setActive(false);
    assert.equal(env.sentinels[1].released, true);
    assert.equal(controller.status(), 'idle');
    controller.dispose();
    assert.deepEqual(statuses, ['held', 'released', 'held', 'idle']);
  });

  it('reports unsupported browsers', () => {
    const controller = createScreenWakeLockController({ wakeLock: null, document: null });
    controller.setActive(true);
    assert.equal(controller.status(), 'unsupported');
    controller.dispose();
  });
});
