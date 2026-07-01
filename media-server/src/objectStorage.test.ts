import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildRecordingExportObjectKey,
  createObjectStoragePutRequest,
  getRecordingObjectStorageConfig,
  uploadFileToObjectStorage,
  type ObjectStorageConfig,
} from './objectStorage.js';

function baseConfig(endpoint = 'https://s3.example.com'): ObjectStorageConfig {
  return {
    endpoint,
    region: 'us-east-1',
    bucket: 'recordings',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    forcePathStyle: true,
    prefix: 'studio',
    publicBaseUrl: 'https://cdn.example.com/recordings',
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('recording object storage', () => {
  it('normalizes optional S3-compatible storage env config', () => {
    assert.equal(getRecordingObjectStorageConfig({}), null);
    assert.equal(getRecordingObjectStorageConfig({
      RECORDING_STORAGE_ENDPOINT: 'https://s3.example.com',
      RECORDING_STORAGE_BUCKET: 'recordings',
      RECORDING_STORAGE_ACCESS_KEY_ID: 'access-key',
    }), null);

    const config = getRecordingObjectStorageConfig({
      RECORDING_STORAGE_ENDPOINT: 'https://s3.example.com/',
      RECORDING_STORAGE_REGION: 'auto',
      RECORDING_STORAGE_BUCKET: 'recordings',
      RECORDING_STORAGE_ACCESS_KEY_ID: 'access-key',
      RECORDING_STORAGE_SECRET_ACCESS_KEY: 'secret-key',
      RECORDING_STORAGE_FORCE_PATH_STYLE: 'false',
      RECORDING_STORAGE_PREFIX: '/studio/exports/',
      RECORDING_STORAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/recordings/',
    });

    assert.deepEqual(config, {
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'recordings',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      forcePathStyle: false,
      prefix: 'studio/exports',
      publicBaseUrl: 'https://cdn.example.com/recordings',
    });
  });

  it('builds stable recording export object keys without unsafe path segments', () => {
    assert.equal(
      buildRecordingExportObjectKey({
        prefix: 'studio',
        roomId: 'room/123',
        uploadId: 'upload:456',
        exportId: 'export 789',
        artifactId: 'final-mp4',
        fileName: 'Launch Demo.mp4',
      }),
      'studio/rooms/room_123/uploads/upload_456/exports/export_789/final-mp4-Launch_Demo.mp4'
    );
  });

  it('creates SigV4 PUT requests without exposing the secret key', () => {
    const request = createObjectStoragePutRequest(baseConfig(), {
      key: 'studio/rooms/room-123/Launch Demo.mp4',
      contentType: 'video/mp4',
      contentLength: 12,
      payloadSha256: 'a'.repeat(64),
    }, new Date('2026-07-01T20:00:00.000Z'));

    assert.equal(request.url.toString(), 'https://s3.example.com/recordings/studio/rooms/room-123/Launch%20Demo.mp4');
    assert.equal(request.headers['Content-Type'], 'video/mp4');
    assert.equal(request.headers['X-Amz-Date'], '20260701T200000Z');
    assert.match(request.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=access-key\/20260701\/us-east-1\/s3\/aws4_request/);
    assert.equal(request.headers.Authorization.includes('secret-key'), false);
  });

  it('streams files to S3-compatible storage and returns durable artifact metadata', async () => {
    const received: Buffer[] = [];
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'PUT');
      assert.equal(req.url, '/recordings/studio/rooms/room-123/Launch%20Demo.mp4');
      assert.equal(req.headers['content-type'], 'video/mp4');
      assert.equal(typeof req.headers.authorization, 'string');
      req.on('data', (chunk: Buffer) => received.push(chunk));
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listen(server);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'recording-storage-test-'));
    const filePath = path.join(dir, 'Launch Demo.mp4');
    await writeFile(filePath, Buffer.from('artifact-bytes'));

    try {
      const result = await uploadFileToObjectStorage({
        ...baseConfig(`http://127.0.0.1:${port}`),
      }, {
        filePath,
        key: 'studio/rooms/room-123/Launch Demo.mp4',
        contentType: 'video/mp4',
      }, new Date('2026-07-01T20:00:00.000Z'));

      assert.equal(Buffer.concat(received).toString('utf8'), 'artifact-bytes');
      assert.deepEqual(result, {
        provider: 's3',
        bucket: 'recordings',
        key: 'studio/rooms/room-123/Launch Demo.mp4',
        url: 'https://cdn.example.com/recordings/studio/rooms/room-123/Launch%20Demo.mp4',
        uploadedAt: '2026-07-01T20:00:00.000Z',
      });
    } finally {
      await close(server);
    }
  });
});
