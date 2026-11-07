/**
 * A quick pre-join network check for guests: how fast the studio server
 * answers, whether a direct (peer-to-peer) path looks possible, and whether a
 * relay will be there for networks that block direct connections.
 */

import { buildApiUrl, getJson } from './apiClient.ts';

export type ConnectionCheckLevel = 'good' | 'warning' | 'bad';

export interface ConnectionCheckItem {
  id: 'server' | 'direct' | 'relay';
  label: string;
  level: ConnectionCheckLevel;
  detail: string;
}

export interface ConnectionCheckResult {
  level: ConnectionCheckLevel;
  summary: string;
  items: ConnectionCheckItem[];
  serverRttMs: number | null;
}

export interface CandidateGatherResult {
  host: boolean;
  srflx: boolean;
  relay: boolean;
}

interface IceConfigResponse {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  relayConfigured?: boolean;
  membershipRequiredForTurn?: boolean;
  status?: { turnReady?: boolean; hasTurn?: boolean };
}

export interface ConnectionCheckDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  healthUrl?: string;
  loadIceConfig?: () => Promise<IceConfigResponse>;
  gatherCandidates?: (config: RTCConfiguration, timeoutMs: number) => Promise<CandidateGatherResult>;
  samples?: number;
  gatherTimeoutMs?: number;
}

const HEALTH_TIMEOUT_MS = 8_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Median round trip to the studio server's /health, or null when it never answered. */
export async function measureServerRtt(deps: ConnectionCheckDeps = {}): Promise<number | null> {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || (() => performance.now());
  const url = deps.healthUrl || buildApiUrl('/health');
  const samples: number[] = [];
  for (let index = 0; index < (deps.samples ?? 3); index++) {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const startedAt = now();
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
      if (response.ok) samples.push(Math.max(0, Math.round(now() - startedAt)));
    } catch {
      // A lost sample counts as no answer.
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  return samples.length > 0 ? median(samples) : null;
}

export function rateServerRtt(rttMs: number | null): ConnectionCheckLevel {
  if (rttMs === null) return 'bad';
  if (rttMs <= 300) return 'good';
  if (rttMs <= 800) return 'warning';
  return 'bad';
}

/** Gather ICE candidates for a moment and report which kinds appeared. */
export function gatherCandidateTypes(config: RTCConfiguration, timeoutMs: number): Promise<CandidateGatherResult> {
  return new Promise((resolve) => {
    const result: CandidateGatherResult = { host: false, srflx: false, relay: false };
    if (typeof RTCPeerConnection === 'undefined') {
      resolve(result);
      return;
    }
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection(config);
    } catch {
      resolve(result);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      try { pc.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = globalThis.setTimeout(finish, timeoutMs);
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        finish();
        return;
      }
      const type = event.candidate.type || /\btyp (\w+)/.exec(event.candidate.candidate)?.[1];
      if (type === 'host') result.host = true;
      else if (type === 'srflx' || type === 'prflx') result.srflx = true;
      else if (type === 'relay') result.relay = true;
    };
    pc.createDataChannel('connection-check');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(finish);
  });
}

export function buildConnectionCheckResult(
  serverRttMs: number | null,
  candidates: CandidateGatherResult,
  relay: { configured: boolean; verified: boolean }
): ConnectionCheckResult {
  const serverLevel = rateServerRtt(serverRttMs);
  const items: ConnectionCheckItem[] = [
    {
      id: 'server',
      label: 'Studio server',
      level: serverLevel,
      detail: serverRttMs === null
        ? 'The studio server did not answer. It may still be waking up; try again in a minute.'
        : `${serverRttMs} ms round trip${serverLevel === 'good' ? '' : serverLevel === 'warning' ? ' (a little slow, still fine for joining)' : ' (slow; video may lag)'}.`,
    },
    {
      id: 'direct',
      label: 'Direct connection',
      level: candidates.srflx ? 'good' : candidates.host ? 'warning' : 'bad',
      detail: candidates.srflx
        ? 'Your network allows direct video connections.'
        : candidates.host
          ? 'Your network blocks direct connections (common on office or hotel Wi-Fi). The studio will use a relay.'
          : 'Your browser could not open a video connection. Check a VPN or firewall.',
    },
    {
      id: 'relay',
      label: 'Relay server',
      level: relay.verified || relay.configured ? 'good' : candidates.srflx ? 'warning' : 'bad',
      detail: relay.verified
        ? 'A relay server answered, so strict networks can still connect.'
        : relay.configured
          ? 'A relay server is ready for you once you join.'
          : 'No relay server is set up; strict networks may fail to connect.',
    },
  ];
  const order: ConnectionCheckLevel[] = ['good', 'warning', 'bad'];
  const level = items.reduce<ConnectionCheckLevel>((worst, item) => (
    order.indexOf(item.level) > order.indexOf(worst) ? item.level : worst
  ), 'good');
  const summary = level === 'good'
    ? 'Your connection looks good.'
    : level === 'warning'
      ? 'Your connection should work. Details below.'
      : 'There may be a problem with your connection.';
  return { level, summary, items, serverRttMs };
}

export async function runConnectionCheck(deps: ConnectionCheckDeps = {}): Promise<ConnectionCheckResult> {
  const loadIceConfig = deps.loadIceConfig || (() => getJson<IceConfigResponse>('/api/ice-config', { timeoutMs: HEALTH_TIMEOUT_MS }));
  const gather = deps.gatherCandidates || gatherCandidateTypes;
  const [serverRttMs, iceConfig] = await Promise.all([
    measureServerRtt(deps),
    loadIceConfig().catch(() => null),
  ]);
  const iceServers = iceConfig?.iceServers?.length
    ? iceConfig.iceServers
    : [{ urls: 'stun:stun.l.google.com:19302' }];
  const candidates = await gather({ iceServers, iceTransportPolicy: 'all' }, deps.gatherTimeoutMs ?? 4_000);
  const configured = Boolean(iceConfig?.relayConfigured || iceConfig?.status?.turnReady || iceConfig?.status?.hasTurn);
  return buildConnectionCheckResult(serverRttMs, candidates, { configured, verified: candidates.relay });
}
