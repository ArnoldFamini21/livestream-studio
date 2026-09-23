/**
 * Production readiness: the signaling server runs without Postgres, TURN, or a
 * token secret so local development stays easy, but in production each of
 * those silently degrades the studio (lost rooms on restart, guests behind
 * strict NATs who cannot connect, media tokens that cannot be signed). This
 * module names each gap so `/health` shows it, and `PRODUCTION_STRICT=true`
 * refuses to start until the blocking ones are fixed.
 */

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const TOKEN_SECRET_MIN_LENGTH = 32;

export type ReadinessSeverity = 'blocking' | 'warning';

export interface ReadinessIssue {
  id: string;
  severity: ReadinessSeverity;
  message: string;
}

export interface ProductionReadiness {
  production: boolean;
  strict: boolean;
  ready: boolean;
  issues: ReadinessIssue[];
}

export interface ReadinessRuntimeState {
  /** Stores that were configured but failed to initialize and fell back to memory. */
  persistenceFallbacks?: string[];
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

export function isStrictProductionMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.PRODUCTION_STRICT);
}

export function buildProductionReadiness(
  env: NodeJS.ProcessEnv,
  status: { turnReady: boolean },
  runtime: ReadinessRuntimeState = {}
): ProductionReadiness {
  const production = env.NODE_ENV === 'production';
  const strict = isStrictProductionMode(env);
  const issues: ReadinessIssue[] = [];

  if (!DATABASE_URL_KEYS.some((key) => env[key]?.trim())) {
    issues.push({
      id: 'database-missing',
      severity: 'blocking',
      message: 'No DATABASE_URL: accounts, rooms, and recording catalogs live in memory and are lost on every restart.',
    });
  }
  for (const store of runtime.persistenceFallbacks || []) {
    issues.push({
      id: `database-fallback-${store.trim().toLowerCase().replace(/\s+/g, '-')}`,
      severity: 'blocking',
      message: `The ${store} store could not reach Postgres and is running in memory.`,
    });
  }

  const secret = env.LIVE_STREAM_TOKEN_SECRET || '';
  if (secret.length < TOKEN_SECRET_MIN_LENGTH) {
    issues.push({
      id: 'token-secret-missing',
      severity: 'blocking',
      message: `LIVE_STREAM_TOKEN_SECRET must be at least ${TOKEN_SECRET_MIN_LENGTH} characters; streaming and recording uploads cannot be authorized without it.`,
    });
  }

  if (!status.turnReady) {
    issues.push({
      id: 'turn-missing',
      severity: 'blocking',
      message: 'No TURN server is configured; guests on corporate or mobile networks may fail to connect.',
    });
  }

  if (!env.CLIENT_URL?.trim() && !env.CLIENT_URLS?.trim()) {
    issues.push({
      id: 'client-url-missing',
      severity: 'warning',
      message: 'CLIENT_URL is not set; only the built-in studio origins may connect.',
    });
  }

  if (!env.YOUTUBE_API_KEY?.trim()) {
    issues.push({
      id: 'youtube-chat-disabled',
      severity: 'warning',
      message: 'YOUTUBE_API_KEY is not set; YouTube live chat cannot be shown in the unified chat.',
    });
  }

  return {
    production,
    strict,
    ready: !issues.some((issue) => issue.severity === 'blocking'),
    issues,
  };
}

/**
 * Strict mode only applies in production: it turns blocking issues into a
 * startup failure so a misconfigured deploy never receives traffic.
 */
export function getStrictStartupFailure(readiness: ProductionReadiness): string | null {
  if (!readiness.production || !readiness.strict || readiness.ready) return null;
  const blocking = readiness.issues.filter((issue) => issue.severity === 'blocking');
  return [
    'PRODUCTION_STRICT is enabled and the server is not production-ready:',
    ...blocking.map((issue) => `- ${issue.message}`),
  ].join('\n');
}
