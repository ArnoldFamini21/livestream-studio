#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const DEFAULT_CLIENT_URL = 'https://studio.arnoldfamini.com';
const DEFAULT_API_URL = 'https://livestream-studio-server.onrender.com';
const DEFAULT_MEDIA_HTTP_URL = 'https://livestream-studio-media-server.onrender.com';

const clientUrl = trimUrl(process.env.PRODUCTION_CLIENT_URL || DEFAULT_CLIENT_URL);
const apiUrl = trimUrl(process.env.PRODUCTION_API_URL || DEFAULT_API_URL);
const mediaHttpUrl = trimUrl(process.env.PRODUCTION_MEDIA_HTTP_URL || DEFAULT_MEDIA_HTTP_URL);
const expectedCommit = normalizeSha(process.env.EXPECTED_COMMIT || process.env.GITHUB_SHA || '');
const waitMs = parseNonNegativeInt(process.env.PRODUCTION_CHECK_WAIT_MS, 0);
const intervalMs = parsePositiveInt(process.env.PRODUCTION_CHECK_INTERVAL_MS, 15_000);
const requireProductionTurn = parseBoolean(process.env.PRODUCTION_REQUIRE_TURN || process.env.REQUIRE_PRODUCTION_TURN);
const requireClientCache = parseBoolean(process.env.PRODUCTION_REQUIRE_CLIENT_CACHE || process.env.REQUIRE_CLIENT_CACHE);
const requireHostAccessContract = parseBoolean(process.env.PRODUCTION_REQUIRE_HOST_ACCESS || process.env.REQUIRE_HOST_ACCESS);
const checkScope = normalizeProductionCheckScope(process.env.PRODUCTION_CHECK_SCOPE || 'all');
const execFile = promisify(execFileCallback);

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeSha(value) {
  const trimmed = String(value || '').trim();
  return /^[a-f0-9]{7,40}$/i.test(trimmed) ? trimmed.toLowerCase() : '';
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

export function normalizeProductionCheckScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'client' || normalized === 'static') return 'client';
  if (normalized === 'services' || normalized === 'server') return 'services';
  if (!normalized || normalized === 'all') return 'all';
  throw new Error(`Unsupported PRODUCTION_CHECK_SCOPE ${JSON.stringify(value)}. Use client, services, or all.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseCurlHeaderText(text) {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => /^HTTP\/\S+\s+\d+/i.test(block));
  const block = blocks.at(-1) || '';
  const lines = block.split('\n').filter(Boolean);
  const status = Number.parseInt(lines[0]?.match(/^HTTP\/\S+\s+(\d+)/i)?.[1] || '', 10);
  const headers = new Headers();

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name) headers.append(name, value);
  }

  return {
    ok: Number.isFinite(status) && status >= 200 && status < 300,
    status: Number.isFinite(status) ? status : 0,
    headers,
  };
}

async function fetchWithCurlFallback(url, options = {}, fetchError) {
  const directory = await mkdtemp(path.join(tmpdir(), 'livestream-production-check-'));
  const headersPath = path.join(directory, 'headers.txt');
  const bodyPath = path.join(directory, 'body.txt');
  const method = String(options.method || 'GET').toUpperCase();
  const args = [
    '--silent',
    '--show-error',
    '--location',
    '--max-time',
    '30',
    '--dump-header',
    headersPath,
    '--output',
    bodyPath,
  ];

  if (method === 'HEAD') {
    args.push('--head');
  } else if (method !== 'GET') {
    args.push('--request', method);
  }

  args.push(url);

  try {
    await execFile('curl', args, { maxBuffer: 5 * 1024 * 1024 });
    const headerText = await readFile(headersPath, 'utf8');
    const body = method === 'HEAD' ? '' : await readFile(bodyPath, 'utf8');
    return { response: parseCurlHeaderText(headerText), text: body };
  } catch (curlError) {
    const originalMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
    const curlMessage = curlError instanceof Error ? curlError.message : String(curlError);
    throw new Error(`fetch failed for ${url}: ${originalMessage}; curl fallback failed: ${curlMessage}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    const text = await response.text();
    return { response, text };
  } catch (err) {
    return fetchWithCurlFallback(url, {}, err);
  }
}

async function fetchHeaders(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return response;
  } catch (err) {
    const { response } = await fetchWithCurlFallback(url, { method: 'HEAD' }, err);
    return response;
  }
}

