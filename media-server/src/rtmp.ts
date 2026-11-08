import type {
  RtmpRelayDestination,
  RtmpRelayAudioConfig,
  RtmpRelayEncoding,
  RtmpRelayVideoConfig,
  RtmpRelayVideoMode,
} from '@studio/shared';
import { ffmpegProgressArgs } from './ffmpegProgress.js';

/**
 * Encode-once makes each extra destination a copy-only push (no encode), so
 * the cap is about outgoing bandwidth and memory, not CPU.
 * RTMP_MAX_DESTINATIONS can lower it, for example to stay inside a hosting
 * bandwidth allowance.
 */
export const MAX_RTMP_DESTINATIONS = 8;
/** RTMP_ENCODE_ONCE=false runs a full encode per destination: keep the old cap there. */
export const MAX_PER_DESTINATION_ENCODES = 3;
const MAX_RTMP_URL_LENGTH = 2048;
const MAX_STREAM_KEY_LENGTH = 512;
// The studio composes at 1920x1080 (or 1080x1920 for 9:16 portrait), 30 fps;
// anything above that would only be upscaled or duplicated frames at a
// higher bitrate. The caps bound each edge and the pixel count, so both
// orientations pass unchanged.
const MAX_RELAY_DIMENSION = 1920;
const MAX_RELAY_PIXELS = 1920 * 1080;
const MAX_RELAY_FRAME_RATE = 30;
const MAX_RELAY_VIDEO_BITRATE = 10_000_000;

/**
 * Server re-encode (libx264) is only a fallback for browsers that cannot
 * upload H.264. It is capped at 720p30 with the cheapest preset: on a free
 * 0.1-CPU instance even that is unlikely to keep up.
 */
export const TRANSCODE_MAX_PIXELS = 1280 * 720;
export const TRANSCODE_MAX_FRAME_RATE = 30;
export const TRANSCODE_MAX_VIDEO_BITRATE = 3_000_000;
const TRANSCODE_X264_PRESET = 'ultrafast';
/** YouTube wants a keyframe at least every 4 s; copy mode needs the browser to deliver that. */
export const MAX_COPY_KEYFRAME_INTERVAL_MS = 4_000;

export interface FfmpegRelayOptions {
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
  /** Default: transcode (older studios uploading VP8). */
  videoMode?: RtmpRelayVideoMode;
}

export interface RelayWorkState {
  exited: boolean;
  restartPending?: boolean;
}

export function hasRemainingRelayWork(relays: RelayWorkState[]): boolean {
  return relays.some((relay) => !relay.exited || Boolean(relay.restartPending));
}

export function validateRtmpUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return 'Missing RTMP server URL';
  if (trimmed.length > MAX_RTMP_URL_LENGTH) return 'RTMP server URL is too long';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'rtmp:' && parsed.protocol !== 'rtmps:') {
      return 'RTMP server URL must start with rtmp:// or rtmps://';
    }
  } catch {
    return 'Invalid RTMP server URL';
  }
  return null;
}

export function validateStreamKey(streamKey: string): string | null {
  const trimmed = streamKey.trim();
  if (!trimmed) return 'Missing stream key';
  if (trimmed.length > MAX_STREAM_KEY_LENGTH) return 'Stream key is too long';
  return null;
}

export function validateDestination(destination: RtmpRelayDestination): string | null {
  if (!destination || typeof destination !== 'object') return 'Invalid destination';
  if (typeof destination.id !== 'string' || !/^[\w-]{1,80}$/.test(destination.id)) {
    return 'Invalid destination id';
  }
  if (typeof destination.name !== 'string' || destination.name.trim().length === 0 || destination.name.length > 120) {
    return 'Invalid destination name';
  }
  if (typeof destination.rtmpUrl !== 'string') return 'Invalid RTMP server URL';
  if (typeof destination.streamKey !== 'string') return 'Invalid stream key';
  return validateRtmpUrl(destination.rtmpUrl) || validateStreamKey(destination.streamKey);
}

