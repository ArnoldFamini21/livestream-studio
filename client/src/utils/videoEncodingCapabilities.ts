import {
  VIDEO_QUALITY_PRESETS,
  type VideoQualityPreset,
  type VideoQualityPresetId,
} from './mediaPreferences.ts';
import {
  VIDEO_MP4_MEDIA_RECORDER_TYPES,
  VIDEO_WEBM_MEDIA_RECORDER_TYPES,
} from './recordingMimeTypes.ts';

export type VideoEncodingReadinessStatus = 'ready' | 'limited' | 'unsupported';

export interface VideoEncodingApiSupport {
  mediaRecorder: boolean;
  mediaCapabilities: boolean;
  webCodecs: boolean;
}

export interface BrowserVideoEncodingConfiguration {
  type: 'record';
  video: {
    contentType: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
  };
}

export interface VideoEncodingPresetConfig {
  presetId: VideoQualityPresetId;
  label: string;
  configuration: BrowserVideoEncodingConfiguration;
}

export interface VideoEncodingPresetSupport {
  presetId: VideoQualityPresetId;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  supported: boolean | null;
  smooth: boolean | null;
  powerEfficient: boolean | null;
  hardwareAccelerated: boolean | null;
}

export interface VideoEncodingReadiness {
  status: VideoEncodingReadinessStatus;
  label: string;
  detail: string;
  apiSupport: VideoEncodingApiSupport;
  presets: VideoEncodingPresetSupport[];
}

export interface BrowserVideoEncodingInfoLike {
  supported?: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
}

export interface BrowserMediaCapabilitiesLike {
  encodingInfo?: (configuration: BrowserVideoEncodingConfiguration) => Promise<BrowserVideoEncodingInfoLike>;
}

export interface BrowserMediaRecorderLike {
  isTypeSupported?: (contentType: string) => boolean;
}

export type BrowserVideoEncoderHardwareAcceleration = 'no-preference' | 'prefer-hardware' | 'prefer-software';

export interface BrowserVideoEncoderConfigLike {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  hardwareAcceleration?: BrowserVideoEncoderHardwareAcceleration;
}

export interface BrowserVideoEncoderSupportLike {
  supported?: boolean;
  config?: BrowserVideoEncoderConfigLike;
}

export interface BrowserVideoEncoderLike {
  isConfigSupported?: (configuration: BrowserVideoEncoderConfigLike) => Promise<BrowserVideoEncoderSupportLike>;
}

export interface BrowserVideoEncodingEnvironment {
  mediaRecorder?: BrowserMediaRecorderLike | null;
  mediaCapabilities?: BrowserMediaCapabilitiesLike | null;
  videoEncoder?: BrowserVideoEncoderLike | null;
}

const VIDEO_RECORDING_CONTENT_TYPES = [
  ...VIDEO_MP4_MEDIA_RECORDER_TYPES,
  ...VIDEO_WEBM_MEDIA_RECORDER_TYPES,
] as const;

const VIDEO_ENCODING_BITRATES: Record<VideoQualityPresetId, number> = {
  '720p': 4_000_000,
  '1080p': 8_000_000,
  '4k': 24_000_000,
};

