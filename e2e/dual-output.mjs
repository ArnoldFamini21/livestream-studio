import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import ffmpegStatic from 'ffmpeg-static';
import { admitGuest, createStudio, eventually, joinStudio, repoRoot, stageGuest, startHarness } from './harness.mjs';

/** Opt-in rehearsal with a real Chromium encoder and two local RTMP receivers. */
const mediaPort = Number(process.env.E2E_DUAL_MEDIA_PORT || 3382);
const artifactDir = path.resolve(process.env.E2E_ARTIFACT_DIR || 'output/dual-output');
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const secret = 'local-dual-output-e2e-token-secret-not-production';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TMPDIR|TMP|TEMP|XDG_.*|SYSTEMROOT)$/.test(key)));

function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startProcess(command, args, logFile, environment = env) {
  const log = createWriteStream(logFile);
  const child = spawn(command, args, { cwd: artifactDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  return child;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await done; } finally { clearTimeout(kill); }
}

async function readEncoding(file) {
  const child = spawn(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-t', '0.5', '-f', 'null', '-'], { env });
  let info = '';
  child.stderr.on('data', (chunk) => { info += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, info);
  assert.match(info, /Audio: aac/, 'the output includes the program mix');
  return info;
}

test('two independent program layouts send H.264 and AAC to matching RTMP destinations', { timeout: 110_000 }, async () => {
  assert.ok(ffmpeg, 'Set FFMPEG_PATH for the local RTMP receivers');
  await mkdir(artifactDir, { recursive: true });
  const fixture = await startHarness({ artifactDir, liveTokenSecret: secret, loopbackMediaPort: mediaPort });
  const children = [];
  try {
    children.push(startProcess(process.execPath, [path.join(repoRoot, 'media-server/dist/index.js')], path.join(artifactDir, 'media.log'), {
      ...env, NODE_ENV: 'test', PORT: String(mediaPort), LIVE_STREAM_TOKEN_SECRET: secret, CLIENT_URL: fixture.url,
      FFMPEG_PATH: ffmpeg, RTMP_ENCODE_ONCE: '1', RTMP_ALLOW_PRIVATE_HOSTS: 'true', MAX_RELAY_SESSIONS: '1',
      HLS_OUTPUT_DIR: path.join(artifactDir, 'hls'),
    }));
    await eventually(async () => {
      const health = await (await fetch('http://localhost:' + mediaPort + '/health')).json();
      return health.capabilities?.dualOutput?.ready === true;
    }, { message: 'Local media server did not become ready' });

    const savedDestinations = [];
    const outputs = [];
    for (const name of ['Landscape receiver', 'Portrait receiver']) {
      const port = await freePort();
      const rtmpUrl = 'rtmp://127.0.0.1:' + port + '/live';
      const streamKey = 'fixture-' + port;
      const output = path.join(artifactDir, name.split(' ')[0].toLowerCase() + '.flv');
      outputs.push(output);
      savedDestinations.push({ platform: 'custom', name, rtmpUrl, streamKey, rememberStreamKey: true, enabled: true });
    }

    const hostContext = await fixture.browser('host', { extraArgs: ['--disable-audio-output'] });
    await hostContext.addInitScript(({ origin, destinations }) => {
      if (self === top && self.origin === origin) {
        localStorage.setItem('livestream-studio:stream-destinations:v1', JSON.stringify(destinations));
      }
    }, { origin: fixture.url, destinations: savedDestinations });
    const { page: host, studioId } = await createStudio(hostContext, { url: fixture.url, name: 'Two outputs' });
    const guestContext = await fixture.browser('guest', { extraArgs: ['--disable-audio-output'] });
    await joinStudio(guestContext, { url: fixture.url, studioId, name: 'Test Guest' });
    await admitGuest(host, 'Test Guest');
    await stageGuest(host, 'Test Guest');

    await host.getByRole('button', { name: 'Go live: open stream destinations' }).click();
    const dual = host.getByRole('checkbox', { name: 'Stream landscape and portrait together' });
    await dual.check();
    const layout = host.getByRole('combobox', { name: /Portrait layout/ });
    const preview = host.getByLabel('Portrait program preview');
    const tiles = host.locator('[data-second-program-stage] [data-stage-item-id]');
    await tiles.nth(1).waitFor({ state: 'attached' });
    const spotlightHeight = await tiles.first().evaluate((tile) => tile.offsetHeight);
    await layout.selectOption('grid');
    assert.ok((await tiles.first().evaluate((tile) => tile.offsetHeight)) < spotlightHeight);
    assert.equal(await host.locator('[data-second-program-stage]').getAttribute('data-second-program-stage'), 'portrait');
    await eventually(() => preview.evaluate((video) => video.videoWidth === 720 && video.videoHeight === 1280));
    await host.getByRole('combobox', { name: 'Portrait receiver orientation' }).selectOption('portrait');

    await host.getByText('Output settings', { exact: true }).click();
    await host.getByRole('button', { name: /720p Smooth/ }).click();
    for (const [index, { rtmpUrl, streamKey }] of savedDestinations.entries()) {
      const output = outputs[index];
      children.push(startProcess(ffmpeg, ['-hide_banner', '-v', 'info', '-listen', '1', '-timeout', '90', '-i', rtmpUrl + '/' + streamKey,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-y', output], output + '.log'));
    }
    await host.getByRole('button', { name: 'Go Live to 2 Destinations' }).click();
    await Promise.all(savedDestinations.map(({ name }) =>
      host.locator('.participant-item').filter({ hasText: name }).getByText('live', { exact: true }).waitFor({ timeout: 32_000 })));
    // Require payload from both live outputs before ending the broadcast.
    await Promise.all(outputs.map((output) =>
      eventually(async () => (await stat(output)).size > 1000, { message: 'No capture for ' + output })));
    await host.getByRole('button', { name: 'Stop Streaming (2 destinations)' }).click();

    const [landscape, portrait] = outputs;
    assert.match(await readEncoding(landscape), /Video: h264.*1280x720/);
    assert.match(await readEncoding(portrait), /Video: h264.*720x1280/);
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    const mediaLog = await readFile(path.join(artifactDir, 'media.log'), 'utf8').catch(() => '');
    throw new Error([error.message, mediaLog.split('\n').slice(-14).join('\n')].join('\n'), { cause: error });
  } finally {
    await Promise.allSettled(children.reverse().map(stopProcess));
    await fixture.close();
  }
});
