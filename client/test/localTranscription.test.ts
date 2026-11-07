import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WHISPER_SAMPLE_RATE,
  buildTranscriptTextFromWords,
  downmixAndResample,
  findQuietestCutOffset,
  isSilentWindow,
  mapWindowWords,
  planTranscriptionWindows,
  stitchTranscriptWords,
  toWhisperLanguage,
} from '../src/utils/transcriptionWindows.ts';
import { summarizeModelDownload, transcribeRecordingLocally, type TranscriptionWorkerLike } from '../src/utils/localTranscription.ts';
import {
  CLOUD_TRANSCRIPTION_CHUNK_SECONDS,
  CLOUD_TRANSCRIPTION_MAX_BYTES,
  requestRecordingTranscription,
} from '../src/utils/recordingTranscription.ts';
import { loadTranscriptionSettings, normalizeTranscriptionSettings, saveTranscriptionSettings } from '../src/utils/transcriptionSettings.ts';
import type { AudioWindowReader } from '../src/utils/audioWindowReader.ts';
import type { TranscriptionWorkerRequest, TranscriptionWorkerResponse } from '../src/workers/transcription.worker.ts';

function tone(seconds: number, amplitude = 0.2, rate = WHISPER_SAMPLE_RATE): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let index = 0; index < samples.length; index += 1) samples[index] = amplitude * Math.sin((2 * Math.PI * 220 * index) / rate);
  return samples;
}

function fakeReader(durationSeconds: number, silentRanges: Array<[number, number]> = []): AudioWindowReader & { reads: Array<[number, number]>; closed: boolean } {
  const reader = {
    durationSeconds,
    reads: [] as Array<[number, number]>,
    closed: false,
    async readWindow(start: number, end: number) {
      reader.reads.push([start, end]);
      const silent = silentRanges.some(([from, to]) => start >= from && end <= to);
      return tone(end - start, silent ? 0 : 0.2);
    },
    close() {
      reader.closed = true;
    },
  };
  return reader;
}

describe('transcription windows', () => {
  it('covers a long track with overlapping 30 s windows and disjoint keep ranges', () => {
    const windows = planTranscriptionWindows(70);
    assert.deepEqual(windows.map((window) => [window.startSeconds, window.endSeconds]), [[0, 30], [26, 56], [52, 70]]);
    assert.equal(windows[0].keepStartSeconds, 0);
    assert.equal(windows[0].keepEndSeconds, 28);
    assert.equal(windows[1].keepStartSeconds, 28);
    assert.equal(windows[1].keepEndSeconds, 54);
    assert.equal(windows[2].keepEndSeconds, Number.POSITIVE_INFINITY);
    assert.deepEqual(planTranscriptionWindows(0), []);
    assert.equal(planTranscriptionWindows(12).length, 1);
  });

  it('maps window-relative words onto the track and keeps each overlap word once', () => {
    const [first, second] = planTranscriptionWindows(60);
    const firstWords = mapWindowWords(first, [
      { text: ' Hello', timestamp: [1, 1.4] },
      { text: ' edge', timestamp: [27.5, 27.9] },
      { text: ' overlap', timestamp: [28.5, 28.9] },
      { text: ' cut', timestamp: [29.8, null] },
    ]);
    const secondWords = mapWindowWords(second, [
      { text: ' edge', timestamp: [1.5, 1.9] },
      { text: ' overlap', timestamp: [2.5, 2.9] },
      { text: ' cut', timestamp: [3.8, 4.1] },
      { text: ' world.', timestamp: [10, 10.5] },
    ]);
    assert.deepEqual(firstWords.map((word) => word.word), ['Hello', 'edge']);
    assert.deepEqual(secondWords.map((word) => word.word), ['overlap', 'cut', 'world.']);
    assert.deepEqual(secondWords[0], { word: 'overlap', start: 28.5, end: 28.9 });
    const stitched = stitchTranscriptWords([firstWords, secondWords]);
    assert.equal(buildTranscriptTextFromWords(stitched), 'Hello edge overlap cut world.');
  });

  it('keeps stitched timings monotonic and drops duplicate words at the same time', () => {
    const stitched = stitchTranscriptWords([
      [{ word: 'so', start: 5, end: 5.4 }],
      [{ word: 'So', start: 5.05, end: 5.4 }, { word: 'then', start: 5.3, end: 5.8 }],
    ]);
    assert.deepEqual(stitched, [{ word: 'so', start: 5, end: 5.4 }, { word: 'then', start: 5.3, end: 5.8 }]);
  });

  it('downmixes stereo and resamples 48 kHz to 16 kHz without changing level', () => {
    const left = new Float32Array(48_000).fill(0.5);
    const right = new Float32Array(48_000).fill(-0.1);
    const output = downmixAndResample([left, right], 48_000, 16_000);
    assert.equal(output.length, 16_000);
    assert.ok(Math.abs(output[100] - 0.2) < 1e-6);
    const up = downmixAndResample([new Float32Array([0, 1])], 8_000, 16_000);
    assert.equal(up.length, 4);
    assert.ok(Math.abs(up[1] - 0.5) < 1e-6);
  });

  it('skips silence and finds a quiet cut point', () => {
    assert.equal(isSilentWindow(new Float32Array(16_000)), true);
    assert.equal(isSilentWindow(tone(1)), false);
    const samples = tone(10);
    samples.fill(0, 7 * WHISPER_SAMPLE_RATE, Math.round(7.4 * WHISPER_SAMPLE_RATE));
    const cut = findQuietestCutOffset(samples, WHISPER_SAMPLE_RATE);
    assert.ok(cut >= 7 * WHISPER_SAMPLE_RATE && cut <= 7.4 * WHISPER_SAMPLE_RATE, `cut at ${cut}`);
  });

  it('maps caption languages to Whisper languages', () => {
    assert.equal(toWhisperLanguage('en-US'), 'en');
    assert.equal(toWhisperLanguage('fil-PH'), 'tl');
    assert.equal(toWhisperLanguage('es'), 'es');
    assert.equal(toWhisperLanguage(''), undefined);
    assert.equal(toWhisperLanguage('not a language'), undefined);
  });
});