function getCurrentBrowserVideoEncodingEnvironment(): BrowserVideoEncodingEnvironment {
  const nav = typeof navigator === 'undefined'
    ? undefined
    : navigator as Navigator & { mediaCapabilities?: BrowserMediaCapabilitiesLike };
  const root = typeof globalThis === 'undefined'
    ? {}
    : globalThis as { MediaRecorder?: unknown; VideoEncoder?: unknown };

  return {
    mediaRecorder: root.MediaRecorder as BrowserMediaRecorderLike | null | undefined,
    mediaCapabilities: nav?.mediaCapabilities ?? null,
    videoEncoder: root.VideoEncoder as BrowserVideoEncoderLike | null | undefined,
  };
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function getMediaRecorderTypeSupport(mediaRecorder: unknown): BrowserMediaRecorderLike['isTypeSupported'] | null {
  const candidate = mediaRecorder as BrowserMediaRecorderLike | undefined;
  return typeof candidate?.isTypeSupported === 'function' ? candidate.isTypeSupported.bind(candidate) : null;
}

function getVideoEncoderConfigSupport(videoEncoder: unknown): BrowserVideoEncoderLike['isConfigSupported'] | null {
  const candidate = videoEncoder as BrowserVideoEncoderLike | undefined;
  return typeof candidate?.isConfigSupported === 'function' ? candidate.isConfigSupported.bind(candidate) : null;
}

export function getPreferredVideoEncodingContentType(
  environment: BrowserVideoEncodingEnvironment = getCurrentBrowserVideoEncodingEnvironment()
): string {
  const isTypeSupported = getMediaRecorderTypeSupport(environment.mediaRecorder);
  if (!isTypeSupported) return getVideoOnlyEncodingContentType(VIDEO_RECORDING_CONTENT_TYPES[0]);

  const recordingContentType = VIDEO_RECORDING_CONTENT_TYPES.find((contentType) => {
    try {
      return isTypeSupported(contentType);
    } catch {
      return false;
    }
  }) || VIDEO_RECORDING_CONTENT_TYPES[0];
  return getVideoOnlyEncodingContentType(recordingContentType);
}

export function getVideoOnlyEncodingContentType(contentType: string): string {
  const normalized = contentType.trim();
  if (!normalized) return 'video/mp4;codecs=avc1.42E01E';
  if (!/;\s*codecs=/i.test(normalized)) return normalized;
  const [container, codecsPart] = normalized.split(/;\s*codecs=/i);
  const codecs = codecsPart
    .replace(/^["']|["']$/g, '')
    .split(',')
    .map((codec) => codec.trim())
    .filter((codec) => (
      codec &&
      !/^opus$/i.test(codec) &&
      !/^mp4a(?:\.|$)/i.test(codec) &&
      !/^aac$/i.test(codec)
    ));
  return codecs.length > 0 ? `${container};codecs=${codecs.join(',')}` : container;
}

export function getPreferredWebCodecsCodec(contentType = getVideoOnlyEncodingContentType(VIDEO_RECORDING_CONTENT_TYPES[0])): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('vp9')) return 'vp09.00.10.08';
  if (normalized.includes('vp8')) return 'vp8';
  const avcMatch = contentType.match(/avc1\.[0-9a-f]+/i);
  if (avcMatch?.[0]) return avcMatch[0];
  if (normalized.includes('avc1') || normalized.includes('h264') || normalized.includes('video/mp4')) {
    return 'avc1.42E01E';
  }
  return 'vp8';
}

function getPresetSupportFromConfig(
  preset: VideoQualityPreset,
  info?: BrowserVideoEncodingInfoLike | null,
  hardwareAccelerated: boolean | null = null
): VideoEncodingPresetSupport {
  return {
    presetId: preset.id,
    label: preset.label,
    width: preset.width,
    height: preset.height,
    frameRate: preset.frameRate,
    bitrate: VIDEO_ENCODING_BITRATES[preset.id],
    supported: readBoolean(info?.supported),
    smooth: readBoolean(info?.smooth),
    powerEfficient: readBoolean(info?.powerEfficient),
    hardwareAccelerated,
  };
}

function findPreset(
  presets: readonly VideoEncodingPresetSupport[],
  presetId: VideoQualityPresetId
): VideoEncodingPresetSupport | null {
  return presets.find((preset) => preset.presetId === presetId) || null;
}

export function buildVideoEncodingConfigs(
  presets: readonly VideoQualityPreset[] = VIDEO_QUALITY_PRESETS,
  contentType: string = getVideoOnlyEncodingContentType(VIDEO_RECORDING_CONTENT_TYPES[0])
): VideoEncodingPresetConfig[] {
  return presets.map((preset) => ({
    presetId: preset.id,
    label: preset.label,
    configuration: {
      type: 'record',
      video: {
        contentType,
        width: preset.width,
        height: preset.height,
        bitrate: VIDEO_ENCODING_BITRATES[preset.id],
        framerate: preset.frameRate,
      },
    },
  }));
}

export function buildWebCodecsEncodingConfigs(
  presets: readonly VideoQualityPreset[] = VIDEO_QUALITY_PRESETS,
  contentType: string = getVideoOnlyEncodingContentType(VIDEO_RECORDING_CONTENT_TYPES[0]),
  hardwareAcceleration: BrowserVideoEncoderHardwareAcceleration = 'prefer-hardware'
): Array<{ presetId: VideoQualityPresetId; label: string; configuration: BrowserVideoEncoderConfigLike }> {
  const codec = getPreferredWebCodecsCodec(contentType);
  return presets.map((preset) => ({
    presetId: preset.id,
    label: preset.label,
    configuration: {
      codec,
      width: preset.width,
      height: preset.height,
      bitrate: VIDEO_ENCODING_BITRATES[preset.id],
      framerate: preset.frameRate,
      hardwareAcceleration,
    },
  }));
}

export function getBrowserVideoEncodingApiSupport(
  environment: BrowserVideoEncodingEnvironment = getCurrentBrowserVideoEncodingEnvironment()
): VideoEncodingApiSupport {
  return {
    mediaRecorder: Boolean(environment.mediaRecorder),
    mediaCapabilities: typeof environment.mediaCapabilities?.encodingInfo === 'function',
    webCodecs: typeof environment.videoEncoder?.isConfigSupported === 'function',
  };
}

export function evaluateVideoEncodingReadiness(
  apiSupport: VideoEncodingApiSupport,
  presets: readonly VideoEncodingPresetSupport[] = VIDEO_QUALITY_PRESETS.map((preset) => getPresetSupportFromConfig(preset))
): VideoEncodingReadiness {
  if (!apiSupport.mediaRecorder) {
    return {
      status: 'unsupported',
      label: 'Encoder unavailable',
      detail: 'This browser cannot record local media chunks. Use a modern Chromium, Safari, or Firefox build over HTTPS.',
      apiSupport,
      presets: [...presets],
    };
  }

  if (!apiSupport.mediaCapabilities) {
    return {
      status: 'limited',
      label: 'Basic encoder',
      detail: 'Recording can start, but this browser does not expose per-quality encoding checks.',
      apiSupport,
      presets: [...presets],
    };
  }

  const hd = findPreset(presets, '1080p');
  const hdSupported = hd?.supported === true;
  const hdSmooth = hd?.smooth !== false;
  const hdPowerEfficient = hd?.powerEfficient === true;
  const hdHardwareAccelerated = hd?.hardwareAccelerated === true;
  const ultraHd = findPreset(presets, '4k');
  const ultraHdHardwareAccelerated = ultraHd?.hardwareAccelerated === true;

  if (hdSupported && hdSmooth && (hdPowerEfficient || hdHardwareAccelerated)) {
    return {
      status: 'ready',
      label: hdHardwareAccelerated ? 'Hardware-ready encoder' : 'Efficient encoder',
      detail: hdHardwareAccelerated
        ? ultraHd?.supported === true && ultraHd.smooth !== false
          ? `1080p/30 browser recording is smooth with WebCodecs hardware acceleration${ultraHdHardwareAccelerated ? '; 4K/30 hardware acceleration is also available.' : '; 4K/30 should be tested before long sessions.'}`
          : '1080p/30 browser recording is smooth with WebCodecs hardware acceleration.'
        : ultraHd?.supported === true && ultraHd.smooth !== false
          ? '1080p/30 and 4K/30 browser recording are advertised as smooth; 1080p is power efficient.'
          : '1080p/30 browser recording is advertised as smooth and power efficient.',
      apiSupport,
      presets: [...presets],
    };
  }

  if (hdSupported && hdSmooth) {
    return {
      status: 'ready',
      label: '1080p encoder ready',
      detail: '1080p/30 browser recording is advertised as smooth; power efficiency is not confirmed.',
      apiSupport,
      presets: [...presets],
    };
  }

  const fallback = presets.find((preset) => preset.supported === true && preset.smooth !== false);
  if (fallback) {
    return {
      status: 'limited',
      label: `${fallback.label} encoder ready`,
      detail: `Use ${fallback.label} for the most reliable recording and live relay on this browser.`,
      apiSupport,
      presets: [...presets],
    };
  }

  return {
    status: 'limited',
    label: 'Encoder check limited',
    detail: 'The browser recorder is available, but 1080p/30 recording was not advertised as smooth.',
    apiSupport,
    presets: [...presets],
  };
}

export function getInitialVideoEncodingReadiness(
  environment: BrowserVideoEncodingEnvironment = getCurrentBrowserVideoEncodingEnvironment()
): VideoEncodingReadiness {
  const apiSupport = getBrowserVideoEncodingApiSupport(environment);
  if (!apiSupport.mediaRecorder || !apiSupport.mediaCapabilities) {
    return evaluateVideoEncodingReadiness(apiSupport);
  }
  return {
    status: 'limited',
    label: 'Checking encoder',
    detail: 'Checking browser support for 720p, 1080p, and 4K recording.',
    apiSupport,
    presets: VIDEO_QUALITY_PRESETS.map((preset) => getPresetSupportFromConfig(preset)),
  };
}

export async function detectBrowserVideoEncodingReadiness(
  environment: BrowserVideoEncodingEnvironment = getCurrentBrowserVideoEncodingEnvironment(),
  presets: readonly VideoQualityPreset[] = VIDEO_QUALITY_PRESETS
): Promise<VideoEncodingReadiness> {
  const apiSupport = getBrowserVideoEncodingApiSupport(environment);

  if (!apiSupport.mediaRecorder || !apiSupport.mediaCapabilities || !environment.mediaCapabilities?.encodingInfo) {
    return evaluateVideoEncodingReadiness(
      apiSupport,
      presets.map((preset) => getPresetSupportFromConfig(preset))
    );
  }

  const preferredContentType = getPreferredVideoEncodingContentType(environment);
  const configs = buildVideoEncodingConfigs(presets, preferredContentType);
  const presetSupport = await Promise.all(configs.map(async ({ presetId, configuration }) => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) throw new Error(`Unknown encoding preset ${presetId}`);

    try {
      const info = await environment.mediaCapabilities?.encodingInfo?.(configuration);
      return getPresetSupportFromConfig(preset, info);
    } catch {
      return getPresetSupportFromConfig(preset);
    }
  }));

  const isConfigSupported = getVideoEncoderConfigSupport(environment.videoEncoder);
  if (isConfigSupported) {
    const webCodecsConfigs = buildWebCodecsEncodingConfigs(presets, preferredContentType, 'prefer-hardware');
    const hardwareSupport = new Map<VideoQualityPresetId, boolean | null>();
    await Promise.all(webCodecsConfigs.map(async ({ presetId, configuration }) => {
      try {
        const info = await isConfigSupported(configuration);
        hardwareSupport.set(presetId, readBoolean(info?.supported));
      } catch {
        hardwareSupport.set(presetId, null);
      }
    }));

    for (const preset of presetSupport) {
      preset.hardwareAccelerated = hardwareSupport.get(preset.presetId) ?? null;
    }
  }

  return evaluateVideoEncodingReadiness(apiSupport, presetSupport);
}
