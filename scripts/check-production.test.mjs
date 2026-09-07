import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  checkHealth,
  describeHttpFailure,
  describeServiceCapabilityFailure,
  describeServiceHealthMetadataFailure,
  evaluateClientCacheHeaders,
  evaluateHostAccessCreateResponse,
  normalizeProductionCheckScope,
  parseCurlHeaderText,
  shouldCheckRequiredMediaServer,
} from './check-production.mjs';

test('normalizes production check scopes', () => {
  assert.equal(normalizeProductionCheckScope('all'), 'all');
  assert.equal(normalizeProductionCheckScope('client'), 'client');
  assert.equal(normalizeProductionCheckScope('static'), 'client');
  assert.equal(normalizeProductionCheckScope('services'), 'services');
  assert.equal(normalizeProductionCheckScope('server'), 'services');
  assert.throws(() => normalizeProductionCheckScope('database'), /Unsupported PRODUCTION_CHECK_SCOPE/);
});

test('requires media server checks only for client scoped checks when requested', () => {
  assert.equal(shouldCheckRequiredMediaServer('client', true), true);
  assert.equal(shouldCheckRequiredMediaServer('static', true), true);
  assert.equal(shouldCheckRequiredMediaServer('client', false), false);
  assert.equal(shouldCheckRequiredMediaServer('services', true), false);
  assert.equal(shouldCheckRequiredMediaServer('all', true), false);
});

test('accepts CDN-ready client cache headers', () => {
  const result = evaluateClientCacheHeaders({
    htmlCacheControl: 'no-cache, no-store, must-revalidate',
    assetCacheControl: 'public, max-age=31536000, immutable',
    assetExpires: 'Thu, 01 Jul 2027 21:17:52 GMT',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.assetMaxAge, 31536000);
});

test('rejects weak client cache headers', () => {
  const result = evaluateClientCacheHeaders({
    htmlCacheControl: '',
    assetCacheControl: 'public, max-age=604800',
    assetExpires: '0',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Client HTML/);
  assert.match(result.errors.join('\n'), /at least one year/);
  assert.match(result.errors.join('\n'), /immutable/);
  assert.match(result.errors.join('\n'), /Expires: 0/);
});

test('parses the final curl response header block after redirects', () => {
  const response = parseCurlHeaderText([
    'HTTP/2 301',
    'location: https://studio.example.com/',
    '',
    'HTTP/2 200',
    'cache-control: public, max-age=31536000, immutable',
    'expires: Wed, 08 Jul 2026 22:43:28 GMT',
    '',
  ].join('\r\n'));

  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('expires'), 'Wed, 08 Jul 2026 22:43:28 GMT');
});

test('explains Render no-server responses as missing services', () => {
  const response = new Response('Not Found', {
    status: 404,
    headers: {
      'x-render-routing': 'no-server',
    },
  });

  const message = describeHttpFailure(response, 'Media server', 'Not Found');

  assert.match(message, /Media server is not provisioned on Render/);
  assert.match(message, /Create or sync the Render service/);
  assert.doesNotMatch(message, /did not return JSON/);
});

test('explains old Render health payloads as stale deployments', () => {
  const message = describeServiceHealthMetadataFailure(
    'Signaling server',
    { status: 'ok' },
    'signaling-server'
  );

  assert.match(message, /older Render deployment/);
  assert.match(message, /deploy hook secret/);
});

test('requires media-server exact deck renderer capability metadata', () => {
  const missing = describeServiceCapabilityFailure(
    'Media server',
    { status: 'ok', service: 'media-server' },
    'presentationRenderer',
    'exact deck renderer'
  );

  assert.match(missing, /does not include exact deck renderer capability metadata/);
  assert.match(missing, /Redeploy the service/);

  const degraded = describeServiceCapabilityFailure(
    'Media server',
    {
      status: 'ok',
      service: 'media-server',
      capabilities: {
        presentationRenderer: {
          ready: false,
          message: 'Exact deck renderer unavailable: LibreOffice is not ready.',
        },
      },
    },
    'presentationRenderer',
    'exact deck renderer'
  );

  assert.match(degraded, /exact deck renderer capability is not ready/);
  assert.match(degraded, /LibreOffice is not ready/);

  assert.equal(
    describeServiceCapabilityFailure(
      'Media server',
      {
        status: 'ok',
        service: 'media-server',
        capabilities: {
          presentationRenderer: {
            ready: true,
            message: 'Exact deck renderer ready.',
          },
        },
      },
      'presentationRenderer',
      'exact deck renderer'
    ),
    ''
  );
});

test('accepts create studio responses with private host access', () => {
  const result = evaluateHostAccessCreateResponse({
    id: 'room-123',
    name: 'Production check',
    hostName: 'Arnold',
    hostToken: 'validHostToken_1234567890',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.roomId, 'room-123');
  assert.equal(result.hostTokenLength, 25);
});

test('rejects create studio responses that omit host access', () => {
  const result = evaluateHostAccessCreateResponse({
    id: 'room-123',
    name: 'Production check',
    hostName: 'Arnold',
    hostId: '',
    coHostIds: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /valid private hostToken/);
});


test('health checks send the configured website origin through fetch and curl fallback', async () => {
  const origins = [];
  const server = createServer((req, res) => {
    origins.push(req.headers.origin);
    if (req.headers.origin !== 'https://studio.example.test') {
      res.writeHead(403).end('Forbidden: origin not allowed');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok', service: 'media-server',
      commit: process.env.EXPECTED_COMMIT || process.env.GITHUB_SHA || 'abcdef0',
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  try {
    assert.equal((await checkHealth('Media', url, 'media-server', 'https://studio.example.test/path')).status, 'ok');
    globalThis.fetch = async () => { throw new Error('Simulated fetch transport failure'); };
    assert.equal((await checkHealth('Media', url, 'media-server', 'https://studio.example.test/path')).status, 'ok');
    globalThis.fetch = originalFetch;
    await assert.rejects(checkHealth('Media', url, 'media-server', 'https://untrusted.example'), /HTTP 403/);
    assert.deepEqual(origins, ['https://studio.example.test', 'https://studio.example.test', 'https://untrusted.example']);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
