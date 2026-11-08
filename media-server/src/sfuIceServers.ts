/**
 * TURN for the werift SFU.
 *
 * On Render the media server runs in a container that accepts only HTTP(S):
 * no inbound UDP reaches it, so the host candidates werift gathers by default
 * are private addresses no browser can use. Allocating a relay on Cloudflare
 * Realtime TURN (free tier) gives the SFU a public candidate; the browser's
 * own candidates (or its relay) then meet it there. Credentials are minted
 * the same way the signaling server mints them for browsers
 * (server/src/services/ice-config.ts).
 *
 * Two sources, in order:
 * 1. CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN set on the media
 *    server: it asks Cloudflare directly.
 * 2. Otherwise it asks the signaling server (SIGNALING_SERVER_URL, by default
 *    the production Render URL), which holds the Cloudflare key, signing the
 *    request with the LIVE_STREAM_TOKEN_SECRET both services already share
 *    (see server/src/services/internalTurn.ts). No extra secret to copy.
 *
 * If neither works the SFU keeps its previous behaviour (no ICE servers),
 * and clients fall back to the mesh when it cannot connect.
 */

import { createHmac } from 'node:crypto';

export interface SfuIceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface SfuIceConfig {
  iceServers: SfuIceServer[];
  iceTransportPolicy: 'all' | 'relay';
}

export type SfuTurnTransport = 'udp' | 'tcp' | 'tls';

export interface SfuTurnEnv {
  keyId: string;
  apiToken: string;
  transport: SfuTurnTransport;
}

export const SFU_TURN_TTL_SECONDS = 86_400;
const FETCH_TIMEOUT_MS = 5_000;
/** The signaling server may itself be waiting on Cloudflare. */
const SIGNALING_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_SIGNALING_SERVER_URL = 'https://livestream-studio-server.onrender.com';
export const INTERNAL_TURN_PATH = '/internal/sfu-turn-credentials';
/** After a failed mint, wait this long before asking Cloudflare again. */
const RETRY_AFTER_FAILURE_MS = 30_000;

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

export function readSfuTurnEnv(env: NodeJS.ProcessEnv = process.env): SfuTurnEnv | null {
  const keyId = cleanString(env.CLOUDFLARE_TURN_KEY_ID, 128);
  const apiToken = cleanString(env.CLOUDFLARE_TURN_API_TOKEN, 512);
  if (!keyId || !apiToken) return null;
  return { keyId, apiToken, transport: readTransport(env) };
}

function readTransport(env: NodeJS.ProcessEnv): SfuTurnTransport {
  const requested = cleanString(env.SFU_TURN_TRANSPORT, 8)?.toLowerCase();
  return requested === 'tcp' || requested === 'tls' ? requested : 'udp';
}

export interface SfuSignalingTurnSource {
  endpoint: string;
  secret: string;
  transport: SfuTurnTransport;
}

/**
 * Where to ask for TURN when the media server has no Cloudflare key of its
 * own. Needs the shared LIVE_STREAM_TOKEN_SECRET (32+ characters; a fixed
 * dev secret outside production, matching auth.ts and the server).
 */
export function readSfuSignalingTurnSource(env: NodeJS.ProcessEnv = process.env): SfuSignalingTurnSource | null {
  const production = env.NODE_ENV === 'production';
  const configuredSecret = env.LIVE_STREAM_TOKEN_SECRET;
  const secret = configuredSecret && configuredSecret.length >= 32
    ? configuredSecret
    : production ? null : 'development-live-stream-token-secret';
  if (!secret) return null;
  const rawUrl = cleanString(env.SIGNALING_SERVER_URL, 512) ?? (production ? DEFAULT_SIGNALING_SERVER_URL : undefined);
  if (!rawUrl || rawUrl.toLowerCase() === 'off') return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  // The answer carries relay credentials: HTTPS only, except to a local dev server.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return { endpoint: `${url.origin}${INTERNAL_TURN_PATH}`, secret, transport: readTransport(env) };
}

export function signInternalTurnRequest(secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(`studio-sfu-turn:v1:${timestampSeconds}`).digest('base64url');
  return `${timestampSeconds}.${signature}`;
}

function urlTransport(url: string): SfuTurnTransport | 'stun' | null {
  const match = /^(stuns?|turns?):([^?\s]+)(?:\?(.*))?$/i.exec(url.trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (scheme.startsWith('stun')) return 'stun';
  const transport = new URLSearchParams(match[3] || '').get('transport');
  if (scheme === 'turns') return transport === 'udp' ? null : 'tls';
  if (transport === 'tcp') return 'tcp';
  if (transport === null || transport === 'udp') return 'udp';
  return null;
}

/**
 * Flatten Cloudflare's answer into one URL per entry, port 53 dropped (it is
 * often filtered and only slows gathering), the preferred TURN transport
 * first. werift allocates on the first TURN URL only, so order matters.
 */
export function parseCloudflareSfuIceServers(body: unknown, preferred: SfuTurnTransport = 'udp'): SfuIceServer[] {
  if (!body || typeof body !== 'object') return [];
  const raw = (body as { iceServers?: unknown }).iceServers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const entries: Array<SfuIceServer & { transport: SfuTurnTransport | 'stun' }> = [];
  for (const server of list) {
    if (!server || typeof server !== 'object') continue;
    const record = server as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = Array.isArray(record.urls) ? record.urls : [record.urls];
    const username = cleanString(record.username, 256);
    const credential = cleanString(record.credential, 512);
    for (const url of urls) {
      if (typeof url !== 'string' || /:53(\?|$)/.test(url)) continue;
      const transport = urlTransport(url);
      if (!transport) continue;
      if (transport !== 'stun' && (!username || !credential)) continue;
      entries.push({
        urls: url.trim(),
        ...(transport !== 'stun' && username ? { username } : {}),
        ...(transport !== 'stun' && credential ? { credential } : {}),
        transport,
      });
    }
  }
  const rank = (transport: SfuTurnTransport | 'stun') => (transport === preferred ? 0 : transport === 'stun' ? 3 : transport === 'udp' ? 1 : 2);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.transport) - rank(b.entry.transport) || a.index - b.index)
    .map(({ entry: { transport: _transport, ...server } }) => server);
}

