/**
 * TURN for the werift SFU.
 *
 * On Render the media server runs in a container that accepts only HTTP(S):
 * no inbound UDP reaches it, so the host candidates werift gathers by default
 * are private addresses no browser can use. Allocating a relay on Cloudflare
 * Realtime TURN (free tier) gives the SFU a public candidate; the browser's
 * own candidates (or its relay) then meet it there. Credentials are minted
 * the same way the signaling server mints them for browsers
 * (server/src/services/ice-config.ts), from CLOUDFLARE_TURN_KEY_ID and
 * CLOUDFLARE_TURN_API_TOKEN set on the media server too.
 *
 * Without those variables the SFU keeps its previous behaviour (no ICE
 * servers), and clients fall back to the mesh when it cannot connect.
 */

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
  const requested = cleanString(env.SFU_TURN_TRANSPORT, 8)?.toLowerCase();
  const transport: SfuTurnTransport = requested === 'tcp' || requested === 'tls' ? requested : 'udp';
  return { keyId, apiToken, transport };
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

  const mint = async (turnEnv: SfuTurnEnv): Promise<SfuIceConfig> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnEnv.keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${turnEnv.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: SFU_TURN_TTL_SECONDS }),
          signal: controller.signal,
        }
      );
      if (!response.ok) throw new Error(`Cloudflare TURN returned ${response.status}`);
      const iceServers = parseCloudflareSfuIceServers(await response.json(), turnEnv.transport);
      if (!hasTurnServer(iceServers)) throw new Error('Cloudflare TURN returned no relay servers');
      // Relay only: the container's host candidates are unreachable anyway,
      // and checking them first only delays the pair that works.
      return { iceServers, iceTransportPolicy: 'relay' };
    } finally {
      clearTimeout(timer);
    }
  };

  return async () => {
    const turnEnv = readSfuTurnEnv(env);
    if (!turnEnv) {
      if (!warnedUnset) {
        warnedUnset = true;
        log('[sfu] CLOUDFLARE_TURN_KEY_ID/CLOUDFLARE_TURN_API_TOKEN are not set: the SFU offers host candidates only, and on Render clients stay on the mesh.');
      }
      return null;
    }
    const time = now();
    if (cached && time < cached.refreshAt) return cached.config;
    if (time < retryAt) return cached && time < cached.expiresAt ? cached.config : null;
    if (!inFlight) {
      inFlight = mint(turnEnv)
        .then((config) => {
          const minted = now();
          cached = {
            config,
            refreshAt: minted + (SFU_TURN_TTL_SECONDS * 1000) / 2,
            expiresAt: minted + SFU_TURN_TTL_SECONDS * 1000 - 60_000,
          };
          return config;
        })
        .catch((error: unknown) => {
          retryAt = now() + RETRY_AFTER_FAILURE_MS;
          log(`[sfu] Could not mint TURN credentials: ${error instanceof Error ? error.message : String(error)}`);
          return cached && now() < cached.expiresAt ? cached.config : null;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
