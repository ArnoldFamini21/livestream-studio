import { getJson } from './apiClient.ts';

export const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turns:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceTransportPolicy: 'all',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isIceUrl(value: string): boolean {
  return /^(stun|stuns|turn|turns):[^\s,]+$/i.test(value.trim());
}

function normalizeIceUrls(value: unknown): string[] {
  if (typeof value === 'string') return isIceUrl(value) ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(isIceUrl)
    .slice(0, 16);
}

function normalizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function normalizeIceServer(value: unknown): RTCIceServer | null {
  if (!isRecord(value)) return null;
  const urls = normalizeIceUrls(value.urls);
  if (urls.length === 0) return null;
  const username = normalizeOptionalString(value.username, 256);
  const credential = normalizeOptionalString(value.credential, 512);
  const credentialType = value.credentialType === 'oauth' ? 'oauth' : value.credentialType === 'password' ? 'password' : undefined;
  return {
    urls: urls.length === 1 ? urls[0] : urls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
    ...(credentialType ? { credentialType } : {}),
  };
}

export function normalizeIceConfig(value: unknown): RTCConfiguration | null {
  if (!isRecord(value) || !Array.isArray(value.iceServers)) return null;
  const iceServers = value.iceServers
    .map(normalizeIceServer)
    .filter((server): server is RTCIceServer => Boolean(server))
    .slice(0, 12);
  if (iceServers.length === 0) return null;
  return {
    iceServers,
    iceTransportPolicy: value.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  };
}

export async function fetchIceConfig(): Promise<RTCConfiguration> {
  try {
    const response = await getJson<unknown>('/api/ice-config', { timeoutMs: 5_000 });
    return normalizeIceConfig(response) || DEFAULT_ICE_CONFIG;
  } catch {
    return DEFAULT_ICE_CONFIG;
  }
}
