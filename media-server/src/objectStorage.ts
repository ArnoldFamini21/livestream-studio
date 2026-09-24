import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { RecordingExportArtifactStorage } from '@studio/shared';

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
  publicBaseUrl?: string;
}

export interface ObjectStorageUploadInput {
  filePath: string;
  key: string;
  contentType: string;
}

export interface ObjectStoragePutRequest {
  url: URL;
  headers: Record<string, string>;
}

interface ObjectStoragePutRequestInput {
  key: string;
  contentType: string;
  contentLength: number;
  payloadSha256: string;
}

interface RecordingExportObjectKeyInput {
  prefix?: string;
  roomId: string;
  uploadId: string;
  exportId: string;
  artifactId: string;
  fileName: string;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizePrefix(value: string | undefined): string {
  return (value || '').trim().replace(/^\/+|\/+$/g, '');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectKey(key: string): string {
  return key.split('/').filter(Boolean).map(encodePathSegment).join('/');
}

function normalizeObjectKey(value: string): string {
  return value.split('/').filter(Boolean).join('/');
}

function sanitizeObjectKeySegment(value: string): string {
  return value
    .trim()
    // '+' is decoded as a space by some S3-compatible services; avoid it.
    .replace(/[<>:"|?*+\\/\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'artifact';
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function toDateStamp(date: Date): string {
  return toAmzDate(date).slice(0, 8);
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function buildStorageUrl(config: ObjectStorageConfig, key: string): URL {
  const endpoint = new URL(config.endpoint);
  const encodedKey = encodeObjectKey(key);
  if (config.forcePathStyle) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodePathSegment(config.bucket)}/${encodedKey}`;
    return endpoint;
  }
  endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodedKey}`;
  return endpoint;
}

function buildPublicUrl(config: ObjectStorageConfig, key: string): string | undefined {
  if (!config.publicBaseUrl) return undefined;
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/${encodeObjectKey(key)}`;
}

export function getRecordingObjectStorageConfig(env: NodeJS.ProcessEnv = process.env): ObjectStorageConfig | null {
  const endpoint = typeof env.RECORDING_STORAGE_ENDPOINT === 'string'
    ? normalizeEndpoint(env.RECORDING_STORAGE_ENDPOINT)
    : '';
  const bucket = typeof env.RECORDING_STORAGE_BUCKET === 'string' ? env.RECORDING_STORAGE_BUCKET.trim() : '';
  const accessKeyId = typeof env.RECORDING_STORAGE_ACCESS_KEY_ID === 'string'
    ? env.RECORDING_STORAGE_ACCESS_KEY_ID.trim()
    : '';
  const secretAccessKey = typeof env.RECORDING_STORAGE_SECRET_ACCESS_KEY === 'string'
    ? env.RECORDING_STORAGE_SECRET_ACCESS_KEY.trim()
    : '';

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    endpoint,
    region: typeof env.RECORDING_STORAGE_REGION === 'string' && env.RECORDING_STORAGE_REGION.trim()
      ? env.RECORDING_STORAGE_REGION.trim()
      : 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBoolean(env.RECORDING_STORAGE_FORCE_PATH_STYLE, true),
    prefix: normalizePrefix(env.RECORDING_STORAGE_PREFIX),
    publicBaseUrl: typeof env.RECORDING_STORAGE_PUBLIC_BASE_URL === 'string' && env.RECORDING_STORAGE_PUBLIC_BASE_URL.trim()
      ? normalizeEndpoint(env.RECORDING_STORAGE_PUBLIC_BASE_URL)
      : undefined,
  };
}

export function buildRecordingExportObjectKey(input: RecordingExportObjectKeyInput): string {
  return normalizeObjectKey([
    normalizePrefix(input.prefix),
    'rooms',
    sanitizeObjectKeySegment(input.roomId),
    'uploads',
    sanitizeObjectKeySegment(input.uploadId),
    'exports',
    sanitizeObjectKeySegment(input.exportId),
    `${sanitizeObjectKeySegment(input.artifactId)}-${sanitizeObjectKeySegment(path.basename(input.fileName))}`,
  ].filter(Boolean).join('/'));
}

interface SignedObjectStorageRequestInput {
  method: 'PUT' | 'POST' | 'DELETE';
  key: string;
  query?: Record<string, string>;
  payloadSha256: string;
  contentType?: string;
  contentLength?: number;
}

/** RFC 3986 encoding, as SigV4 canonical query strings require. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A SigV4-signed request for S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO). */
export function signObjectStorageRequest(
  config: ObjectStorageConfig,
  input: SignedObjectStorageRequestInput,
  now = new Date()
): ObjectStoragePutRequest {
  const key = normalizeObjectKey(input.key);
  const url = buildStorageUrl(config, key);
  const canonicalQuery = Object.entries(input.query || {})
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  url.search = canonicalQuery;
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalHeaders = [
    `host:${url.host}`,
    `x-amz-content-sha256:${input.payloadSha256}`,
    `x-amz-date:${amzDate}`,
  ].join('\n');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', getSigningKey(config.secretAccessKey, dateStamp, config.region))
    .update(stringToSign)
    .digest('hex');

  return {
    url,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...(input.contentLength !== undefined ? { 'Content-Length': String(input.contentLength) } : {}),
      ...(input.contentType ? { 'Content-Type': input.contentType } : {}),
      'X-Amz-Content-Sha256': input.payloadSha256,
      'X-Amz-Date': amzDate,
    },
  };
}

export function createObjectStoragePutRequest(
  config: ObjectStorageConfig,
  input: ObjectStoragePutRequestInput,
  now = new Date()
): ObjectStoragePutRequest {
  return signObjectStorageRequest(config, {
    method: 'PUT',
    key: input.key,
    payloadSha256: input.payloadSha256,
    contentType: input.contentType,
    contentLength: input.contentLength,
  }, now);
}

interface StorageResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Send one signed request; the body is a file range, a string, or nothing. */
function sendStorageRequest(
  request: ObjectStoragePutRequest,
  method: SignedObjectStorageRequestInput['method'],
  body?: { filePath: string; start: number; end: number } | string
): Promise<StorageResponse> {
  const transport = request.url.protocol === 'http:' ? http : https;
  return new Promise<StorageResponse>((resolve, reject) => {
    const req = transport.request(request.url, { method, headers: request.headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        // Responses are small XML documents; keep at most 64 KB.
        if (size < 65_536) chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => resolve({
        statusCode: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (typeof body === 'string') {
      req.end(body);
    } else if (body) {
      createReadStream(body.filePath, { start: body.start, end: body.end })
        .on('error', reject)
        .pipe(req);
    } else {
      req.end();
    }
  });
}

function assertStorageOk(response: StorageResponse, action: string): void {
  // S3 can answer CompleteMultipartUpload with 200 and an <Error> body.
  const failed = response.statusCode < 200 || response.statusCode >= 300 || /<Error>/.test(response.body);
  if (!failed) return;
  throw new Error(`Object storage ${action} failed with status ${response.statusCode || 'unknown'}${response.body ? `: ${response.body.slice(0, 2048)}` : ''}`);
}

function sha256FileRange(filePath: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath, { start, end })
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

/**
 * Files above this size go up in parts. Single uploads are capped (5 GiB on
 * S3 and R2), and a one-hour export at the default 12 Mbps is about 5.4 GB.
 */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
/** R2 requires every part except the last to be the same size (min 5 MiB). */
export const MULTIPART_PART_BYTES = 64 * 1024 * 1024;

export interface ObjectStorageUploadOptions {
  multipartThresholdBytes?: number;
  partSizeBytes?: number;
  /** Each request is signed when sent: a long upload outlives one signature's 15-minute window. */
  clock?: () => Date;
}

async function uploadSinglePart(
  config: ObjectStorageConfig,
  input: ObjectStorageUploadInput,
  size: number,
  clock: () => Date
): Promise<void> {
  const payloadSha256 = await sha256FileRange(input.filePath, 0, Math.max(0, size - 1));
  const request = signObjectStorageRequest(config, {
    method: 'PUT',
    key: input.key,
    payloadSha256: size === 0 ? EMPTY_PAYLOAD_SHA256 : payloadSha256,
    contentType: input.contentType,
    contentLength: size,
  }, clock());
  const response = await sendStorageRequest(request, 'PUT', size === 0 ? '' : { filePath: input.filePath, start: 0, end: size - 1 });
  assertStorageOk(response, 'upload');
}

async function uploadMultipart(
  config: ObjectStorageConfig,
  input: ObjectStorageUploadInput,
  size: number,
  partSize: number,
  clock: () => Date
): Promise<void> {
  const created = await sendStorageRequest(signObjectStorageRequest(config, {
    method: 'POST',
    key: input.key,
    query: { uploads: '' },
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    contentType: input.contentType,
    contentLength: 0,
  }, clock()), 'POST', '');
  assertStorageOk(created, 'multipart start');
  const uploadIdMatch = created.body.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!uploadIdMatch) throw new Error('Object storage multipart start returned no UploadId');
  const uploadId = xmlUnescape(uploadIdMatch[1]);

  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber++) {
      const end = Math.min(size, start + partSize) - 1;
      const payloadSha256 = await sha256FileRange(input.filePath, start, end);
      const response = await sendStorageRequest(signObjectStorageRequest(config, {
        method: 'PUT',
        key: input.key,
        query: { partNumber: String(partNumber), uploadId },
        payloadSha256,
        contentLength: end - start + 1,
      }, clock()), 'PUT', { filePath: input.filePath, start, end });
      assertStorageOk(response, `part ${partNumber} upload`);
      const etag = response.headers.etag;
      if (!etag || Array.isArray(etag)) throw new Error(`Object storage part ${partNumber} returned no ETag`);
      parts.push({ partNumber, etag });
    }

    const completeBody = `<CompleteMultipartUpload>${parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    const completed = await sendStorageRequest(signObjectStorageRequest(config, {
      method: 'POST',
      key: input.key,
      query: { uploadId },
      payloadSha256: sha256Hex(completeBody),
      contentType: 'application/xml',
      contentLength: Buffer.byteLength(completeBody),
    }, clock()), 'POST', completeBody);
    assertStorageOk(completed, 'multipart completion');
  } catch (error) {
    // Unfinished parts are billed until aborted.
    await sendStorageRequest(signObjectStorageRequest(config, {
      method: 'DELETE',
      key: input.key,
      query: { uploadId },
      payloadSha256: EMPTY_PAYLOAD_SHA256,
    }, clock()), 'DELETE').catch(() => undefined);
    throw error;
  }
}

export async function uploadFileToObjectStorage(
  config: ObjectStorageConfig,
  input: ObjectStorageUploadInput,
  now = new Date(),
  options: ObjectStorageUploadOptions = {}
): Promise<RecordingExportArtifactStorage> {
  const { size } = await stat(input.filePath);
  const clock = options.clock || (() => new Date());
  const threshold = options.multipartThresholdBytes ?? MULTIPART_THRESHOLD_BYTES;
  const partSize = Math.max(5 * 1024 * 1024, options.partSizeBytes ?? MULTIPART_PART_BYTES);
  if (size > threshold) {
    await uploadMultipart(config, input, size, partSize, clock);
  } else {
    await uploadSinglePart(config, input, size, clock);
  }

  const key = normalizeObjectKey(input.key);
  const result: RecordingExportArtifactStorage = {
    provider: 's3',
    bucket: config.bucket,
    key,
    uploadedAt: now.toISOString(),
  };
  const url = buildPublicUrl(config, key);
  if (url) result.url = url;
  return result;
}
