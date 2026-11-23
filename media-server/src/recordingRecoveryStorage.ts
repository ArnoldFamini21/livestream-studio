import { createHash, randomUUID } from 'node:crypto';
import { RECORDING_RECOVERY_CHUNK_BYTES, RECORDING_RECOVERY_SHA256 } from '@studio/shared';
import { getRecordingObjectStorageConfig, signObjectStorageRequest, type ObjectStorageConfig } from './objectStorage.js';

const METADATA_MAX_BYTES = 256 * 1024;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const VERSION_PATTERN = /^"[A-Za-z0-9+/=_-]{1,180}"$/;
const PRIVATE_PROBE = 'studio-private-recording-recovery-v1';

function configuredRecoveryStorage(env: NodeJS.ProcessEnv) {
  const config = getRecordingObjectStorageConfig(env);
  if (env.RECORDING_RECOVERY_ENABLED !== 'true' || !config || config.publicBaseUrl) return null;
  try {
    const endpoint = new URL(config.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    if (endpoint.protocol !== 'https:' && (endpoint.protocol !== 'http:' || env.NODE_ENV === 'production')) return null;
    return config;
  } catch {
    return null;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('Private storage returned no object body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, bytes);
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('Private storage object exceeds its expected size');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface RecoveryObjectVersion<T> {
  value: T;
  version: string;
}

export interface RecoveryChunkReceipt {
  offset: number;
  bytes: number;
  sha256: string;
}

function readChunkReceipt(headers: Headers): RecoveryChunkReceipt {
  const bytes = Number(headers.get('content-length'));
  const offsetValue = headers.get('x-amz-meta-recording-offset');
  const offset = Number(offsetValue);
  const sha256 = headers.get('x-amz-meta-recording-sha256') ?? '';
  if (!offsetValue || !/^\d+$/.test(offsetValue) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > RECORDING_RECOVERY_CHUNK_BYTES ||
      !RECORDING_RECOVERY_SHA256.test(sha256)) {
    throw new Error('Private storage returned an invalid recording receipt');
  }
  return { offset, bytes, sha256 };
}

export class RecordingRecoveryStorage {
  constructor(private readonly config: ObjectStorageConfig) {}

  key(...segments: string[]): string {
    return [this.config.prefix, 'recording-recovery', ...segments].filter(Boolean).join('/');
  }

  private request(method: 'GET' | 'HEAD' | 'PUT', key: string, write?: {
    body: string | Uint8Array<ArrayBuffer>;
    contentType: string;
    version: string | null;
    metadata?: Record<string, string>;
  }, signal?: AbortSignal): Promise<Response> {
    const signed = signObjectStorageRequest(this.config, {
      method,
      key,
      payloadSha256: write ? createHash('sha256').update(write.body).digest('hex') : EMPTY_SHA256,
      ...(write ? {
        contentType: write.contentType,
        contentLength: typeof write.body === 'string' ? Buffer.byteLength(write.body) : write.body.byteLength,
        ...(write.version ? { ifMatch: write.version } : { ifNoneMatch: '*' as const }),
        ...(write.metadata ? { metadata: write.metadata } : {}),
      } : {}),
    });
    const timeout = AbortSignal.timeout(25_000);
    return fetch(signed.url, {
      method, headers: signed.headers, body: write?.body, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  async verifyPrivate(): Promise<boolean> {
    const scope = 'private-probe';
    const key = this.key(scope, 'take.json');
    await this.writeJson(key, PRIVATE_PROBE, null);
    const probe = await this.readJson<string>(key);
    if (probe?.value !== PRIVATE_PROBE ||
        await this.writeJson(key, PRIVATE_PROBE, null) ||
        await this.writeJson(key, PRIVATE_PROBE, '"invalid-recovery-probe-version"')) return false;
    // A guest who has not started uploading has no track index yet.
    const missingIndex = this.key(scope, 'participants', randomUUID(), 'tracks.json');
    if (await this.readJson(missingIndex) !== null) return false;
    const sample = new TextEncoder().encode(PRIVATE_PROBE);
    const receipt = { offset: 0, bytes: sample.length, sha256: createHash('sha256').update(sample).digest('hex') };
    const sampleKey = this.key(scope, 'participants', 'probe', 'tracks', 'probe', '0');
    await this.createChunk(sampleKey, sample, receipt);
    const storedReceipt = await this.headChunk(sampleKey);
    if (storedReceipt.bytes !== receipt.bytes || storedReceipt.offset !== 0 || storedReceipt.sha256 !== receipt.sha256) return false;
    return (await Promise.all([key, sampleKey].map(object => this.rejectsAnonymousReads(object)))).every(Boolean);
  }

  private async rejectsAnonymousReads(key: string) {
    const { url } = signObjectStorageRequest(this.config, { method: 'GET', key, payloadSha256: EMPTY_SHA256 });
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return [401, 403, 404].includes(response.status);
  }

  async readJson<T>(key: string): Promise<RecoveryObjectVersion<T> | null> {
    const response = await this.request('GET', key);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const version = response.headers.get('etag') || '';
    if (!response.ok || !VERSION_PATTERN.test(version)) {
      await response.body?.cancel();
      throw new Error('Private storage did not return a versioned recovery object');
    }
    const bytes = await readLimited(response, METADATA_MAX_BYTES);
    return { value: JSON.parse(bytes.toString('utf8')) as T, version };
  }

  async writeJson(key: string, value: unknown, version: string | null): Promise<boolean> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > METADATA_MAX_BYTES) throw new Error('Recording metadata is too large');
    return this.write(key, { body, version, contentType: 'application/json' });
  }

  createChunk(key: string, bytes: Uint8Array<ArrayBuffer>, receipt: RecoveryChunkReceipt): Promise<boolean> {
    return this.write(key, {
      body: bytes, contentType: 'application/octet-stream', version: null,
      metadata: { 'recording-offset': String(receipt.offset), 'recording-sha256': receipt.sha256 },
    });
  }

  async headChunk(key: string): Promise<RecoveryChunkReceipt> {
    const response = await this.request('HEAD', key);
    if (!response.ok) throw new Error('Private storage did not return a committed chunk receipt');
    return readChunkReceipt(response.headers);
  }

  async readChunk(key: string, expectedOffset: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request('GET', key, undefined, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('A verified recording chunk is missing');
    }
    let receipt: RecoveryChunkReceipt;
    try {
      receipt = readChunkReceipt(response.headers);
      if (receipt.offset !== expectedOffset) throw new Error('A verified recording chunk has moved');
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const bytes = await readLimited(response, receipt.bytes);
    if (bytes.length !== receipt.bytes || createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
      throw new Error('A stored recording chunk did not match its receipt');
    }
    return bytes;
  }

  private async write(key: string, options: Parameters<RecordingRecoveryStorage['request']>[2]) {
    const response = await this.request('PUT', key, options);
    await response.body?.cancel();
    if (response.status === 409 || response.status === 412) return false;
    if (!response.ok) throw new Error('Private storage did not commit the recording object');
    return true;
  }
}

export function createRecoveryStorageResolver(env: NodeJS.ProcessEnv = process.env) {
  const config = configuredRecoveryStorage(env);
  const store = config ? new RecordingRecoveryStorage(config) : null;
  let check: Promise<boolean> | undefined;
  let nextCheckAt = 0;
  return async (): Promise<RecordingRecoveryStorage | null> => {
    if (!store) return null;
    if (!check || Date.now() >= nextCheckAt) {
      nextCheckAt = Infinity;
      check = store.verifyPrivate().catch(() => false).then(ok => {
        nextCheckAt = Date.now() + (ok ? 5 * 60_000 : 15_000);
        return ok;
      });
    }
    return await check ? store : null;
  };
}