async function fetchJson(url) {
  const { response, text } = await fetchText(url);
  if (!response.ok) {
    return { response, json: null, text };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON: ${text.slice(0, 120)}`);
  }
  return { response, json, text };
}

export function describeHttpFailure(response, label, text = '') {
  const body = String(text || '').slice(0, 120);
  const status = response?.status || 0;
  const renderRouting = response?.headers?.get?.('x-render-routing') || '';

  if (renderRouting.toLowerCase() === 'no-server') {
    return `${label} is not provisioned on Render (x-render-routing: no-server). ` +
      'Create or sync the Render service from render.yaml, add the matching deploy hook secret, and redeploy.';
  }

  return `${label} returned HTTP ${status}: ${body}`;
}

function requireOk(response, label, text) {
  if (!response.ok) {
    throw new Error(describeHttpFailure(response, label, text));
  }
}

export function describeServiceHealthMetadataFailure(label, json, expectedService) {
  if (json?.status !== 'ok') {
    return `${label} health did not report status ok`;
  }
  if (json.service === undefined) {
    return `${label} health is from an older Render deployment and does not include service metadata. ` +
      'Configure the matching Render deploy hook secret and redeploy this service.';
  }
  if (json.service !== expectedService) {
    return `${label} health reported service ${JSON.stringify(json.service)}, expected ${expectedService}`;
  }
  return '';
}

function requireServiceHealth(label, json, expectedService) {
  const metadataFailure = describeServiceHealthMetadataFailure(label, json, expectedService);
  if (metadataFailure) throw new Error(metadataFailure);
  if (expectedCommit) {
    const actual = normalizeSha(json.commit);
    if (!actual || !expectedCommit.startsWith(actual.slice(0, 7))) {
      throw new Error(`${label} health commit ${JSON.stringify(json.commit)} does not match ${expectedCommit}`);
    }
  }
}

function requireProductionTurnReady(signaling) {
  const ice = signaling?.ice;
  if (
    !ice ||
    ice.turnReady !== true ||
    ice.hasConfiguredTurn !== true ||
    ice.source === 'default' ||
    ice.usingFallbackTurn === true
  ) {
    const detail = ice
      ? `source=${JSON.stringify(ice.source)}, turnReady=${JSON.stringify(ice.turnReady)}, hasConfiguredTurn=${JSON.stringify(ice.hasConfiguredTurn)}, usingFallbackTurn=${JSON.stringify(ice.usingFallbackTurn)}`
      : 'no ice metadata';
    throw new Error(
      `Signaling server is not using configured production TURN (${detail}). ` +
      'Set ICE_SERVERS_JSON or TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL on Render and redeploy.'
    );
  }
}

function getMaxAgeSeconds(cacheControl) {
  const match = String(cacheControl || '').match(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function evaluateClientCacheHeaders({ htmlCacheControl = '', assetCacheControl = '', assetExpires = '' } = {}) {
  const errors = [];
  const html = String(htmlCacheControl || '').toLowerCase();
  const asset = String(assetCacheControl || '').toLowerCase();
  const expires = String(assetExpires || '').trim().toLowerCase();
  const assetMaxAge = getMaxAgeSeconds(asset);

  if (!html.includes('no-cache') && !html.includes('no-store')) {
    errors.push('Client HTML must send Cache-Control no-cache or no-store so new deploys are discovered promptly');
  }
  if (!asset.includes('public')) {
    errors.push('Built client assets must send public Cache-Control');
  }
  if (assetMaxAge === null || assetMaxAge < 31_536_000) {
    errors.push('Built client assets must be cached for at least one year');
  }
  if (!asset.includes('immutable')) {
    errors.push('Built client assets must send immutable Cache-Control');
  }
  if (expires === '0') {
    errors.push('Built client assets must not inherit Expires: 0');
  }

  return {
    ok: errors.length === 0,
    errors,
    htmlCacheControl,
    assetCacheControl,
    assetExpires,
    assetMaxAge,
  };
}

export function evaluateHostAccessCreateResponse(room = {}) {
  const errors = [];
  const hostToken = typeof room.hostToken === 'string' ? room.hostToken.trim() : '';

  if (typeof room.id !== 'string' || room.id.length === 0) {
    errors.push('Create studio response must include room id');
  }
  if (typeof room.name !== 'string' || room.name.length === 0) {
    errors.push('Create studio response must include room name');
  }
  if (typeof room.hostName !== 'string' || room.hostName.length === 0) {
    errors.push('Create studio response must include hostName');
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(hostToken)) {
    errors.push('Create studio response must include a valid private hostToken');
  }

  return {
    ok: errors.length === 0,
    errors,
    roomId: typeof room.id === 'string' ? room.id : null,
    hostTokenLength: hostToken.length || null,
  };
}

async function requireClientCacheHeaders(htmlResponse, assetUrl) {
  const assetResponse = await fetchHeaders(assetUrl);
  requireOk(assetResponse, 'Client asset', '');

  const validation = evaluateClientCacheHeaders({
    htmlCacheControl: htmlResponse.headers.get('cache-control') || '',
    assetCacheControl: assetResponse.headers.get('cache-control') || '',
    assetExpires: assetResponse.headers.get('expires') || '',
  });

  if (!validation.ok) {
    throw new Error(`Client cache headers are not CDN-ready: ${validation.errors.join('; ')}`);
  }

  return validation;
}

async function checkClient() {
  const { response, text } = await fetchText(clientUrl);
  requireOk(response, 'Client', text);
  const asset = text.match(/assets\/index-[^"'\s]+\.js/)?.[0];
  if (!asset) throw new Error('Client HTML did not reference a built index asset');
  const assetUrl = new URL(asset, `${clientUrl}/`).toString();
  const cache = requireClientCache ? await requireClientCacheHeaders(response, assetUrl) : null;
  return { asset, cache };
}

async function checkHealth(label, url, expectedService) {
  const { response, json, text } = await fetchJson(`${url}/health`);
  requireOk(response, label, text);
  requireServiceHealth(label, json, expectedService);
  return json;
}

async function checkProductionServices() {
  const [signalingResult, mediaResult] = await Promise.allSettled([
    checkHealth('Signaling server', apiUrl, 'signaling-server'),
    checkHealth('Media server', mediaHttpUrl, 'media-server'),
  ]);
  const errors = [];

  if (signalingResult.status === 'rejected') {
    errors.push(signalingResult.reason instanceof Error ? signalingResult.reason.message : String(signalingResult.reason));
  }
  if (mediaResult.status === 'rejected') {
    errors.push(mediaResult.reason instanceof Error ? mediaResult.reason.message : String(mediaResult.reason));
  }
  if (errors.length > 0) {
    throw new Error(`Production service checks failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    signaling: signalingResult.value,
    media: mediaResult.value,
  };
}

