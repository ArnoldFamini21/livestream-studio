import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  isRecordingFolderSaveSupported,
  pickRecordingFolder,
  RECORDING_FOLDER_MANIFEST_NAME,
  RecordingFolderSaveError,
  saveRecordingToFolder,
  type RecordingFolderDirectoryHandle,
  type RecordingFolderFileHandle,
  type RecordingFolderSaveInput,
  type RecordingFolderWritable,
} from '../src/utils/recordingFolderSave.ts';

function namedError(name: string, message = name) { return Object.assign(new Error(message), { name }); }

interface FixtureOptions {
  failWrite?: string;
  incorrectSize?: string;
  permission?: PermissionState;
  requestedPermission?: PermissionState;
  occupyCreatedDirectory?: boolean;
}

class MemoryFile implements RecordingFolderFileHandle {
  blob = new Blob([]);
  constructor(readonly name: string, readonly fixture: Fixture) {}
  async createWritable(): Promise<RecordingFolderWritable> {
    this.fixture.events.push(`open:${this.name}`);
    let pending: Blob | undefined;
    return {
      write: async (blob) => {
        this.fixture.events.push(`write:${this.name}`);
        this.fixture.writes.push({ name: this.name, blob });
        pending = blob;
        if (this.fixture.options.failWrite === this.name) throw new Error('External drive is full');
      },
      close: async () => {
        this.fixture.events.push(`close:${this.name}`);
        this.blob = pending!;
      },
      abort: async () => { this.fixture.events.push(`abort:${this.name}`); },
    };
  }
  async getFile() {
    this.fixture.events.push(`verify:${this.name}`);
    return this.fixture.options.incorrectSize === this.name ? new Blob(['wrong size']) : this.blob;
  }
}

class MemoryDirectory implements RecordingFolderDirectoryHandle {
  readonly entries = new Map<string, MemoryFile | MemoryDirectory>();
  constructor(readonly fixture: Fixture, readonly name = 'parent') {}
  async queryPermission() { return this.fixture.options.permission || 'granted'; }
  async requestPermission() {
    this.fixture.events.push('request-permission');
    return this.fixture.options.requestedPermission || 'granted';
  }
  async *keys() { yield* this.entries.keys(); }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name.toLowerCase());
    if (existing instanceof MemoryDirectory) return existing;
    if (existing) throw namedError('TypeMismatchError');
    if (!options?.create) throw namedError('NotFoundError');
    this.fixture.events.push(`mkdir:${name}`);
    const directory = new MemoryDirectory(this.fixture, name);
    if (this.fixture.options.occupyCreatedDirectory) directory.entries.set('existing', new MemoryFile('existing', this.fixture));
    this.entries.set(name.toLowerCase(), directory);
    return directory;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name.toLowerCase());
    if (existing instanceof MemoryFile) return existing;
    if (existing) throw namedError('TypeMismatchError');
    if (!options?.create) throw namedError('NotFoundError');
    const file = new MemoryFile(name, this.fixture);
    this.entries.set(name.toLowerCase(), file);
    return file;
  }
}

class Fixture {
  readonly events: string[] = [];
  readonly writes: Array<{ name: string; blob: Blob }> = [];
  readonly parent = new MemoryDirectory(this);
  constructor(readonly options: FixtureOptions = {}) {}
  get savedDirectory() { return [...this.parent.entries.values()].find((entry) => entry instanceof MemoryDirectory) as MemoryDirectory; }
}

function recording(overrides: Partial<RecordingFolderSaveInput> = {}): RecordingFolderSaveInput {
  return {
    id: 'recording-1', roomName: 'Sunday studio', createdAt: '2026-10-18T09:30:00.000Z', durationSeconds: 4,
    files: [
      { label: 'Program', fileName: 'program.webm', blob: new Blob(['video-bytes'], { type: 'video/webm' }), kind: 'program' },
      { label: 'Microphone', fileName: 'microphone.wav', blob: new Blob(['audio-bytes'], { type: 'audio/wav' }), kind: 'audio' },
    ],
    markers: [{ id: 'marker-1', label: 'Opening', seconds: 1.5, createdAt: '2026-10-18T09:30:01.500Z' }],
    ...overrides,
  };
}

