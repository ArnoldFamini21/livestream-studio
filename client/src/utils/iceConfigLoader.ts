import {
  DEFAULT_ICE_CONFIG,
  DEFAULT_ICE_CONFIG_STATUS,
  tryFetchIceConfigWithStatus,
  type ClientIceConfigWithStatus,
} from './iceConfig.ts';

/**
 * One shared, retrying source of STUN/TURN configuration for every peer
 * connection in the page (mesh peers, the SFU transport, recording transfers,
 * and the session health card).
 *
 * The studio server sleeps on the free tier and can take ~50 s to answer the
 * first request after a wake-up. A single request with a short timeout left the
 * whole session on STUN only, so guests behind strict NATs never connected.
 * Instead: hand out the STUN-only fallback right away if the first attempt
 * fails (so calls can start), keep retrying with backoff, and tell subscribers
 * when real relay servers arrive so they can apply them (setConfiguration plus
 * an ICE restart).
 */

export interface IceConfigLoaderOptions {
  fetchConfig?: () => Promise<ClientIceConfigWithStatus>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Refetch after this long so TURN credentials stay fresh for later connections. */
  maxAgeMs?: number;
  /** Give up retrying after this many failed attempts in a row. */
  maxAttempts?: number;
}

export type IceConfigListener = (value: ClientIceConfigWithStatus) => void;

/** 2 s, 4 s, 8 s ... capped at a minute. */
export function getIceConfigRetryDelayMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}

const FALLBACK: ClientIceConfigWithStatus = { config: DEFAULT_ICE_CONFIG, status: DEFAULT_ICE_CONFIG_STATUS };

export class IceConfigLoader {
  private latestValue: ClientIceConfigWithStatus = FALLBACK;
  private fetchedAt = 0;
  private hasLoaded = false;
  private running: Promise<void> | null = null;
  private firstResult: Promise<ClientIceConfigWithStatus> | null = null;
  private resolveFirst: ((value: ClientIceConfigWithStatus) => void) | null = null;
  private readonly listeners = new Set<IceConfigListener>();
  private readonly fetchConfig: () => Promise<ClientIceConfigWithStatus>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly maxAttempts: number;

  constructor(options: IceConfigLoaderOptions = {}) {
    this.fetchConfig = options.fetchConfig ?? (() => tryFetchIceConfigWithStatus());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 40;
  }

  /** The best configuration known right now (the STUN-only fallback until the server answers). */
  get latest(): ClientIceConfigWithStatus {
    return this.latestValue;
  }

  /** Whether the server has answered at least once. */
  get loaded(): boolean {
    return this.hasLoaded;
  }

  /**
   * Resolves with the server's configuration, or with the fallback as soon as
   * the first attempt fails; loading continues in the background either way.
   */
  ready(): Promise<ClientIceConfigWithStatus> {
    if (!this.firstResult) {
      this.firstResult = new Promise((resolve) => { this.resolveFirst = resolve; });
    }
    this.start();
    return this.firstResult;
  }

  /** Refetch in the background when the configuration is old (TURN credentials expire). */
  refreshIfStale(): void {
    if (this.loaded && this.now() - this.fetchedAt > this.maxAgeMs) this.start(true);
  }

  subscribe(listener: IceConfigListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private start(force = false) {
    if (this.running) return;
    if (this.loaded && !force) return;
    this.running = this.run().finally(() => { this.running = null; });
  }

  private settleFirst(value: ClientIceConfigWithStatus) {
    const resolve = this.resolveFirst;
    this.resolveFirst = null;
    resolve?.(value);
  }

  private async run(): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const value = await this.fetchConfig();
        this.latestValue = value;
        this.fetchedAt = this.now();
        this.hasLoaded = true;
        this.settleFirst(value);
        for (const listener of this.listeners) {
          try { listener(value); } catch (err) { console.warn('ICE configuration listener failed:', err); }
        }
        return;
      } catch (err) {
        if (attempt === 0) console.warn('Relay (TURN) configuration unavailable; retrying in the background:', err instanceof Error ? err.message : err);
        // Calls may start on what we have; better relays are applied when they arrive.
        this.settleFirst(this.latestValue);
        await this.sleep(getIceConfigRetryDelayMs(attempt));
      }
    }
  }
}

let shared: IceConfigLoader | null = null;

/** The page-wide loader. */
export function getSharedIceConfigLoader(): IceConfigLoader {
  shared ??= new IceConfigLoader();
  return shared;
}

/** Configuration for a connection about to be created: waits for the first answer (or first failure). */
export async function getSharedIceConfiguration(): Promise<RTCConfiguration> {
  const loader = getSharedIceConfigLoader();
  loader.refreshIfStale();
  await loader.ready();
  return loader.latest.config;
}
