import type { BroadcastOrientation, StreamDestination } from '@studio/shared';

export const MAX_ENABLED_DESTINATIONS = 3;

export interface StreamPlatformGuide {
  platform: StreamDestination['platform'];
  label: string;
  color: string;
  defaultRtmpUrl: string;
  dashUrl?: string;
  dashboardLabel: string;
  rtmpUrlEditable: boolean;
  recommendedOrientation: BroadcastOrientation | null;
  orientationDetail: string;
  streamKeyLabel: string;
  streamKeyPlaceholder: string;
  setupSteps: readonly string[];
  keyHelp: string;
}

export const STREAM_PLATFORM_GUIDES: readonly StreamPlatformGuide[] = [
  {
    platform: 'youtube',
    label: 'YouTube',
    color: '#FF0000',
    defaultRtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    dashUrl: 'https://studio.youtube.com/channel/UC/livestreaming',
    dashboardLabel: 'YouTube Studio',
    rtmpUrlEditable: false,
    recommendedOrientation: 'landscape',
    orientationDetail: 'Use landscape for standard YouTube lives; portrait only for Shorts-style events.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your YouTube stream key',
    setupSteps: [
      'Open YouTube Studio Live Control Room.',
      'Copy the stream key from Stream settings.',
      'Confirm the event is set to normal latency before starting here.',
    ],
    keyHelp: 'YouTube hides the key after creation; copy it directly from Live Control Room.',
  },
  {
    platform: 'facebook',
    label: 'Facebook',
    color: '#1877F2',
    defaultRtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    dashUrl: 'https://www.facebook.com/live/producer',
    dashboardLabel: 'Live Producer',
    rtmpUrlEditable: false,
    recommendedOrientation: 'landscape',
    orientationDetail: 'Use landscape for pages, groups, and scheduled Facebook Live events.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your Facebook stream key',
    setupSteps: [
      'Open Facebook Live Producer.',
      'Choose Streaming software as the source.',
      'Copy the stream key and keep the event waiting for the relay.',
    ],
    keyHelp: 'Use a persistent stream key only if your Facebook event is configured for it.',
  },
  {
    platform: 'twitch',
    label: 'Twitch',
    color: '#9146FF',
    defaultRtmpUrl: 'rtmp://live.twitch.tv/app/',
    dashUrl: 'https://dashboard.twitch.tv/broadcast',
    dashboardLabel: 'Creator Dashboard',
    rtmpUrlEditable: false,
    recommendedOrientation: 'landscape',
    orientationDetail: 'Twitch expects a 16:9 gaming or talk-show style output.',
    streamKeyLabel: 'Primary stream key',
    streamKeyPlaceholder: 'Paste your Twitch primary stream key',
    setupSteps: [
      'Open Twitch Creator Dashboard.',
      'Copy the primary stream key from Stream settings.',
      'Keep this page private because the key can broadcast to your channel.',
    ],
    keyHelp: 'Reset the key in Twitch if it was exposed in another tool.',
  },
  {
    platform: 'linkedin',
    label: 'LinkedIn',
    color: '#0A66C2',
    defaultRtmpUrl: 'rtmps://rtmp-api.linkedin.com:443/rtmp/',
    dashUrl: 'https://www.linkedin.com/video/golive/now/',
    dashboardLabel: 'LinkedIn Live',
    rtmpUrlEditable: false,
    recommendedOrientation: 'landscape',
    orientationDetail: 'LinkedIn Live events are optimized for polished 16:9 webinar output.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your LinkedIn stream key',
    setupSteps: [
      'Create or open your LinkedIn Live event.',
      'Select third-party streaming software.',
      'Copy the stream key shortly before going live.',
    ],
    keyHelp: 'LinkedIn keys can be event-specific, so re-check before each scheduled stream.',
  },
  {
    platform: 'instagram',
    label: 'Instagram',
    color: '#E4405F',
    defaultRtmpUrl: 'rtmps://live-upload.instagram.com:443/rtmp/',
    dashUrl: 'https://www.instagram.com/live/producer/',
    dashboardLabel: 'Live Producer',
    rtmpUrlEditable: false,
    recommendedOrientation: 'portrait',
    orientationDetail: 'Instagram Live is portrait-first; switch the output to 9:16 before going live.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your Instagram stream key',
    setupSteps: [
      'Open Instagram Live Producer on desktop.',
      'Copy the stream key from the live setup screen.',
      'Use portrait output so the live does not appear letterboxed.',
    ],
    keyHelp: 'Instagram stream keys are short lived. Paste the latest key right before starting.',
  },
  {
    platform: 'custom',
    label: 'Custom RTMP',
    color: '#71717a',
    defaultRtmpUrl: '',
    dashboardLabel: 'Destination dashboard',
    rtmpUrlEditable: true,
    recommendedOrientation: null,
    orientationDetail: 'Match the orientation expected by your RTMP destination.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste the destination stream key',
    setupSteps: [
      'Copy the RTMP or RTMPS server URL from your destination.',
      'Paste the matching stream key from that same event or channel.',
      'Run a short private test before your public show.',
    ],
    keyHelp: 'Use RTMPS when your destination supports it.',
  },
];