class FakeWorker implements TranscriptionWorkerLike {
  messages: TranscriptionWorkerRequest[] = [];
  terminated = false;
  private listeners: Array<(event: MessageEvent<TranscriptionWorkerResponse>) => void> = [];
  constructor(private readonly respond: (message: TranscriptionWorkerRequest, worker: FakeWorker) => void) {}
  postMessage(message: TranscriptionWorkerRequest) {
    this.messages.push(message);
    queueMicrotask(() => this.respond(message, this));
  }
  addEventListener(type: 'message' | 'error', listener: (event: never) => void) {
    if (type === 'message') this.listeners.push(listener as (event: MessageEvent<TranscriptionWorkerResponse>) => void);
  }
  emit(message: TranscriptionWorkerResponse) {
    for (const listener of this.listeners) listener({ data: message } as MessageEvent<TranscriptionWorkerResponse>);
  }
  terminate() {
    this.terminated = true;
  }
}

describe('in-browser transcription controller', () => {
  it('loads the model, transcribes each non-silent window and stitches words onto the track', async () => {
    const reader = fakeReader(65, [[26, 56]]);
    let worker: FakeWorker | null = null;
    const progress: string[] = [];
    const result = await transcribeRecordingLocally(new Blob(['x']), {
      model: 'tiny',
      language: 'en-US',
      openReader: async () => reader,
      createWorker: () => {
        worker = new FakeWorker((message, self) => {
          if (message.type === 'load') {
            self.emit({ type: 'load-progress', file: 'encoder_model_quantized.onnx', loaded: 5e6, total: 10e6 });
            self.emit({ type: 'ready', device: 'wasm' });
          } else {
            assert.equal(message.language, 'en');
            assert.equal(message.audio.length, Math.round((message.id === 1 ? 30 : 13) * WHISPER_SAMPLE_RATE));
            self.emit({
              type: 'result',
              id: message.id,
              text: '',
              chunks: message.id === 1
                ? [{ text: ' Welcome', timestamp: [0.5, 1] }, { text: ' back.', timestamp: [1, 1.5] }]
                : [{ text: ' Thanks!', timestamp: [3, 3.6] }],
            });
          }
        });
        return worker;
      },
      onProgress: (update) => progress.push(update.phase),
    });
    assert.equal(result.text, 'Welcome back. Thanks!');
    assert.deepEqual(result.words.map((word) => [word.word, word.start]), [['Welcome', 0.5], ['back.', 1], ['Thanks!', 55]]);
    assert.equal(result.durationSeconds, 65);
    assert.equal(result.device, 'wasm');
    assert.match(result.model, /whisper-tiny_timestamped/);
    assert.equal(worker!.messages.filter((message) => message.type === 'transcribe').length, 2, 'the silent window is skipped');
    assert.ok(worker!.terminated);
    assert.ok(reader.closed);
    assert.ok(progress.includes('loading-model') && progress.includes('transcribing'));
  });

  it('cancels mid-way and releases the worker and reader', async () => {
    const reader = fakeReader(120);
    const controller = new AbortController();
    let worker: FakeWorker | null = null;
    const run = transcribeRecordingLocally(new Blob(['x']), {
      signal: controller.signal,
      openReader: async () => reader,
      createWorker: () => {
        worker = new FakeWorker((message, self) => {
          if (message.type === 'load') self.emit({ type: 'ready', device: 'webgpu' });
          else controller.abort();
        });
        return worker;
      },
    });
    await assert.rejects(run, (err: Error) => err.name === 'AbortError');
    assert.ok(worker!.terminated);
    assert.ok(reader.closed);
  });

  it('surfaces model load failures', async () => {
    await assert.rejects(
      transcribeRecordingLocally(new Blob(['x']), {
        openReader: async () => fakeReader(10),
        createWorker: () => new FakeWorker((message, self) => self.emit({ type: 'error', message: 'no network' })),
      }),
      /no network/
    );
  });

  it('sums model download progress across files', () => {
    const files = new Map([['a', { loaded: 5, total: 10 }], ['b', { loaded: 30, total: 20 }]]);
    assert.deepEqual(summarizeModelDownload(files), { loaded: 25, total: 30 });
  });
});