/**
 * How many destinations one broadcast may send to: RTMP_MAX_DESTINATIONS
 * (1 to 8, default 8), and never more than three when each destination
 * gets its own encode.
 */
export function getMaxRtmpDestinations(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RTMP_MAX_DESTINATIONS || '').trim();
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const configured = Number.isInteger(parsed) && parsed >= 1
    ? Math.min(parsed, MAX_RTMP_DESTINATIONS)
    : MAX_RTMP_DESTINATIONS;
  return isEncodeOnceEnabled(env) ? configured : Math.min(configured, MAX_PER_DESTINATION_ENCODES);
}

export function validateDestinations(
  destinations: RtmpRelayDestination[],
  maxDestinations: number = getMaxRtmpDestinations()
): string | null {
  if (!Array.isArray(destinations) || destinations.length === 0) return 'At least one destination is required';
  if (destinations.length > maxDestinations) {
    return `A maximum of ${maxDestinations} RTMP destination${maxDestinations === 1 ? '' : 's'} is supported by this media server`;
  }

  const ids = new Set<string>();
  for (const destination of destinations) {
    const issue = validateDestination(destination);
    if (issue) return `${destination?.name || 'Destination'}: ${issue}`;
    if (ids.has(destination.id)) return 'Destination ids must be unique';
    ids.add(destination.id);
  }
  return null;
}

export function buildRtmpOutputUrl(rtmpUrl: string, streamKey: string): string {
  const base = rtmpUrl.trim().replace(/\/+$/, '');
  const key = streamKey.trim().replace(/^\/+/, '');
  return `${base}/${key}`;
}

export function redactStreamKey(value: string, streamKey: string): string {
  const key = streamKey.trim();
  if (!key) return value;
  return value.split(key).join('[stream-key]');
}

export function redactDestinationUrl(destination: RtmpRelayDestination): string {
  return redactStreamKey(buildRtmpOutputUrl(destination.rtmpUrl, destination.streamKey), destination.streamKey);
}

export function redactFfmpegLine(line: string, destinations: RtmpRelayDestination[]): string {
  return destinations.reduce((current, destination) => redactStreamKey(current, destination.streamKey), line);
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function roundToEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function normalizeVideoConfig(config: RtmpRelayVideoConfig): RtmpRelayVideoConfig {
  let width = roundToEven(clampNumber(config.width, 1920, 180, MAX_RELAY_DIMENSION));
  let height = roundToEven(clampNumber(config.height, 1080, 180, MAX_RELAY_DIMENSION));

  const pixels = width * height;
  if (pixels > MAX_RELAY_PIXELS) {
    const scale = Math.sqrt(MAX_RELAY_PIXELS / pixels);
    width = roundToEven(width * scale);
    height = roundToEven(height * scale);
  }

  return {
    width,
    height,
    frameRate: clampNumber(config.frameRate, 30, 15, MAX_RELAY_FRAME_RATE),
    videoBitsPerSecond: clampNumber(config.videoBitsPerSecond, 4_500_000, 500_000, MAX_RELAY_VIDEO_BITRATE),
  };
}

export function normalizeAudioConfig(config: RtmpRelayAudioConfig): RtmpRelayAudioConfig {
  return {
    sampleRate: clampNumber(config.sampleRate, 48_000, 8_000, 48_000),
    channelCount: clampNumber(config.channelCount, 2, 1, 2),
    audioBitsPerSecond: clampNumber(config.audioBitsPerSecond, 160_000, 64_000, 256_000),
  };
}

const RELAY_CONTAINERS = new Set(['webm', 'matroska']);
const RELAY_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'unknown']);
const RELAY_AUDIO_CODECS = new Set(['opus', 'aac', 'unknown']);

