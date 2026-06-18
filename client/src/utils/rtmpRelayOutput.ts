import type { BroadcastOrientation, RtmpRelayVideoConfig } from '@studio/shared';

export type RtmpRelayOutputPresetId = 'smooth-720p' | 'standard-1080p' | 'maximum-1080p';

export interface RtmpRelayOutputPreset {
  id: RtmpRelayOutputPresetId;
  label: string;
  detail: string;
  width: number;
  height: number;
  frameRate: 30;
  videoBitsPerSecond: number;
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