describe('requestRecordingTranscription engines', () => {
  const file = { label: 'Host mic', fileName: 'host-mic.webm', blob: new Blob(['audio'], { type: 'audio/webm' }), kind: 'audio' as const };

  it('uses the in-browser engine by default', async () => {
    let called = false;
    const result = await requestRecordingTranscription(file, {
      language: 'en-US',
      fetchImpl: (async () => { throw new Error('no server calls'); }) as typeof fetch,
      transcribeLocally: async (blob, options) => {
        called = true;
        assert.equal(blob, file.blob);
        assert.equal(options?.language, 'en-US');
        return { text: 'Hi there', words: [{ word: 'Hi', start: 0, end: 0.3 }, { word: 'there', start: 0.3, end: 0.6 }], model: 'whisper-base (in browser, CPU)', durationSeconds: 3, language: 'en', device: 'wasm' };
      },
    });
    assert.ok(called);
    assert.equal(result.text, 'Hi there');
    assert.equal(result.words?.length, 2);
    assert.equal(result.sourceLabel, 'Host mic');
    assert.equal(result.durationSeconds, 3);
  });

  it('splits a track over the cloud upload cap into WAV chunks and offsets their words', async () => {
    const big = { ...file, blob: { size: CLOUD_TRANSCRIPTION_MAX_BYTES + 1, type: 'audio/webm' } as Blob };
    const reader = fakeReader(CLOUD_TRANSCRIPTION_CHUNK_SECONDS * 2 + 30);
    const bodies: Blob[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 2) return new Response('{}', { status: 429, headers: { 'Retry-After': '0.01' } });
      bodies.push(init?.body as Blob);
      return new Response(JSON.stringify({ text: `part ${bodies.length}`, model: 'whisper-1', words: [{ word: 'part', start: 1, end: 1.5 }] }), { status: 200 });
    }) as typeof fetch;
    const result = await requestRecordingTranscription(big, { engine: 'cloud', fetchImpl, openReader: async () => reader });
    assert.equal(bodies.length, 3);
    for (const body of bodies) {
      assert.equal(body.type, 'audio/wav');
      assert.ok(body.size < CLOUD_TRANSCRIPTION_MAX_BYTES);
    }
    assert.equal(result.text, 'part 1 part 2 part 3');
    assert.equal(result.words?.length, 3);
    assert.equal(result.words?.[0].start, 1);
    assert.ok(Math.abs((result.words?.[1].start ?? 0) - (CLOUD_TRANSCRIPTION_CHUNK_SECONDS + 1)) < 10, 'second chunk is offset by about ten minutes');
    assert.ok(reader.closed);
  });
});

describe('transcription settings', () => {
  it('defaults to the browser engine and the balanced model, and round-trips choices', () => {
    assert.deepEqual(normalizeTranscriptionSettings(null), { engine: 'browser', model: 'base' });
    assert.deepEqual(normalizeTranscriptionSettings({ engine: 'cloud', model: 'huge' }), { engine: 'cloud', model: 'base' });
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    saveTranscriptionSettings({ engine: 'browser', model: 'small' }, storage);
    assert.deepEqual(loadTranscriptionSettings(storage), { engine: 'browser', model: 'small' });
    assert.deepEqual(loadTranscriptionSettings({ getItem: () => '{bad json' }), { engine: 'browser', model: 'base' });
  });
});