export function getStreamPlatformGuide(platform: StreamDestination['platform']): StreamPlatformGuide {
  return STREAM_PLATFORM_GUIDES.find((guide) => guide.platform === platform) || STREAM_PLATFORM_GUIDES[STREAM_PLATFORM_GUIDES.length - 1];
}

export function getDefaultRtmpUrl(platform: StreamDestination['platform']): string {
  return getStreamPlatformGuide(platform).defaultRtmpUrl;
}

export function isValidRtmpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'rtmp:' || parsed.protocol === 'rtmps:';
  } catch {
    return false;
  }
}

export function getStreamDestinationIssue(dest: Pick<StreamDestination, 'rtmpUrl' | 'streamKey'>): string | null {
  if (!dest.rtmpUrl.trim()) return 'Missing RTMP server URL';
  if (!isValidRtmpUrl(dest.rtmpUrl.trim())) return 'RTMP URL must start with rtmp:// or rtmps://';
  if (!dest.streamKey.trim()) return 'Missing stream key';
  return null;
}

export function getPlatformOrientationWarning(
  platform: StreamDestination['platform'],
  orientation: BroadcastOrientation
): string | null {
  const guide = getStreamPlatformGuide(platform);
  if (!guide.recommendedOrientation || guide.recommendedOrientation === orientation) return null;
  if (guide.platform === 'instagram') {
    return 'Instagram Live is portrait-first. Switch output to 9:16 before going live.';
  }
  return `${guide.label} is usually best in 16:9 landscape. Keep portrait only for vertical events.`;
}

export function getEnabledDestinations(destinations: StreamDestination[]): StreamDestination[] {
  return destinations.filter((destination) => destination.enabled);
}

export function getEnabledDestinationPreflightIssue(
  destinations: StreamDestination[],
  relayIssue: string | null = null
): string | null {
  const enabledDestinations = getEnabledDestinations(destinations);
  const enabledCount = enabledDestinations.length;

  if (enabledCount === 0) return 'Enable at least one destination.';
  if (enabledCount > MAX_ENABLED_DESTINATIONS) {
    const extraCount = enabledCount - MAX_ENABLED_DESTINATIONS;
    return `Disable ${extraCount} destination${extraCount === 1 ? '' : 's'} to stay within the ${MAX_ENABLED_DESTINATIONS}-destination limit.`;
  }

  for (const destination of enabledDestinations) {
    const issue = getStreamDestinationIssue(destination);
    if (issue) return `${destination.name}: ${issue}`;
  }

  return relayIssue;
}

export function maskStreamKey(streamKey: string): string {
  const trimmed = streamKey.trim();
  if (trimmed.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(trimmed.length - 4, 12))}${trimmed.slice(-4)}`;
}
