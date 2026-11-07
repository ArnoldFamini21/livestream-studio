import type { BroadcastOrientation, RtmpRelayVideoConfig, RtmpRelayVideoMode } from '@studio/shared';
import type { VideoEncodingReadiness } from './videoEncodingCapabilities.ts';

/**
 * Output presets the studio can honestly deliver. The compositor draws a
 * 1920x1080 program at 30 fps, so there is no 60 fps or 4K preset: those
 * only duplicated frames or upscaled the picture at two to four times the
 * upload.
 */
export type RtmpRelayOutputPresetId =
  | 'smooth-720p'
  | 'standard-1080p'
  | 'maximum-1080p';

export interface RtmpRelayOutputPreset {
  id: RtmpRelayOutputPresetId;
  label: string;
  detail: string;
  width: number;
  height: number;
  frameRate: 30;
  videoBitsPerSecond: number;
}

export interface RtmpRelayOutputPreflight {
  status: 'good' | 'warning';
  detail: string;
}

export const RTMP_RELAY_AUDIO_BITS_PER_SECOND = 160_000;
export const DEFAULT_RTMP_RELAY_OUTPUT_PRESET_ID: RtmpRelayOutputPresetId = 'standard-1080p';

export const RTMP_RELAY_OUTPUT_PRESETS: RtmpRelayOutputPreset[] = [
  {
    id: 'smooth-720p',
    label: '720p Smooth',
    detail: 'Lower bandwidth, 2.5 Mbps',
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitsPerSecond: 2_500_000,
  },
  {
    id: 'standard-1080p',
    label: '1080p Standard',
    detail: 'Default quality, 4.5 Mbps',
    width: 1920,
    height: 1080,
    frameRate: 30,
    videoBitsPerSecond: 4_500_000,
  },
  {
    id: 'maximum-1080p',
    label: '1080p Max',
    detail: 'High motion, 8 Mbps',
    width: 1920,
    height: 1080,
    frameRate: 30,
    videoBitsPerSecond: 8_000_000,
  },
];

export function getRtmpRelayOutputPreset(
  presetId: RtmpRelayOutputPresetId
): RtmpRelayOutputPreset {
  return RTMP_RELAY_OUTPUT_PRESETS.find((preset) => preset.id === presetId)
    || RTMP_RELAY_OUTPUT_PRESETS.find((preset) => preset.id === DEFAULT_RTMP_RELAY_OUTPUT_PRESET_ID)
    || RTMP_RELAY_OUTPUT_PRESETS[0];
}

export function getRtmpRelayVideoConfig(
  orientation: BroadcastOrientation,
  presetId: RtmpRelayOutputPresetId
): RtmpRelayVideoConfig {
  const preset = getRtmpRelayOutputPreset(presetId);
  const portrait = orientation === 'portrait';

  return {
    width: portrait ? preset.height : preset.width,
    height: portrait ? preset.width : preset.height,
    frameRate: preset.frameRate,
    videoBitsPerSecond: preset.videoBitsPerSecond,
  };
}

export function getRtmpRelayTargetKbps(presetId: RtmpRelayOutputPresetId): number {
  const preset = getRtmpRelayOutputPreset(presetId);
  return Math.round((preset.videoBitsPerSecond + RTMP_RELAY_AUDIO_BITS_PER_SECOND) / 1000);
}

export function formatRtmpRelayOutputSummary(
  orientation: BroadcastOrientation,
  presetId: RtmpRelayOutputPresetId
): string {
  const config = getRtmpRelayVideoConfig(orientation, presetId);
  const targetMbps = getRtmpRelayTargetKbps(presetId) / 1000;
  return `${config.width}x${config.height} / ${config.frameRate} FPS / ${targetMbps.toFixed(1)} Mbps`;
}

/**
 * Readiness of the chosen output. `relayVideoMode` is how the media server
 * will handle this browser's upload: copy (H.264) or a server re-encode,
 * which the free tier cannot run smoothly and which is capped at 720p30.
 */
export function getRtmpRelayOutputPreflight(
  orientation: BroadcastOrientation,
  presetId: RtmpRelayOutputPresetId,
  encoding?: VideoEncodingReadiness,
  relayVideoMode: RtmpRelayVideoMode | null = null
): RtmpRelayOutputPreflight {
  const summary = formatRtmpRelayOutputSummary(orientation, presetId);

  if (relayVideoMode === 'transcode') {
    return {
      status: 'warning',
      detail: `${summary}. This browser cannot upload H.264 with regular keyframes, so the media server must re-encode the stream (capped at 720p30, and it stutters on the free tier). Use a current Chrome or Edge for a smooth broadcast.`,
    };
  }

  const config = getRtmpRelayVideoConfig(orientation, presetId);
  const fullHd = encoding?.presets.find((preset) => preset.presetId === '1080p');
  if (Math.max(config.width, config.height) > 1280 && fullHd?.supported === true && fullHd.smooth === false) {
    return {
      status: 'warning',
      detail: `${summary}. This browser reports that 1080p encoding may not be smooth; choose 720p Smooth if the preview stutters.`,
    };
  }

  return {
    status: 'good',
    detail: relayVideoMode === 'copy' ? `${summary}. Browser H.264, sent on without re-encoding.` : summary,
  };
}
