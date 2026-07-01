#!/usr/bin/env node
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();
  return { response, text };
}

async function fetchJson(url) {
  const { response, text } = await fetchText(url);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON: ${text.slice(0, 120)}`);
  }
  return { response, json, text };
}

function requireOk(response, label, text) {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
}

function requireServiceHealth(label, json, expectedService) {
  if (json?.status !== 'ok') {
    throw new Error(`${label} health did not report status ok`);
  }
  if (json.service !== expectedService) {
    throw new Error(`${label} health reported service ${JSON.stringify(json.service)}, expected ${expectedService}`);
  }
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

async function checkClient() {
  const { response, text } = await fetchText(clientUrl);
  requireOk(response, 'Client', text);
  const asset = text.match(/assets\/index-[^"'\s]+\.js/)?.[0];
  if (!asset) throw new Error('Client HTML did not reference a built index asset');
  return asset;
}

async function checkHealth(label, url, expectedService) {
  const { response, json, text } = await fetchJson(`${url}/health`);
  requireOk(response, label, text);
  requireServiceHealth(label, json, expectedService);
  return json;
}

async function main() {
  const result = await runWithOptionalWait();
  console.log(JSON.stringify(result, null, 2));
}

async function runOnce() {
  const clientAsset = await checkClient();
  const signaling = await checkHealth('Signaling server', apiUrl, 'signaling-server');
  const media = await checkHealth('Media server', mediaHttpUrl, 'media-server');
  if (requireProductionTurn) requireProductionTurnReady(signaling);

  return {
    status: 'ok',
    client: { url: clientUrl, asset: clientAsset },
    signaling: {
      url: apiUrl,
      version: signaling.version || null,
      commit: signaling.commit || null,
      environment: signaling.environment || null,
      ice: signaling.ice || null,
    },
    media: {
      url: mediaHttpUrl,
      version: media.version || null,
      commit: media.commit || null,
      environment: media.environment || null,
    },
  };
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

main().catch((err) => {
  console.error(`Production check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