export function hasTurnServer(servers: SfuIceServer[]): boolean {
  return servers.some((server) => /^turns?:/i.test(server.urls) && server.username && server.credential);
}

export interface SfuIceConfigProviderOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export type SfuIceConfigProvider = () => Promise<SfuIceConfig | null>;

/**
 * Returns the werift ICE config, or null when no TURN is configured or it
 * cannot be minted right now. Credentials are shared by every SFU peer
 * connection and refreshed at half their lifetime; a failed refresh keeps
 * using the old ones while they are still valid.
 */
export function createSfuIceConfigProvider(options: SfuIceConfigProviderOptions = {}): SfuIceConfigProvider {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  let cached: { config: SfuIceConfig; refreshAt: number; expiresAt: number } | null = null;
  let retryAt = 0;
  let inFlight: Promise<SfuIceConfig | null> | null = null;
  let warnedUnset = false;

  const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const toConfig = (body: unknown, transport: SfuTurnTransport, from: string): SfuIceConfig => {
    const iceServers = parseCloudflareSfuIceServers(body, transport);
    if (!hasTurnServer(iceServers)) throw new Error(`${from} returned no relay servers`);
    // Relay only: the container's host candidates are unreachable anyway,
    // and checking them first only delays the pair that works.
    return { iceServers, iceTransportPolicy: 'relay' };
  };

  const mintFromCloudflare = async (turnEnv: SfuTurnEnv): Promise<{ config: SfuIceConfig; ttlSeconds: number }> => {
    const response = await fetchWithTimeout(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnEnv.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${turnEnv.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: SFU_TURN_TTL_SECONDS }),
      },
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`Cloudflare TURN returned ${response.status}`);
    return { config: toConfig(await response.json(), turnEnv.transport, 'Cloudflare TURN'), ttlSeconds: SFU_TURN_TTL_SECONDS };
  };

  const mintFromSignaling = async (source: SfuSignalingTurnSource): Promise<{ config: SfuIceConfig; ttlSeconds: number }> => {
    const response = await fetchWithTimeout(
      source.endpoint,
      {
        method: 'POST',
        headers: { 'X-Studio-Internal-Signature': signInternalTurnRequest(source.secret, Math.floor(now() / 1000)) },
        redirect: 'error',
      },
      SIGNALING_FETCH_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`the signaling server returned ${response.status}`);
    const body = (await response.json()) as { ttlSeconds?: unknown };
    const ttl = typeof body?.ttlSeconds === 'number' && Number.isFinite(body.ttlSeconds) ? body.ttlSeconds : SFU_TURN_TTL_SECONDS;
    const ttlSeconds = Math.min(SFU_TURN_TTL_SECONDS, Math.max(600, Math.floor(ttl)));
    return { config: toConfig(body, source.transport, 'the signaling server'), ttlSeconds };
  };

  return async () => {
    const turnEnv = readSfuTurnEnv(env);
    const signalingSource = turnEnv ? null : readSfuSignalingTurnSource(env);
    if (!turnEnv && !signalingSource) {
      if (!warnedUnset) {
        warnedUnset = true;
        log('[sfu] No TURN source: set CLOUDFLARE_TURN_KEY_ID/CLOUDFLARE_TURN_API_TOKEN, or LIVE_STREAM_TOKEN_SECRET (and SIGNALING_SERVER_URL outside production). The SFU offers host candidates only, and on Render clients stay on the mesh.');
      }
      return null;
    }
    const time = now();
    if (cached && time < cached.refreshAt) return cached.config;
    if (time < retryAt) return cached && time < cached.expiresAt ? cached.config : null;
    if (!inFlight) {
      const minting = turnEnv ? mintFromCloudflare(turnEnv) : mintFromSignaling(signalingSource!);
      inFlight = minting
        .then(({ config, ttlSeconds }) => {
          const minted = now();
          cached = {
            config,
            refreshAt: minted + (ttlSeconds * 1000) / 2,
            expiresAt: minted + ttlSeconds * 1000 - 60_000,
          };
          return config;
        })
        .catch((error: unknown) => {
          retryAt = now() + RETRY_AFTER_FAILURE_MS;
          log(`[sfu] Could not get TURN credentials from ${turnEnv ? 'Cloudflare' : 'the signaling server'}: ${error instanceof Error ? error.message : String(error)}`);
          return cached && now() < cached.expiresAt ? cached.config : null;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
