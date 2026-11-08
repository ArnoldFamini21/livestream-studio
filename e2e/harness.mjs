import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };

export async function eventually(check, { timeout = 30_000, interval = 100, message = 'Condition did not become true' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await delay(interval);
  } while (Date.now() < deadline);
  throw new Error(message, { cause: last });
}

/** Run the built application with no production accounts, credentials, or external services. */
export async function startHarness({ artifactDir = process.env.E2E_ARTIFACT_DIR || path.join(repoRoot, 'output/e2e'), apiPort = Number(process.env.E2E_API_PORT || 3001), port = Number(process.env.E2E_PORT || 5199), reuseServer = process.env.E2E_REUSE_SERVER === '1', distDir = path.join(repoRoot, 'client/dist') } = {}) {
  assert.ok(!reuseServer || !process.env.CI, 'CI must start isolated application servers');
  artifactDir = path.resolve(artifactDir);
  await mkdir(artifactDir, { recursive: true });
  const scratch = await mkdtemp(path.join(artifactDir, 'scratch-'));
  const url = `http://localhost:${port}`;
  const apiUrl = `http://localhost:${apiPort}`;
  const contexts = [];
  const pageErrors = [];
  const cspViolations = [];
  const serverLog = createWriteStream(path.join(artifactDir, 'server.log'));
  // An allowlist prevents developer shell credentials being used by a test run.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TMPDIR|TMP|TEMP|XDG_.*|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SYSTEMROOT)$/.test(key)));
  Object.assign(env, { NODE_ENV: 'test', PORT: String(apiPort), CLIENT_URL: url, STUDIO_OWNER_EMAILS: '', STUDIO_CREATE_SECRET: '', STUN_URLS: 'stun:127.0.0.1:9', ROOM_PERSISTENCE_DISABLED: 'true', ACCOUNT_AUTH_PERSISTENCE_DISABLED: 'true', RECORDING_CATALOG_PERSISTENCE_DISABLED: 'true', BRAND_KIT_CATALOG_PERSISTENCE_DISABLED: 'true', WORKSPACE_STUDIO_CATALOG_PERSISTENCE_DISABLED: 'true', WORKSPACE_TEAM_CATALOG_PERSISTENCE_DISABLED: 'true' });
  const server = reuseServer ? null : spawn(process.execPath, [path.join(repoRoot, 'server/dist/index.js')], { cwd: artifactDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server?.stdout.pipe(serverLog);
  server?.stderr.pipe(serverLog);
  let serverError;
  let serverListening = reuseServer;
  server?.stdout.on('data', data => { if (data.toString().includes(`Server running on http://localhost:${apiPort}`)) serverListening = true; });
  server?.on('error', error => { serverError = error; });
  const htaccess = await readFile(path.join(repoRoot, 'client/public/.htaccess'), 'utf8');
  const productionCsp = htaccess.match(/Content-Security-Policy "([^"]+)"/)[1];
  // Only the loopback API's transport differs from production's https/wss.
  const csp = productionCsp.replace("connect-src 'self'", `connect-src 'self' ${apiUrl} ws://localhost:${apiPort}`);
  const dist = path.resolve(distDir);
  const staticServer = http.createServer(async (request, response) => {
    try {
      const requested = decodeURIComponent(new URL(request.url, url).pathname);
      let file = path.resolve(dist, `.${requested}`);
      if (!file.startsWith(`${dist}${path.sep}`)) file = path.join(dist, 'index.html');
      try { if (!(await stat(file)).isFile()) file = path.join(dist, 'index.html'); } catch { file = path.join(dist, 'index.html'); }
      response.setHeader('Content-Security-Policy', csp);
      response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.end(await readFile(file));
    } catch { response.writeHead(500).end('Test static server failed'); }
  });
  const close = async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    if (!reuseServer) await new Promise(resolve => staticServer.close(resolve));
    if (server && !serverError && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(force);
    }
    serverLog.end();
    await writeFile(path.join(artifactDir, 'browser-errors.json'), JSON.stringify({ pageErrors, cspViolations }, null, 2));
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    if (!reuseServer) await new Promise((resolve, reject) => { staticServer.once('error', reject); staticServer.listen(port, resolve); });
    await eventually(async () => {
      if (serverError) throw serverError;
      if (server && server.exitCode !== null) throw new Error(`API exited ${server.exitCode}; see ${artifactDir}/server.log`);
      if (!serverListening) return false;
      return (await fetch(`${apiUrl}/health`)).ok;
    }, { message: 'Test API did not start' });
  } catch (error) { await close(); throw error; }
  return {
    url, apiUrl, artifactDir, pageErrors, cspViolations, close,
    async browser(name, { viewport = { width: 1440, height: 900 }, initScript } = {}) {
      const profile = path.join(scratch, `profile-${name}`);
      const downloadsPath = path.join(artifactDir, 'downloads');
      await mkdir(downloadsPath, { recursive: true });
      const context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.E2E_CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
        headless: process.env.E2E_HEADED !== '1', viewport, permissions: ['camera', 'microphone'], acceptDownloads: true, downloadsPath,
        args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--disk-cache-dir=${path.join(scratch, `cache-${name}`)}`],
      });
      contexts.push(context);
      await context.route(/^https?:\/\//, route => {
        const target = new URL(route.request().url());
        return ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ? route.continue() : route.abort('blockedbyclient');
      });
      context.setDefaultTimeout(20_000);
      await context.exposeBinding('__reportCsp', (_source, violation) => cspViolations.push({ browser: name, ...violation }));
      await context.addInitScript(() => {
        window.addEventListener('securitypolicyviolation', event => window.__reportCsp({ directive: event.effectiveDirective, blockedURI: event.blockedURI }));
      });
      if (initScript) await context.addInitScript(initScript);
      context.on('page', page => page.on('pageerror', error => pageErrors.push({ browser: name, message: error.message })));
      return context;
    },
  };
}

export async function createStudio(context, { url = 'http://localhost:5199', name = 'Browser qualification', hostName = 'Test Host' } = {}) {
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('button', { name: 'Create studio', exact: true }).click();
  await page.getByLabel('Studio name', { exact: true }).fill(name);
  await page.getByLabel('Your name', { exact: true }).fill(hostName);
  const created = page.waitForResponse(response => response.url().endsWith('/api/rooms') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Studio', exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const room = await response.json();
  await page.getByRole('button', { name: 'Enter studio', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
  return { page, studioId: room.id, room };
}

export async function joinStudio(context, { url = 'http://localhost:5199', studioId, name = 'Test Guest', token } = {}) {
  const page = await context.newPage();
  const joinUrl = new URL(`/join/${studioId}`, url);
  if (token) joinUrl.hash = `guestInvite=${encodeURIComponent(token)}`;
  await page.goto(joinUrl.href);
  await page.locator('#join-name').fill(name);
  await page.getByRole('button', { name: 'Join Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Leave studio', exact: true }).waitFor();
  return page;
}

export async function admitGuest(host, name) {
  await host.getByRole('button', { name: `Move ${name} backstage`, exact: true }).click();
  await host.getByRole('region', { name: 'Backstage private room', exact: true }).getByText(name, { exact: true }).waitFor();
}

export async function stageGuest(host, name) {
  await host.getByRole('button', { name: `Add ${name} to stage`, exact: true }).click();
}

export async function screenshot(page, directory, name) {
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
  await writeFile(path.join(directory, `${name}.txt`), await page.locator('body').ariaSnapshot());
}
