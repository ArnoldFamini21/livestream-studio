import type { RtmpRelayEncoding, RtmpRelayVideoConfig, RtmpRelayVideoMode } from '@studio/shared';

/**
 * What the browser uploads to the media relay.
 *
 * The free media server has about a tenth of a CPU core, far too little to
 * re-encode a live 1080p stream. So the browser encodes H.264 itself (in
 * hardware on most machines) and the server only copies it to the
 * platforms. That needs a MediaRecorder that writes H.264 and lets us ask
 * for a keyframe every two seconds: YouTube and Facebook want one at least
 * every four. Browsers that cannot do both fall back to VP8, which the
 * server must re-encode at 720p30 (slow on the free tier).
 */

/** Keyframe interval asked of the browser; the platforms accept up to 4 s. */
export const RELAY_KEYFRAME_INTERVAL_MS = 2_000;

/** Ceiling of the server's re-encode fallback (see media-server rtmp.ts). */
export const RELAY_TRANSCODE_MAX_PIXELS = 1280 * 720;
export const RELAY_TRANSCODE_MAX_FRAME_RATE = 30;
export const RELAY_TRANSCODE_MAX_VIDEO_BITS_PER_SECOND = 3_000_000;

interface RecorderCandidate {
  mimeType: string;
  container: RtmpRelayEncoding['container'];
  videoCodec: RtmpRelayEncoding['videoCodec'];
}

/** In order of preference: H.264 first (server copies it), then VP8/VP9. */
export const RELAY_RECORDER_CANDIDATES: readonly RecorderCandidate[] = [
  { mimeType: 'video/x-matroska;codecs=avc1,opus', container: 'matroska', videoCodec: 'h264' },
  { mimeType: 'video/webm;codecs=h264,opus', container: 'webm', videoCodec: 'h264' },
  { mimeType: 'video/webm;codecs=avc1,opus', container: 'webm', videoCodec: 'h264' },
  { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm', videoCodec: 'vp8' },
  { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm', videoCodec: 'vp9' },
  { mimeType: 'video/webm', container: 'webm', videoCodec: 'unknown' },
];

export interface RelayRecorderFormat {
  mimeType: string;
  encoding: RtmpRelayEncoding;
  /** How the server will handle this upload. */
  videoMode: RtmpRelayVideoMode;
}

export interface RelayRecorderSupport {
  isTypeSupported: (mimeType: string) => boolean;
  /** Whether MediaRecorder honours videoKeyFrameIntervalDuration. */
  keyframeIntervalSupported: boolean;
}

export function chooseRelayRecorderFormat(support: RelayRecorderSupport): RelayRecorderFormat | null {
  const candidate = RELAY_RECORDER_CANDIDATES.find((item) => {
    try {
      return support.isTypeSupported(item.mimeType);
    } catch {
      return false;
    }
  });
  if (!candidate) return null;
  const keyframeIntervalMs = support.keyframeIntervalSupported ? RELAY_KEYFRAME_INTERVAL_MS : null;
  const encoding: RtmpRelayEncoding = {
    container: candidate.container,
    videoCodec: candidate.videoCodec,
    audioCodec: 'opus',
    keyframeIntervalMs,
  };
  return {
    mimeType: candidate.mimeType,
    encoding,
    videoMode: candidate.videoCodec === 'h264' && keyframeIntervalMs !== null ? 'copy' : 'transcode',
  };
}

type RecorderConstructor = new (stream: MediaStream, options?: MediaRecorderOptions) => unknown;

/**
 * WebIDL reads every dictionary member a browser knows while converting the
 * constructor's options, before anything else happens. A getter on the
 * member tells us whether it is known, even if the constructor then throws
 * because the stream has no tracks.
 */
export function detectRecorderKeyframeIntervalSupport(
  Recorder: RecorderConstructor | undefined,
  createStream: () => MediaStream
): boolean {
  if (!Recorder) return false;
  let read = false;
  const options = {
    get videoKeyFrameIntervalDuration() {
      read = true;
      return RELAY_KEYFRAME_INTERVAL_MS;
    },
  };
  try {
    const recorder = new Recorder(createStream(), options as MediaRecorderOptions);
    void recorder;
  } catch {
    // An empty stream may be refused after the options were read.
  }
  return read;
}

let cachedFormat: RelayRecorderFormat | null | undefined;

/** The format this browser will upload in, detected once. */
export function getRelayRecorderFormat(): RelayRecorderFormat | null {
  if (cachedFormat !== undefined) return cachedFormat;
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    cachedFormat = null;
    return cachedFormat;
  }
  cachedFormat = chooseRelayRecorderFormat({
    isTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    keyframeIntervalSupported: detectRecorderKeyframeIntervalSupport(
      MediaRecorder as unknown as RecorderConstructor,
      () => new MediaStream()
    ),
  });
  return cachedFormat;
}

/** MediaRecorder options for the relay upload. */
export function buildRelayRecorderOptions(
  format: RelayRecorderFormat,
  videoConfig: RtmpRelayVideoConfig,
  audioBitsPerSecond: number
): MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } {
  return {
    mimeType: format.mimeType,
    videoBitsPerSecond: videoConfig.videoBitsPerSecond,
    audioBitsPerSecond,
    ...(format.encoding.keyframeIntervalMs !== null
      ? { videoKeyFrameIntervalDuration: format.encoding.keyframeIntervalMs }
      : {}),
  };
}

function roundToEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * When the server has to re-encode, send what it will output (at most
 * 720p30, 3 Mbps): a bigger upload only costs the host's bandwidth and the
 * server's CPU for scaling.
 */
export function getRelayUploadVideoConfig(
  config: RtmpRelayVideoConfig,
  videoMode: RtmpRelayVideoMode
): RtmpRelayVideoConfig {
  if (videoMode === 'copy') return config;
  let { width, height } = config;
  const pixels = width * height;
  if (pixels > RELAY_TRANSCODE_MAX_PIXELS) {
    const scale = Math.sqrt(RELAY_TRANSCODE_MAX_PIXELS / pixels);
    width = roundToEven(Math.floor(width * scale));
    height = roundToEven(Math.floor(height * scale));
  }
  return {
    width,
    height,
    frameRate: Math.min(config.frameRate, RELAY_TRANSCODE_MAX_FRAME_RATE),
    videoBitsPerSecond: Math.min(config.videoBitsPerSecond, RELAY_TRANSCODE_MAX_VIDEO_BITS_PER_SECOND),
  };
}

export function describeRelayVideoMode(videoMode: RtmpRelayVideoMode): string {
  return videoMode === 'copy'
    ? 'Browser H.264, copied by the server'
    : 'Server re-encode (slow on free tier)';
}
