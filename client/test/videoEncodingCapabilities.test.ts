import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildVideoEncodingConfigs,
  buildWebCodecsEncodingConfigs,
  detectBrowserVideoEncodingReadiness,
  evaluateVideoEncodingReadiness,
  getBrowserVideoEncodingApiSupport,
  getInitialVideoEncodingReadiness,
  getPreferredVideoEncodingContentType,
  getPreferredWebCodecsCodec,
  type BrowserVideoEncodingConfiguration,
  type BrowserVideoEncodingEnvironment,
} from '../src/utils/videoEncodingCapabilities.ts';

function createEnvironment(
  encodingInfo?: BrowserVideoEncodingEnvironment['mediaCapabilities']['encodingInfo'],
  overrides: Partial<BrowserVideoEncodingEnvironment> = {}
): BrowserVideoEncodingEnvironment {
  return {
    mediaRecorder: function MediaRecorder() {},
    mediaCapabilities: encodingInfo ? { encodingInfo } : null,
    videoEncoder: {
      isConfigSupported: async () => ({ supported: true }),
    },
    ...overrides,
  };
}

describe('video encoding capability detection', () => {
  it('builds bounded MediaCapabilities configs for 720p, 1080p, and 4K', () => {
    const configs = buildVideoEncodingConfigs();

    assert.deepEqual(configs.map((config) => config.presetId), ['720p', '1080p', '4k']);
    assert.deepEqual(configs.map((config) => config.configuration.video.width), [1280, 1920, 3840]);
    assert.deepEqual(configs.map((config) => config.configuration.video.framerate), [30, 30, 30]);
    assert.deepEqual(configs.map((config) => config.configuration.video.bitrate), [4_000_000, 8_000_000, 24_000_000]);
    assert.equal(configs[1].configuration.type, 'record');
    assert.equal(configs[1].configuration.video.contentType, 'video/webm;codecs=vp9');
  });

  it('builds WebCodecs hardware-preference configs from the selected WebM codec', () => {
    assert.equal(getPreferredWebCodecsCodec('video/webm;codecs=vp9'), 'vp09.00.10.08');
    assert.equal(getPreferredWebCodecsCodec('video/webm;codecs=vp8'), 'vp8');

    const configs = buildWebCodecsEncodingConfigs(undefined, 'video/webm;codecs=vp8');

    assert.deepEqual(configs.map((config) => config.presetId), ['720p', '1080p', '4k']);
    assert.equal(configs[1].configuration.codec, 'vp8');
    assert.equal(configs[1].configuration.hardwareAcceleration, 'prefer-hardware');
    assert.equal(configs[2].configuration.width, 3840);
    assert.equal(configs[2].configuration.bitrate, 24_000_000);
  });

  it('uses the first MediaRecorder-supported WebM content type for capability probes', async () => {
    const contentTypes: string[] = [];
    const webCodecsCodecs: string[] = [];
    const env = createEnvironment(async (configuration) => {
      contentTypes.push(configuration.video.contentType);
      return { supported: true, smooth: true, powerEfficient: true };
    }, {
      mediaRecorder: {
        isTypeSupported: (contentType: string) => contentType === 'video/webm;codecs=vp8',
      },
      videoEncoder: {
        isConfigSupported: async (configuration) => {
          webCodecsCodecs.push(configuration.codec);
          return { supported: true };
        },
      },
    });

    assert.equal(getPreferredVideoEncodingContentType(env), 'video/webm;codecs=vp8');

    await detectBrowserVideoEncodingReadiness(env);

    assert.deepEqual([...new Set(contentTypes)], ['video/webm;codecs=vp8']);
    assert.deepEqual([...new Set(webCodecsCodecs)], ['vp8']);
  });

  it('reports unsupported when MediaRecorder is unavailable', async () => {
    const env = createEnvironment(async () => ({ supported: true }), { mediaRecorder: undefined });

    assert.deepEqual(getBrowserVideoEncodingApiSupport(env), {
      mediaRecorder: false,
      mediaCapabilities: true,
      webCodecs: true,
    });

    const readiness = await detectBrowserVideoEncodingReadiness(env);

    assert.equal(readiness.status, 'unsupported');
    assert.equal(readiness.label, 'Encoder unavailable');
  });

  it('marks 1080p as ready when the browser advertises smooth efficient encoding', async () => {
    const seen: BrowserVideoEncodingConfiguration[] = [];
    const env = createEnvironment(async (configuration) => {
      seen.push(configuration);
      return {
        supported: configuration.video.width <= 1920,
        smooth: configuration.video.width <= 1920,
        powerEfficient: configuration.video.width <= 1920,
      };
    });

    const readiness = await detectBrowserVideoEncodingReadiness(env);

    assert.equal(seen.length, 3);
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.label, 'Hardware-ready encoder');
    assert.match(readiness.detail, /hardware acceleration/);
    assert.equal(readiness.presets.find((preset) => preset.presetId === '1080p')?.powerEfficient, true);
    assert.equal(readiness.presets.find((preset) => preset.presetId === '1080p')?.hardwareAccelerated, true);
    assert.equal(readiness.presets.find((preset) => preset.presetId === '4k')?.supported, false);
  });

  it('keeps efficient MediaRecorder readiness separate from WebCodecs hardware support', async () => {
    const env = createEnvironment(async (configuration) => ({
      supported: configuration.video.width <= 1920,
      smooth: configuration.video.width <= 1920,
      powerEfficient: configuration.video.width <= 1920,
    }), {
      videoEncoder: undefined,
    });

    const readiness = await detectBrowserVideoEncodingReadiness(env);

    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.label, 'Efficient encoder');
    assert.equal(readiness.apiSupport.webCodecs, false);
    assert.equal(readiness.presets.find((preset) => preset.presetId === '1080p')?.hardwareAccelerated, null);
  });

  it('warns when only a lighter preset is advertised as smooth', async () => {
    const env = createEnvironment(async (configuration) => ({
      supported: configuration.video.width <= 1280,
      smooth: configuration.video.width <= 1280,
      powerEfficient: configuration.video.width <= 1280,
    }));

    const readiness = await detectBrowserVideoEncodingReadiness(env);

    assert.equal(readiness.status, 'limited');
    assert.equal(readiness.label, '720p encoder ready');
    assert.match(readiness.detail, /Use 720p/);
  });

  it('keeps recording available but limited when MediaCapabilities is missing', () => {
    const env = createEnvironment(undefined, { mediaCapabilities: null, videoEncoder: undefined });
    const readiness = getInitialVideoEncodingReadiness(env);

    assert.equal(readiness.status, 'limited');
    assert.equal(readiness.label, 'Basic encoder');
    assert.deepEqual(readiness.apiSupport, {
      mediaRecorder: true,
      mediaCapabilities: false,
      webCodecs: false,
    });
  });

  it('falls back safely when encodingInfo rejects', async () => {
    const env = createEnvironment(async () => {
      throw new Error('capability probe failed');
    });

    const readiness = await detectBrowserVideoEncodingReadiness(env);

    assert.equal(readiness.status, 'limited');
    assert.equal(readiness.label, 'Encoder check limited');
    assert.equal(readiness.presets.every((preset) => preset.supported === null), true);
  });

  it('treats smooth 1080p without a power-efficiency signal as usable', () => {
    const readiness = evaluateVideoEncodingReadiness(
      { mediaRecorder: true, mediaCapabilities: true, webCodecs: false },
      [
        {
          presetId: '720p',
          label: '720p',
          width: 1280,
          height: 720,
          frameRate: 30,
          bitrate: 4_000_000,
          supported: true,
          smooth: true,
          powerEfficient: null,
          hardwareAccelerated: null,
        },
        {
          presetId: '1080p',
          label: '1080p',
          width: 1920,
          height: 1080,
          frameRate: 30,
          bitrate: 8_000_000,
          supported: true,
          smooth: true,
          powerEfficient: null,
          hardwareAccelerated: null,
        },
        {
          presetId: '4k',
          label: '4K',
          width: 3840,
          height: 2160,
          frameRate: 30,
          bitrate: 24_000_000,
          supported: false,
          smooth: false,
          powerEfficient: false,
          hardwareAccelerated: null,
        },
      ]
    );

    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.label, '1080p encoder ready');
    assert.match(readiness.detail, /power efficiency is not confirmed/);
  });
});
