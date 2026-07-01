#!/usr/bin/env node
const DEFAULT_CLIENT_URL = 'https://studio.arnoldfamini.com';
const DEFAULT_API_URL = 'https://livestream-studio-server.onrender.com';
const DEFAULT_MEDIA_HTTP_URL = 'https://livestream-studio-media-server.onrender.com';

const clientUrl = trimUrl(process.env.PRODUCTION_CLIENT_URL || DEFAULT_CLIENT_URL);
const apiUrl = trimUrl(process.env.PRODUCTION_API_URL || DEFAULT_API_URL);
const mediaHttpUrl = trimUrl(process.env.PRODUCTION_MEDIA_HTTP_URL || DEFAULT_MEDIA_HTTP_URL);
const expectedCommit = normalizeSha(process.env.EXPECTED_COMMIT || process.env.GITHUB_SHA || '');

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeSha(value) {
  const trimmed = String(value || '').trim();
  return /^[a-f0-9]{7,40}$/i.test(trimmed) ? trimmed.toLowerCase() : '';
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
  const clientAsset = await checkClient();
  const signaling = await checkHealth('Signaling server', apiUrl, 'signaling-server');
  const media = await checkHealth('Media server', mediaHttpUrl, 'media-server');

  console.log(JSON.stringify({
    status: 'ok',
    client: { url: clientUrl, asset: clientAsset },
    signaling: {
      url: apiUrl,
      version: signaling.version || null,
      commit: signaling.commit || null,
      environment: signaling.environment || null,
    },
    media: {
      url: mediaHttpUrl,
      version: media.version || null,
      commit: media.commit || null,
      environment: media.environment || null,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(`Production check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
