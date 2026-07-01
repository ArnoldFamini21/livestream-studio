import type { BroadcastOrientation, RtmpRelayVideoConfig } from '@studio/shared';
import type { VideoEncodingReadiness } from './videoEncodingCapabilities.ts';

export type RtmpRelayOutputPresetId =
  | 'smooth-720p'
  | 'standard-1080p'
  | 'maximum-1080p'
  | 'motion-1080p60'
  | 'ultra-4k30';

export interface RtmpRelayOutputPreset {
  id: RtmpRelayOutputPresetId;
  label: string;
  detail: string;
  width: number;
  height: number;
  frameRate: 30 | 60;
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
  {
    id: 'motion-1080p60',
    label: '1080p 60',
    detail: 'Fast motion, 10 Mbps',
    width: 1920,
    height: 1080,
    frameRate: 60,
    videoBitsPerSecond: 10_000_000,
  },
  {
    id: 'ultra-4k30',
    label: '4K 30',
    detail: 'Ultra HD, 18 Mbps',
    width: 3840,
    height: 2160,
    frameRate: 30,
    videoBitsPerSecond: 18_000_000,
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

export function getRtmpRelayOutputPreflight(
  orientation: BroadcastOrientation,
  presetId: RtmpRelayOutputPresetId,
  encoding?: VideoEncodingReadiness
): RtmpRelayOutputPreflight {
  const config = getRtmpRelayVideoConfig(orientation, presetId);
  const summary = formatRtmpRelayOutputSummary(orientation, presetId);
  const ultraHd = encoding?.presets.find((preset) => preset.presetId === '4k');
  const ultraHdSmooth = ultraHd?.supported === true && ultraHd.smooth !== false;
  const ultraHdHardware = ultraHd?.hardwareAccelerated === true;

  if (config.frameRate > 30) {
    return {
      status: 'warning',
      detail: `${summary}. 60 FPS doubles encoder work; test this browser and upload path before a long live session.`,
    };
  }

  if (config.width > 1920 || config.height > 1920) {
    if (ultraHdSmooth) {
      return {
        status: 'warning',
        detail: ultraHdHardware
          ? `${summary}. 4K hardware encoding is available, but confirm upload stability before going live.`
          : `${summary}. Browser reports smooth 4K encoding, but hardware acceleration is not confirmed.`,
      };
    }
    return {
      status: 'warning',
      detail: `${summary}. 4K live relay is available, but this browser has not proven smooth 4K encoding.`,
    };
  }

  return {
    status: 'good',
    detail: summary,
  };
}
