import type { BroadcastOrientation, StreamDestination } from '@studio/shared';

/**
 * The media server encodes once and pushes copies to each destination, so
 * extra destinations cost bandwidth, not CPU. The media server can lower its
 * own cap (RTMP_MAX_DESTINATIONS) and then refuses a larger start.
 */
export const MAX_ENABLED_DESTINATIONS = 8;

export interface StreamPlatformGuide {
  platform: StreamDestination['platform'];
  label: string;
  color: string;
  /** Prefilled server URL; empty when the platform hands out a URL per event. */
  defaultRtmpUrl: string;
  /** Shape of the server URL, shown as the placeholder when there is no default. */
  rtmpUrlTemplate: string;
  dashUrl?: string;
  dashboardLabel: string;
  rtmpUrlEditable: boolean;
  /** Where to find the server URL, shown under the URL field. */
  rtmpUrlHelp: string;
  /** Account or plan requirement the platform puts on streaming software, if any. */
  requirement?: string;
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
    rtmpUrlTemplate: 'rtmp://a.rtmp.youtube.com/live2',
    dashUrl: 'https://studio.youtube.com/channel/UC/livestreaming',
    dashboardLabel: 'YouTube Studio',
    rtmpUrlEditable: false,
    rtmpUrlHelp: 'YouTube uses the same server for every stream.',
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
    rtmpUrlTemplate: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    dashUrl: 'https://www.facebook.com/live/producer',
    dashboardLabel: 'Live Producer',
    rtmpUrlEditable: false,
    rtmpUrlHelp: 'Facebook uses the same secure server for every stream.',
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
    rtmpUrlTemplate: 'rtmp://live.twitch.tv/app/',
    dashUrl: 'https://dashboard.twitch.tv/broadcast',
    dashboardLabel: 'Creator Dashboard',
    rtmpUrlEditable: false,
    rtmpUrlHelp: 'Twitch routes this server to the nearest ingest.',
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
    platform: 'kick',
    label: 'Kick',
    color: '#53FC18',
    defaultRtmpUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/',
    rtmpUrlTemplate: 'rtmps://<ingest>.global-contribute.live-video.net:443/app/',
    dashUrl: 'https://kick.com/dashboard/settings/stream',
    dashboardLabel: 'Kick dashboard',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'Prefilled with Kick\'s usual server. If your dashboard shows a different Stream URL, paste that one.',
    recommendedOrientation: 'landscape',
    orientationDetail: 'Kick plays 16:9 output.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your Kick stream key',
    setupSteps: [
      'Open the Kick dashboard and go to Settings, Stream URL & Key.',
      'Compare the Stream URL with the one below, then copy the stream key.',
      'Start here first; Kick shows the stream once it receives video.',
    ],
    keyHelp: 'Reset the key in Kick if it was shared or shown on screen.',
  },
  {
    platform: 'linkedin',
    label: 'LinkedIn',
    color: '#0A66C2',
    defaultRtmpUrl: '',
    rtmpUrlTemplate: 'rtmps://… (Stream URL from your LinkedIn event)',
    dashUrl: 'https://www.linkedin.com/video/golive/now/',
    dashboardLabel: 'LinkedIn Live',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'LinkedIn gives each event its own Stream URL. Paste it exactly as shown.',
    requirement: 'LinkedIn Live needs a member or page with access to streaming tools.',
    recommendedOrientation: 'landscape',
    orientationDetail: 'LinkedIn Live events are optimized for polished 16:9 webinar output.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your LinkedIn stream key',
    setupSteps: [
      'Create or open your LinkedIn Live event.',
      'Choose a streaming tool (custom stream) as the source.',
      'Copy the Stream URL and stream key shortly before going live.',
    ],
    keyHelp: 'LinkedIn keys are event-specific, so re-check both fields before each scheduled stream.',
  },
  {
    platform: 'x',
    label: 'X',
    color: '#A1A1AA',
    defaultRtmpUrl: 'rtmps://va.pscp.tv:443/x',
    rtmpUrlTemplate: 'rtmps://<region>.pscp.tv:443/x',
    dashUrl: 'https://studio.x.com/producer',
    dashboardLabel: 'Media Studio Producer',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'Prefilled with the US East server. Use the regional RTMPS URL Media Studio shows for your source.',
    requirement: 'Streaming software on X needs an account with Media Studio Producer access.',
    recommendedOrientation: 'landscape',
    orientationDetail: 'X plays 16:9 broadcasts in the timeline.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your X stream key',
    setupSteps: [
      'Open Media Studio Producer and create a source (RTMP).',
      'Copy its RTMPS URL and stream key.',
      'Create a broadcast with that source, start here, then go live in Producer.',
    ],
    keyHelp: 'A source keeps its key; delete the source in Producer if the key leaks.',
  },
  {
    platform: 'tiktok',
    label: 'TikTok',
    color: '#25F4EE',
    defaultRtmpUrl: '',
    rtmpUrlTemplate: 'rtmp://push-rtmp-….tiktokcdn.com/game/',
    dashUrl: 'https://livecenter.tiktok.com/producer',
    dashboardLabel: 'LIVE Producer',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'TikTok shows a new Server URL for each LIVE. Paste it with the key.',
    requirement: 'TikTok only gives a server URL and key to accounts with LIVE access.',
    recommendedOrientation: 'portrait',
    orientationDetail: 'TikTok LIVE is portrait-first; switch the output to 9:16 before going live.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your TikTok stream key',
    setupSteps: [
      'Open TikTok LIVE Producer on desktop and set up a LIVE.',
      'Copy the Server URL and Stream key it generates.',
      'Use portrait output, start here, then press Go LIVE in TikTok.',
    ],
    keyHelp: 'TikTok keys expire after the LIVE. Paste a fresh URL and key every time.',
  },
  {
    platform: 'instagram',
    label: 'Instagram',
    color: '#E4405F',
    defaultRtmpUrl: 'rtmps://live-upload.instagram.com:443/rtmp/',
    rtmpUrlTemplate: 'rtmps://live-upload.instagram.com:443/rtmp/',
    dashUrl: 'https://www.instagram.com/live/producer/',
    dashboardLabel: 'Live Producer',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'If Live Producer shows a different Server URL, paste that one.',
    requirement: 'Live Producer (streaming software) is not available on every Instagram account.',
    recommendedOrientation: 'portrait',
    orientationDetail: 'Instagram Live is portrait-first; switch the output to 9:16 before going live.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your Instagram stream key',
    setupSteps: [
      'Open Instagram Live Producer on desktop.',
      'Copy the server URL and stream key from the live setup screen.',
      'Use portrait output so the live does not appear letterboxed.',
    ],
    keyHelp: 'Instagram stream keys are short lived. Paste the latest key right before starting.',
  },
  {
    platform: 'vimeo',
    label: 'Vimeo',
    color: '#1AB7EA',
    defaultRtmpUrl: 'rtmps://rtmp-global.cloud.vimeo.com:443/live',
    rtmpUrlTemplate: 'rtmps://rtmp-global.cloud.vimeo.com:443/live',
    dashUrl: 'https://vimeo.com/events',
    dashboardLabel: 'Vimeo events',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'Prefilled with Vimeo\'s global RTMPS server. Use the URL your event shows if it differs.',
    requirement: 'Streaming to Vimeo needs a Vimeo plan that includes live events.',
    recommendedOrientation: 'landscape',
    orientationDetail: 'Vimeo events play 16:9 output.',
    streamKeyLabel: 'Stream key',
    streamKeyPlaceholder: 'Paste your Vimeo stream key',
    setupSteps: [
      'Open your Vimeo event and choose streaming software (RTMP).',
      'Copy the RTMP URL and stream key.',
      'Start here, check the preview in Vimeo, then go live there.',
    ],
    keyHelp: 'Each Vimeo event has its own key.',
  },
  {
    platform: 'custom',
    label: 'Custom RTMP',
    color: '#71717a',
    defaultRtmpUrl: '',
    rtmpUrlTemplate: 'rtmp:// or rtmps://',
    dashboardLabel: 'Destination dashboard',
    rtmpUrlEditable: true,
    rtmpUrlHelp: 'Any public RTMP or RTMPS ingest: Restream, Owncast, a church website player, and so on.',
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
  if (guide.recommendedOrientation === 'portrait') {
    return `${guide.label} Live is portrait-first. Switch output to 9:16 before going live.`;
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
