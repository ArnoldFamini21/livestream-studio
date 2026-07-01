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
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
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

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
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

export function createObjectStoragePutRequest(
  config: ObjectStorageConfig,
  input: ObjectStoragePutRequestInput,
  now = new Date()
): ObjectStoragePutRequest {
  const key = normalizeObjectKey(input.key);
  const url = buildStorageUrl(config, key);
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
    'PUT',
    url.pathname,
    '',
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
      'Content-Length': String(input.contentLength),
      'Content-Type': input.contentType,
      'X-Amz-Content-Sha256': input.payloadSha256,
      'X-Amz-Date': amzDate,
    },
  };
}

export async function uploadFileToObjectStorage(
  config: ObjectStorageConfig,
  input: ObjectStorageUploadInput,
  now = new Date()
): Promise<RecordingExportArtifactStorage> {
  const fileStat = await stat(input.filePath);
  const payloadSha256 = await sha256File(input.filePath);
  const request = createObjectStoragePutRequest(config, {
    key: input.key,
    contentType: input.contentType,
    contentLength: fileStat.size,
    payloadSha256,
  }, now);
  const transport = request.url.protocol === 'http:' ? http : https;

  await new Promise<void>((resolve, reject) => {
    const req = transport.request(request.url, {
      method: 'PUT',
      headers: request.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        if (chunks.reduce((total, item) => total + item.length, 0) < 2048) chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 2048);
        reject(new Error(`Object storage upload failed with status ${res.statusCode || 'unknown'}${body ? `: ${body}` : ''}`));
      });
    });
    req.on('error', reject);
    createReadStream(input.filePath)
      .on('error', reject)
      .pipe(req);
  });

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
