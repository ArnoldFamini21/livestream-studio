import type { StreamDestination } from '@studio/shared';

export const MAX_ENABLED_DESTINATIONS = 3;

export function getDefaultRtmpUrl(platform: StreamDestination['platform']): string {
  switch (platform) {
    case 'youtube': return 'rtmp://a.rtmp.youtube.com/live2';
    case 'facebook': return 'rtmps://live-api-s.facebook.com:443/rtmp/';
    case 'twitch': return 'rtmp://live.twitch.tv/app/';
    case 'linkedin': return 'rtmps://rtmp-api.linkedin.com:443/rtmp/';
    case 'instagram': return 'rtmps://live-upload.instagram.com:443/rtmp/';
    default: return '';
  }
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
