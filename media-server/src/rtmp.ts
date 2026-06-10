import type {
  RtmpRelayDestination,
  RtmpRelayAudioConfig,
  RtmpRelayVideoConfig,
} from '@studio/shared';

export const MAX_RTMP_DESTINATIONS = 3;
const MAX_RTMP_URL_LENGTH = 2048;
const MAX_STREAM_KEY_LENGTH = 512;

export interface FfmpegRelayOptions {
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
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

export function validateDestinations(destinations: RtmpRelayDestination[]): string | null {
  if (!Array.isArray(destinations) || destinations.length === 0) return 'At least one destination is required';
  if (destinations.length > MAX_RTMP_DESTINATIONS) {
    return `A maximum of ${MAX_RTMP_DESTINATIONS} RTMP destinations is supported`;
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

export function normalizeVideoConfig(config: RtmpRelayVideoConfig): RtmpRelayVideoConfig {
  return {
    width: clampNumber(config.width, 1920, 180, 1920),
    height: clampNumber(config.height, 1080, 180, 1920),
    frameRate: clampNumber(config.frameRate, 30, 15, 30),
    videoBitsPerSecond: clampNumber(config.videoBitsPerSecond, 4_500_000, 500_000, 8_000_000),
  };
}

export function normalizeAudioConfig(config: RtmpRelayAudioConfig): RtmpRelayAudioConfig {
  return {
    sampleRate: clampNumber(config.sampleRate, 48_000, 8_000, 48_000),
    channelCount: clampNumber(config.channelCount, 2, 1, 2),
    audioBitsPerSecond: clampNumber(config.audioBitsPerSecond, 160_000, 64_000, 256_000),
  };
}

export function createFfmpegArgs(destination: RtmpRelayDestination, options: FfmpegRelayOptions): string[] {
  const video = normalizeVideoConfig(options.video);
  const audio = normalizeAudioConfig(options.audio);
  const videoBitrateKbps = Math.round(video.videoBitsPerSecond / 1000);
  const audioBitrateKbps = Math.round(audio.audioBitsPerSecond / 1000);
  const gop = video.frameRate * 2;

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-vf', `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-r', String(video.frameRate),
    '-g', String(gop),
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${Math.round(videoBitrateKbps * 1.15)}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`,
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount),
    '-f', 'flv',
    buildRtmpOutputUrl(destination.rtmpUrl, destination.streamKey),
  ];
}