describe('finished recording folder backup', () => {
  it('writes original Blobs sequentially, verifies each file, and writes a complete manifest last', async () => {
    const fixture = new Fixture();
    const input = recording();
    for (const file of input.files) {
      Object.defineProperty(file.blob, 'arrayBuffer', { value: () => { throw new Error('must not materialize the recording'); } });
    }
    const progress: string[] = [];
    const result = await saveRecordingToFolder(fixture.parent, input, { onProgress: (value) => progress.push(`${value.completedFiles}:${value.fileName}`) });

    assert.equal(result.fileCount, 2);
    assert.equal(result.totalBytes, input.files.reduce((total, file) => total + file.blob.size, 0));
    assert.equal(fixture.writes[0].blob, input.files[0].blob);
    assert.equal(fixture.writes[1].blob, input.files[1].blob);
    assert.deepEqual(fixture.events.slice(1), [
      'open:program.webm', 'write:program.webm', 'close:program.webm', 'verify:program.webm',
      'open:microphone.wav', 'write:microphone.wav', 'close:microphone.wav', 'verify:microphone.wav',
      `open:${RECORDING_FOLDER_MANIFEST_NAME}`, `write:${RECORDING_FOLDER_MANIFEST_NAME}`,
      `close:${RECORDING_FOLDER_MANIFEST_NAME}`, `verify:${RECORDING_FOLDER_MANIFEST_NAME}`,
    ]);
    assert.equal(result.files[0].file, (fixture.savedDirectory.entries.get('program.webm') as MemoryFile).blob);
    const manifest = JSON.parse(await fixture.writes[2].blob.text());
    assert.equal(manifest.status, 'complete');
    assert.deepEqual(manifest.files.map((file: { fileName: string }) => file.fileName), result.files.map((file) => file.fileName));
    assert.deepEqual(manifest.recording.markers, input.markers);
    assert.deepEqual(progress, ['1:program.webm', '2:microphone.wav', '2:recording-manifest.json']);
  });

  it('retains verified files on a later write failure without creating a complete manifest', async () => {
    const fixture = new Fixture({ failWrite: 'microphone.wav' });
    await assert.rejects(saveRecordingToFolder(fixture.parent, recording()), (error: unknown) => {
      assert.ok(error instanceof RecordingFolderSaveError);
      assert.equal(error.completedFiles, 1);
      assert.match(error.message, /partial folder.*External drive is full/);
      assert.ok(error.folderName);
      return true;
    });
    assert.equal((fixture.savedDirectory.entries.get('program.webm') as MemoryFile).blob.size, 11);
    assert.equal(fixture.savedDirectory.entries.has(RECORDING_FOLDER_MANIFEST_NAME), false);
    assert.ok(fixture.events.includes('abort:microphone.wav'));
  });

  it('rejects an incorrect read-back size before writing subsequent files or a manifest', async () => {
    const fixture = new Fixture({ incorrectSize: 'program.webm' });
    await assert.rejects(saveRecordingToFolder(fixture.parent, recording()), /Verification failed.*expected 11 bytes/);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.savedDirectory.entries.has(RECORDING_FOLDER_MANIFEST_NAME), false);
  });

  it('requests write permission and rejects denied access before creating directories', async () => {
    const fixture = new Fixture({ permission: 'prompt', requestedPermission: 'denied' });
    await assert.rejects(saveRecordingToFolder(fixture.parent, recording()), /permission.*not granted/);
    assert.deepEqual(fixture.events, ['request-permission']);
    assert.equal(fixture.parent.entries.size, 0);
  });

  it('does not re-prompt an explicitly denied folder', async () => {
    const fixture = new Fixture({ permission: 'denied' });
    await assert.rejects(saveRecordingToFolder(fixture.parent, recording()), /permission.*not granted/);
    assert.deepEqual(fixture.events, []);
  });

  it('validates every source before writing, including zero-byte or missing later files', async () => {
    for (const files of [[], [recording().files[0], { label: 'Empty', fileName: 'empty.webm', blob: new Blob([]) }],
      [{ label: 'Missing', fileName: 'missing.webm', blob: undefined as unknown as Blob }]]) {
      const fixture = new Fixture();
      await assert.rejects(saveRecordingToFolder(fixture.parent, recording({ files })), /no finished files|Every recording file/);
      assert.deepEqual(fixture.events, []);
      assert.equal(fixture.parent.entries.size, 0);
    }
  });

  it('sanitizes traversal, reserved names, and case-insensitive collisions without overwriting files', async () => {
    const fixture = new Fixture();
    const names = ['../../take.webm', 'take.webm', 'TAKE.WEBM', 'recording-manifest.json', 'RECORDING-MANIFEST.JSON', 'CON.wav', '..'];
    const input = recording({ roomName: '../../Studio:/unsafe', files: names.map((fileName, index) => ({
      fileName, label: `Track ${index}`, blob: new Blob([String(index)]),
    })) });
    const result = await saveRecordingToFolder(fixture.parent, input);
    assert.equal(new Set(result.files.map((file) => file.fileName.toLowerCase())).size, names.length);
    assert.ok(result.files.every(({ fileName }) => !/[<>:"/\\|?*]/.test(fileName) && fileName !== '..'));
    assert.equal(result.files.some(({ fileName }) => fileName.toLowerCase() === RECORDING_FOLDER_MANIFEST_NAME), false);
    assert.equal(result.files[2].fileName, 'TAKE-2.WEBM');
    assert.equal(result.files[5].fileName, 'recording_CON.wav');
    assert.doesNotMatch(result.folderName, /[/\\:]/);
    assert.equal(fixture.savedDirectory.entries.size, names.length + 1);
  });

  it('always creates a separate folder for another backup of the same session', async () => {
    const fixture = new Fixture();
    const first = await saveRecordingToFolder(fixture.parent, recording());
    const firstDirectory = fixture.savedDirectory;
    const oldFile = (firstDirectory.entries.get('program.webm') as MemoryFile).blob;
    const second = await saveRecordingToFolder(fixture.parent, recording());
    assert.notEqual(first.folderName, second.folderName);
    assert.equal(fixture.parent.entries.size, 2);
    assert.equal((firstDirectory.entries.get('program.webm') as MemoryFile).blob, oldFile);
  });

  it('skips a pre-existing directory rather than writing into it', async (context) => {
    const fixture = new Fixture();
    const occupiedName = 'Sunday studio-2026-10-18-09-30-00-aaaaaaaaaaaaaaaa';
    const existing = new MemoryDirectory(fixture, occupiedName);
    fixture.parent.entries.set(occupiedName.toLowerCase(), existing);
    let sequence = 0;
    context.mock.method(crypto, 'randomUUID', () => sequence++ === 0 ? 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    const result = await saveRecordingToFolder(fixture.parent, recording());
    assert.notEqual(result.folderName, occupiedName);
    assert.equal(existing.entries.size, 0);
  });

  it('rejects directories occupied during creation without overwriting their contents', async () => {
    const fixture = new Fixture({ occupyCreatedDirectory: true });
    await assert.rejects(saveRecordingToFolder(fixture.parent, recording()), /unused recording backup folder/);
    assert.equal(fixture.writes.length, 0);
    for (const directory of fixture.parent.entries.values()) assert.equal((directory as MemoryDirectory).entries.size, 1);
  });

  it('keeps the manifest absent when its write fails and does not leak unrelated metadata', async () => {
    const fixture = new Fixture({ failWrite: RECORDING_FOLDER_MANIFEST_NAME });
    const input = { ...recording(), hostToken: 'private-token', streamKey: 'private-stream-key' };
    input.files[0].capture = { sourceKind: 'program', sourceId: 'program', sourceLabel: 'Program', mimeType: 'video/webm', startedAt: input.createdAt, token: 'private-capture-token' };
    await assert.rejects(saveRecordingToFolder(fixture.parent, input), /External drive is full/);
    const attemptedManifest = await fixture.writes[2].blob.text();
    assert.doesNotMatch(attemptedManifest, /private-token|private-stream-key|private-capture-token/);
    assert.equal((fixture.savedDirectory.entries.get(RECORDING_FOLDER_MANIFEST_NAME) as MemoryFile).blob.size, 0);
    assert.equal(fixture.writes.length, 3);
  });
});

const pickerGlobal = globalThis as unknown as { showDirectoryPicker?: (options: unknown) => Promise<RecordingFolderDirectoryHandle> };
const originalPicker = Object.getOwnPropertyDescriptor(globalThis, 'showDirectoryPicker');
afterEach(() => {
  if (originalPicker) Object.defineProperty(globalThis, 'showDirectoryPicker', originalPicker);
  else delete pickerGlobal.showDirectoryPicker;
});

describe('recording folder picker', () => {
  it('invokes the native picker immediately with readwrite mode and its stable id', async () => {
    const fixture = new Fixture();
    let called = false;
    pickerGlobal.showDirectoryPicker = async (options) => {
      called = true;
      assert.deepEqual(options, { id: 'studio-recording-backups', mode: 'readwrite' });
      return fixture.parent;
    };
    assert.equal(isRecordingFolderSaveSupported(), true);
    const pending = pickRecordingFolder();
    assert.equal(called, true);
    assert.equal(await pending, fixture.parent);
  });

  it('propagates picker cancellation without writing or starting a download', async () => {
    const cancellation = namedError('AbortError', 'User canceled folder selection');
    pickerGlobal.showDirectoryPicker = async () => { throw cancellation; };
    await assert.rejects(pickRecordingFolder(), (error) => error === cancellation);
  });

  it('reports unsupported browsers without a fallback download', () => {
    delete pickerGlobal.showDirectoryPicker;
    assert.equal(isRecordingFolderSaveSupported(), false);
    assert.throws(() => pickRecordingFolder(), /not supported/);
  });
});