async function checkHostAccessContract() {
  const response = await fetch(`${apiUrl}/api/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: clientUrl,
    },
    body: JSON.stringify({
      name: `Production host access check ${new Date().toISOString()}`,
      hostName: 'Production Check',
    }),
  });
  const text = await response.text();
  requireOk(response, 'Create studio host access contract', text);

  let room = null;
  try {
    room = JSON.parse(text);
  } catch {
    throw new Error(`Create studio host access contract did not return JSON: ${text.slice(0, 120)}`);
  }

  const validation = evaluateHostAccessCreateResponse(room);
  if (!validation.ok) {
    throw new Error(`Create studio host access contract failed: ${validation.errors.join('; ')}`);
  }

  return {
    ok: true,
    roomId: validation.roomId,
    hostTokenLength: validation.hostTokenLength,
  };
}

async function main() {
  const result = await runWithOptionalWait();
  console.log(JSON.stringify(result, null, 2));
}

async function runOnce() {
  const result = {
    status: 'ok',
  };

  if (checkScope === 'all' || checkScope === 'client') {
    const client = await checkClient();
    result.client = {
      url: clientUrl,
      asset: client.asset,
      cache: client.cache
        ? {
            htmlCacheControl: client.cache.htmlCacheControl || null,
            assetCacheControl: client.cache.assetCacheControl || null,
            assetExpires: client.cache.assetExpires || null,
            assetMaxAge: client.cache.assetMaxAge,
          }
        : null,
    };
  }

  if (checkScope === 'all' || checkScope === 'services') {
    const { signaling, media } = await checkProductionServices();
    if (requireProductionTurn) requireProductionTurnReady(signaling);
    const hostAccess = requireHostAccessContract ? await checkHostAccessContract() : null;

    result.signaling = {
      url: apiUrl,
      version: signaling.version || null,
      commit: signaling.commit || null,
      environment: signaling.environment || null,
      ice: signaling.ice || null,
      hostAccess,
    };
    result.media = {
      url: mediaHttpUrl,
      version: media.version || null,
      commit: media.commit || null,
      environment: media.environment || null,
    };
  }

  return result;
}

async function runWithOptionalWait() {
  const deadline = Date.now() + waitMs;
  let attempt = 0;
  let lastError = null;

  while (true) {
    attempt++;
    try {
      const result = await runOnce();
      return waitMs > 0 ? { ...result, attempts: attempt } : result;
    } catch (err) {
      lastError = err;
      if (waitMs <= 0 || Date.now() + intervalMs > deadline) break;
      console.error(`Production check attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(intervalMs);
    }
  }

  throw lastError || new Error('Production check failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Production check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
