import { createHmac } from 'node:crypto';

export interface StudioIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: 'password' | 'oauth';
}

export const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 86_400;
const MIN_TURN_CREDENTIAL_TTL_SECONDS = 60;
const MAX_TURN_CREDENTIAL_TTL_SECONDS = 7 * 86_400;

export interface TurnRestCredential {
  username: string;
  credential: string;
  expiresAtSeconds: number;
}

function sanitizeTurnUserId(value: string | undefined): string {
  if (!value) return 'studio';
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'studio';
}

export function clampTurnCredentialTtlSeconds(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_TURN_CREDENTIAL_TTL_SECONDS;
  return Math.min(MAX_TURN_CREDENTIAL_TTL_SECONDS, Math.max(MIN_TURN_CREDENTIAL_TTL_SECONDS, Math.floor(numeric)));
}

/**
 * Generate short-lived TURN credentials using the coturn `use-auth-secret`
 * (TURN REST API) scheme: username is `<expiry-unix>:<userId>` and the
 * credential is the base64 HMAC-SHA1 of that username keyed by the shared secret.
 */
export function generateTurnRestCredential(
  secret: string,
  options: { ttlSeconds?: number; userId?: string; nowSeconds?: number } = {}
): TurnRestCredential {
  const ttlSeconds = clampTurnCredentialTtlSeconds(options.ttlSeconds ?? DEFAULT_TURN_CREDENTIAL_TTL_SECONDS);
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? Math.floor(options.nowSeconds as number)
    : Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + ttlSeconds;
  const userId = sanitizeTurnUserId(options.userId);
  const username = `${expiresAtSeconds}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAtSeconds };
}

export interface StudioIceConfig {
  iceServers: StudioIceServer[];
  iceTransportPolicy: 'all' | 'relay';
}

export type StudioIceConfigSource = 'ice_servers_json' | 'turn_rest_secret' | 'split_env' | 'default';

export interface StudioIceConfigStatus {
  source: StudioIceConfigSource;
  serverCount: number;
  stunServerCount: number;
  turnServerCount: number;
  hasTurn: boolean;
  hasConfiguredTurn: boolean;
  usingFallbackTurn: boolean;
  turnReady: boolean;
  iceTransportPolicy: 'all' | 'relay';
}

export interface StudioIceConfigWithStatus extends StudioIceConfig {
  status: StudioIceConfigStatus;
}

const DEFAULT_ICE_SERVERS: StudioIceServer[] = [
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
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isIceUrl(value: string): boolean {
  return /^(stun|stuns|turn|turns):[^\s,]+$/i.test(value.trim());
}

function normalizeUrlList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(isIceUrl)
      .slice(0, 16);
  }
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

export function normalizeIceServer(value: unknown): StudioIceServer | null {
  if (!isRecord(value)) return null;
  const urls = normalizeUrlList(value.urls);
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

function normalizeIceServers(value: unknown): StudioIceServer[] {
  if (!Array.isArray(value)) return [];
  const servers = value
    .map(normalizeIceServer)
    .filter((server): server is StudioIceServer => Boolean(server));
  return servers.slice(0, 12);
}

function normalizePolicy(value: unknown): 'all' | 'relay' {
  return value === 'relay' ? 'relay' : 'all';
}

function getServerUrls(server: StudioIceServer): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

function hasUrlScheme(server: StudioIceServer, schemes: string[]): boolean {
  return getServerUrls(server).some((url) => {
    const normalized = url.trim().toLowerCase();
    return schemes.some((scheme) => normalized.startsWith(`${scheme}:`));
  });
}

function hasTurnCredentials(server: StudioIceServer): boolean {
  return Boolean(server.username && server.credential);
}

function buildIceConfigStatus(
  config: StudioIceConfig,
  source: StudioIceConfigSource
): StudioIceConfigStatus {
  const stunServerCount = config.iceServers.filter((server) => hasUrlScheme(server, ['stun', 'stuns'])).length;
  const turnServers = config.iceServers.filter((server) => hasUrlScheme(server, ['turn', 'turns']));
  const hasConfiguredTurn = source !== 'default' && turnServers.some(hasTurnCredentials);

  return {
    source,
    serverCount: config.iceServers.length,
    stunServerCount,
    turnServerCount: turnServers.length,
    hasTurn: turnServers.length > 0,
    hasConfiguredTurn,
    usingFallbackTurn: source === 'default' && turnServers.length > 0,
    turnReady: hasConfiguredTurn,
    iceTransportPolicy: config.iceTransportPolicy,
  };
}

function withStatus(config: StudioIceConfig, source: StudioIceConfigSource): StudioIceConfigWithStatus {
  return {
    ...config,
    status: buildIceConfigStatus(config, source),
  };
}

function parseJsonConfig(value: string | undefined): StudioIceConfig | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    const source = Array.isArray(parsed) ? { iceServers: parsed } : parsed;
    if (!isRecord(source)) return null;
    const iceServers = normalizeIceServers(source.iceServers);
    if (iceServers.length === 0) return null;
    return {
      iceServers,
      iceTransportPolicy: normalizePolicy(source.iceTransportPolicy),
    };
  } catch {
    return null;
  }
}

export interface BuildIceConfigOptions {
  userId?: string;
  nowSeconds?: number;
}

export function buildIceConfigWithStatusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: BuildIceConfigOptions = {}
): StudioIceConfigWithStatus {
  const jsonConfig = parseJsonConfig(env.ICE_SERVERS_JSON);
  if (jsonConfig) return withStatus(jsonConfig, 'ice_servers_json');

  const stunUrls = normalizeUrlList(env.STUN_URLS);
  const turnUrls = normalizeUrlList(env.TURN_URLS);

  // Preferred production path: mint short-lived TURN credentials from a shared
  // secret (coturn use-auth-secret / TURN REST API) so no static password ships.
  const turnAuthSecret = normalizeOptionalString(env.TURN_STATIC_AUTH_SECRET, 512);
  if (turnUrls.length > 0 && turnAuthSecret) {
    const { username, credential } = generateTurnRestCredential(turnAuthSecret, {
      ttlSeconds: clampTurnCredentialTtlSeconds(env.TURN_CREDENTIAL_TTL_SECONDS),
      userId: options.userId,
      nowSeconds: options.nowSeconds,
    });
    const iceServers: StudioIceServer[] = [];
    if (stunUrls.length > 0) {
      iceServers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls });
    }
    iceServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username,
      credential,
      credentialType: 'password',
    });
    return withStatus(
      { iceServers, iceTransportPolicy: normalizePolicy(env.ICE_TRANSPORT_POLICY) },
      'turn_rest_secret'
    );
  }
  const turnUsername = normalizeOptionalString(env.TURN_USERNAME, 256);
  const turnCredential = normalizeOptionalString(env.TURN_CREDENTIAL, 512);
  const turnCredentialType = env.TURN_CREDENTIAL_TYPE === 'oauth' ? 'oauth' : env.TURN_CREDENTIAL_TYPE === 'password' ? 'password' : undefined;
  const configuredServers: StudioIceServer[] = [];

  if (stunUrls.length > 0) {
    configuredServers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls });
  }

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    configuredServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: turnUsername,
      credential: turnCredential,
      ...(turnCredentialType ? { credentialType: turnCredentialType } : {}),
    });
  }

  const config = {
    iceServers: configuredServers.length > 0 ? configuredServers : DEFAULT_ICE_SERVERS,
    iceTransportPolicy: normalizePolicy(env.ICE_TRANSPORT_POLICY),
  };
  return withStatus(config, configuredServers.length > 0 ? 'split_env' : 'default');
}

export function buildIceConfigStatusFromEnv(env: NodeJS.ProcessEnv = process.env): StudioIceConfigStatus {
  return buildIceConfigWithStatusFromEnv(env).status;
}

export function buildIceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: BuildIceConfigOptions = {}
): StudioIceConfig {
  const { status: _status, ...config } = buildIceConfigWithStatusFromEnv(env, options);
  return config;
}