/** What the studio says it uploads; an older studio that says nothing sent VP8 WebM. */
export function normalizeRelayEncoding(value: unknown): RtmpRelayEncoding {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const container = typeof input.container === 'string' && RELAY_CONTAINERS.has(input.container)
    ? input.container as RtmpRelayEncoding['container']
    : 'webm';
  const videoCodec = typeof input.videoCodec === 'string' && RELAY_VIDEO_CODECS.has(input.videoCodec)
    ? input.videoCodec as RtmpRelayEncoding['videoCodec']
    : (value ? 'unknown' : 'vp8');
  const audioCodec = typeof input.audioCodec === 'string' && RELAY_AUDIO_CODECS.has(input.audioCodec)
    ? input.audioCodec as RtmpRelayEncoding['audioCodec']
    : (value ? 'unknown' : 'opus');
  const interval = typeof input.keyframeIntervalMs === 'number' && Number.isFinite(input.keyframeIntervalMs)
    ? Math.round(input.keyframeIntervalMs)
    : null;
  return {
    container,
    videoCodec,
    audioCodec,
    keyframeIntervalMs: interval !== null && interval > 0 ? interval : null,
  };
}

/**
 * Copy the browser's video when it is H.264 with keyframes the platforms
 * accept; otherwise re-encode on the server.
 */
export function getRelayVideoMode(encoding: unknown): RtmpRelayVideoMode {
  const normalized = normalizeRelayEncoding(encoding);
  return normalized.videoCodec === 'h264'
    && normalized.keyframeIntervalMs !== null
    && normalized.keyframeIntervalMs <= MAX_COPY_KEYFRAME_INTERVAL_MS
    ? 'copy'
    : 'transcode';
}

/**
 * The size and rate the destinations receive. Copy mode passes the browser's
 * stream through as it is; transcode is held to the 720p30 fallback ceiling.
 */
export function getRelayOutputVideoConfig(config: RtmpRelayVideoConfig, mode: RtmpRelayVideoMode): RtmpRelayVideoConfig {
  const video = normalizeVideoConfig(config);
  if (mode === 'copy') return video;
  let { width, height } = video;
  const pixels = width * height;
  if (pixels > TRANSCODE_MAX_PIXELS) {
    const scale = Math.sqrt(TRANSCODE_MAX_PIXELS / pixels);
    width = roundToEven(Math.floor(width * scale));
    height = roundToEven(Math.floor(height * scale));
  }
  return {
    width,
    height,
    frameRate: Math.min(video.frameRate, TRANSCODE_MAX_FRAME_RATE),
    videoBitsPerSecond: Math.min(video.videoBitsPerSecond, TRANSCODE_MAX_VIDEO_BITRATE),
  };
}

/** Encoder options for a start payload: the output size, the audio and the video mode. */
export function getRelayEncoderOptions(payload: {
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
  encoding?: unknown;
}): Required<FfmpegRelayOptions> {
  return {
    video: normalizeVideoConfig(payload.video),
    audio: normalizeAudioConfig(payload.audio),
    videoMode: getRelayVideoMode(payload.encoding),
  };
}

export function describeRelayVideoMode(options: Required<FfmpegRelayOptions>): string {
  const output = getRelayOutputVideoConfig(options.video, options.videoMode);
  const size = `${output.width}x${output.height}@${output.frameRate}`;
  return options.videoMode === 'copy'
    ? `browser H.264 copied (${size}), audio to AAC`
    : `server transcoding (slow on free tier) to ${size}`;
}

const WEBM_INPUT_ARGS = ['-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0'];

function createAudioEncodeArgs(audio: RtmpRelayAudioConfig): string[] {
  return [
    '-c:a', 'aac',
    '-b:a', `${Math.round(audio.audioBitsPerSecond / 1000)}k`,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount),
  ];
}

function createX264Args(video: RtmpRelayVideoConfig, preset: string): string[] {
  const videoBitrateKbps = Math.round(video.videoBitsPerSecond / 1000);
  return [
    '-vf', `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-r', String(video.frameRate),
    '-g', String(video.frameRate * 2),
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${Math.round(videoBitrateKbps * 1.15)}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`,
  ];
}

