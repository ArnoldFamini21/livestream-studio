import { getJson } from './apiClient.ts';

export type ClientIceConfigSource = 'ice_servers_json' | 'split_env' | 'default' | 'unknown';

export interface ClientIceConfigStatus {
  source: ClientIceConfigSource;
  serverCount: number;
  stunServerCount: number;
  turnServerCount: number;
  hasTurn: boolean;
  hasConfiguredTurn: boolean;
  usingFallbackTurn: boolean;
  turnReady: boolean;
  iceTransportPolicy: 'all' | 'relay';
}

export interface ClientIceConfigWithStatus {
  config: RTCConfiguration;
  status: ClientIceConfigStatus;
}

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

export const DEFAULT_ICE_CONFIG_STATUS: ClientIceConfigStatus = {
  source: 'default',
  serverCount: 4,
  stunServerCount: 2,
  turnServerCount: 2,
  hasTurn: true,
  hasConfiguredTurn: false,
  usingFallbackTurn: true,
  turnReady: false,
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

function getServerUrls(server: RTCIceServer): string[] {
  if (!server.urls) return [];
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

function hasUrlScheme(server: RTCIceServer, schemes: string[]): boolean {
  return getServerUrls(server).some((url) => {
    const normalized = String(url).trim().toLowerCase();
    return schemes.some((scheme) => normalized.startsWith(`${scheme}:`));
  });
}

function hasTurnCredentials(server: RTCIceServer): boolean {
  return Boolean(server.username && server.credential);
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function buildDerivedIceConfigStatus(config: RTCConfiguration): ClientIceConfigStatus {
  const iceServers = config.iceServers || [];
  const stunServerCount = iceServers.filter((server) => hasUrlScheme(server, ['stun', 'stuns'])).length;
  const turnServers = iceServers.filter((server) => hasUrlScheme(server, ['turn', 'turns']));

  return {
    source: 'unknown',
    serverCount: iceServers.length,
    stunServerCount,
    turnServerCount: turnServers.length,
    hasTurn: turnServers.length > 0,
    hasConfiguredTurn: turnServers.some(hasTurnCredentials),
    usingFallbackTurn: false,
    turnReady: false,
    iceTransportPolicy: config.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  };
}

function normalizeIceConfigStatus(value: unknown, config: RTCConfiguration): ClientIceConfigStatus | null {
  if (!isRecord(value)) return null;
  const derived = buildDerivedIceConfigStatus(config);
  const source = value.source === 'ice_servers_json' || value.source === 'split_env' || value.source === 'default'
    ? value.source
    : 'unknown';
  const serverCount = normalizeNonNegativeInteger(value.serverCount) ?? derived.serverCount;
  const stunServerCount = normalizeNonNegativeInteger(value.stunServerCount) ?? derived.stunServerCount;
  const turnServerCount = normalizeNonNegativeInteger(value.turnServerCount) ?? derived.turnServerCount;
  const hasTurn = normalizeBoolean(value.hasTurn) ?? turnServerCount > 0;
  const hasConfiguredTurn = normalizeBoolean(value.hasConfiguredTurn) ?? false;
  const usingFallbackTurn = normalizeBoolean(value.usingFallbackTurn) ?? source === 'default';
  const turnReady = normalizeBoolean(value.turnReady) ?? false;
  const iceTransportPolicy = value.iceTransportPolicy === 'relay' ? 'relay' : 'all';

  return {
    source,
    serverCount,
    stunServerCount,
    turnServerCount,
    hasTurn,
    hasConfiguredTurn,
    usingFallbackTurn,
    turnReady: turnReady && hasConfiguredTurn && hasTurn && !usingFallbackTurn,
    iceTransportPolicy,
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

export function normalizeIceConfigWithStatus(value: unknown): ClientIceConfigWithStatus | null {
  const config = normalizeIceConfig(value);
  if (!config) return null;
  const status = isRecord(value)
    ? normalizeIceConfigStatus(value.status, config) || buildDerivedIceConfigStatus(config)
    : buildDerivedIceConfigStatus(config);
  return { config, status };
}

export async function fetchIceConfigWithStatus(): Promise<ClientIceConfigWithStatus> {
  try {
    const response = await getJson<unknown>('/api/ice-config', { timeoutMs: 5_000 });
    return normalizeIceConfigWithStatus(response) || {
      config: DEFAULT_ICE_CONFIG,
      status: DEFAULT_ICE_CONFIG_STATUS,
    };
  } catch {
    return {
      config: DEFAULT_ICE_CONFIG,
      status: DEFAULT_ICE_CONFIG_STATUS,
    };
  }
}

export async function fetchIceConfig(): Promise<RTCConfiguration> {
  const { config } = await fetchIceConfigWithStatus();
  return config;
}