/**
 * The studio's media into H.264/AAC. In copy mode the browser already sent
 * H.264 at the output size, so only the audio is encoded (Opus to AAC costs
 * a small fraction of a core). Transcode re-encodes the video with libx264
 * at the capped fallback size.
 */
function createEncodeArgs(options: FfmpegRelayOptions): string[] {
  const mode = options.videoMode ?? 'transcode';
  const audio = normalizeAudioConfig(options.audio);
  const head = ['-hide_banner', '-loglevel', 'warning', ...ffmpegProgressArgs(), ...WEBM_INPUT_ARGS];
  if (mode === 'copy') {
    return [
      ...head,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      ...createAudioEncodeArgs(audio),
    ];
  }
  return [
    ...head,
    ...createX264Args(getRelayOutputVideoConfig(options.video, mode), TRANSCODE_X264_PRESET),
    ...createAudioEncodeArgs(audio),
  ];
}

export function createFfmpegArgs(destination: RtmpRelayDestination, options: FfmpegRelayOptions): string[] {
  return [
    ...createEncodeArgs(options),
    '-f', 'flv',
    buildRtmpOutputUrl(destination.rtmpUrl, destination.streamKey),
  ];
}

/**
 * The one shared encode for all destinations: the studio's WebM/Matroska in,
 * H.264/AAC FLV out on stdout. Packets are flushed immediately so
 * destinations stay live.
 */
export function createFfmpegEncoderArgs(options: FfmpegRelayOptions): string[] {
  return [
    ...createEncodeArgs(options),
    '-flush_packets', '1',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    'pipe:1',
  ];
}

/**
 * "We'll be right back" while the studio reconnects: a still image and
 * silence at the program's output size and frame rate, so the destinations
 * can switch to it and back without a new stream. There is no browser video
 * to copy here, so it always encodes, but a still image with the fastest
 * x264 preset costs little. The program cuts to it at a keyframe, sending
 * its own codec setup first.
 */
export function createFfmpegSlateArgs(options: FfmpegRelayOptions, imagePath: string): string[] {
  const video = getRelayOutputVideoConfig(options.video, options.videoMode ?? 'transcode');
  const audio = normalizeAudioConfig(options.audio);
  const layout = audio.channelCount === 1 ? 'mono' : 'stereo';
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re', '-loop', '1', '-framerate', String(video.frameRate), '-i', imagePath,
    '-re', '-f', 'lavfi', '-i', `anullsrc=r=${audio.sampleRate}:cl=${layout}`,
    '-map', '0:v', '-map', '1:a',
    ...createX264Args(video, 'ultrafast'),
    ...createAudioEncodeArgs(audio),
    '-flush_packets', '1',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    'pipe:1',
  ];
}

/** A destination's uploader: pushes the shared FLV to RTMP without re-encoding. */
export function createFfmpegPushArgs(destination: RtmpRelayDestination): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    ...ffmpegProgressArgs(),
    '-f', 'flv',
    '-i', 'pipe:0',
    '-c', 'copy',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    buildRtmpOutputUrl(destination.rtmpUrl, destination.streamKey),
  ];
}

/** Bytes that hold `seconds` of media at the given bitrates. */
export function bytesForSeconds(seconds: number, options: FfmpegRelayOptions): number {
  const video = normalizeVideoConfig(options.video);
  const audio = normalizeAudioConfig(options.audio);
  return Math.round(((video.videoBitsPerSecond + audio.audioBitsPerSecond) / 8) * seconds);
}

/**
 * Encode-once is the default. RTMP_ENCODE_ONCE=false restores one full
 * encode per destination.
 */
export function isEncodeOnceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.RTMP_ENCODE_ONCE || '').trim().toLowerCase());
}
