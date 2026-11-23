import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { admitGuest, createStudio, eventually, joinStudio, repoRoot, stageGuest, startHarness, openStudioTool } from './harness.mjs';

/** Opt-in rehearsal with a real Chromium encoder and two local RTMP receivers. */
const mediaPort = Number(process.env.E2E_DUAL_MEDIA_PORT || 3382);
const artifactDir = path.resolve(process.env.E2E_ARTIFACT_DIR || 'output/dual-output');
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const run = promisify(execFile);
const withClips = process.env.E2E_AUTOMATED_CLIPS === '1';
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
      RTMP_MAX_DESTINATIONS: '2', HLS_OUTPUT_DIR: path.join(artifactDir, 'hls'),
    }));
    await eventually(async () => {
      const health = await (await fetch('http://localhost:' + mediaPort + '/health')).json();
      return health.capabilities?.dualOutput?.ready === true && health.capabilities.dualOutput.details?.maxDestinations === 2;
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
    }, {
      origin: fixture.url,
      destinations: [...savedDestinations, {
        ...savedDestinations[0], name: 'Extra receiver', streamKey: 'extra-fixture', enabled: false,
      }],
    });
    const { page: host, studioId } = await createStudio(hostContext, { url: fixture.url, name: 'Two outputs' });
    const guestContext = await fixture.browser('guest', { extraArgs: ['--disable-audio-output'] });
    await joinStudio(guestContext, { url: fixture.url, studioId, name: 'Test Guest' });
    await admitGuest(host, 'Test Guest');
    await stageGuest(host, 'Test Guest');

    if (withClips) {
      const clip = path.join(artifactDir, 'Show bumper.mp4');
      await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25',
        '-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000',
        '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip], { timeout: 15_000 });
      await openStudioTool(host, 'Media');
      await host.getByLabel('Upload media files', { exact: true }).setInputFiles(clip);
      await eventually(() => host.getByRole('button', { name: 'Show Show bumper.mp4', exact: true }).isEnabled());
    }
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
    const portraitOrientation = host.getByRole('combobox', { name: 'Portrait receiver orientation' });
    await portraitOrientation.selectOption('portrait');

    const extraReceiver = host.locator('.participant-item').filter({ hasText: 'Extra receiver' });
    await extraReceiver.getByRole('button', { name: 'OFF', exact: true }).click();
    await host.getByText(/up to 2 destinations across both outputs/).waitFor();
    assert.equal(await host.getByRole('button', { name: 'Go Live to 3 Destinations' }).isDisabled(), true);
    await extraReceiver.getByRole('button', { name: 'ON', exact: true }).click();

    await host.getByText('Output settings', { exact: true }).click();
    await host.getByRole('button', { name: /720p Smooth/ }).click();
    await host.getByText('Stream screens', { exact: true }).first().click();
    await host.getByLabel('Show when going live', { exact: true }).check();
    await host.getByLabel('Countdown', { exact: true }).fill('8');
    await host.getByLabel('Show before ending stream', { exact: true }).check();
    await host.getByLabel('Closing screen seconds', { exact: true }).fill('12');
    if (withClips) {
      await host.getByRole('combobox', { name: 'Opening clip', exact: true }).selectOption({ label: 'Show bumper.mp4' });
      await host.getByRole('combobox', { name: 'Closing clip', exact: true }).selectOption({ label: 'Show bumper.mp4' });
    }
    for (const [index, { rtmpUrl, streamKey }] of savedDestinations.entries()) {
      const output = outputs[index];
      children.push(startProcess(ffmpeg, ['-hide_banner', '-v', 'info', '-listen', '1', '-timeout', '90', '-i', rtmpUrl + '/' + streamKey,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-y', output], output + '.log'));
    }
    // Hold the fresh health check so the workspace remains in its real startup state.
    let releaseHealth = () => {};
    const healthGate = new Promise((resolve) => { releaseHealth = resolve; });
    await host.route('http://localhost:' + mediaPort + '/health', async (route) => {
      await healthGate;
      await route.continue();
    }, { times: 1 });
    try {
      await host.getByRole('button', { name: 'Go Live to 2 Destinations' }).click();
      await host.getByRole('button', { name: 'Starting stream…' }).waitFor();
      const disabled = await Promise.all([
        dual.isDisabled(), layout.isDisabled(), portraitOrientation.isDisabled(),
        host.getByRole('button', { name: /720p Smooth/ }).isDisabled(),
      ]);
      assert.ok(disabled.every(Boolean), 'in-flight startup locks output settings');
    } finally {
      releaseHealth();
    }
    await host.getByRole('heading', { name: 'Starting Soon', exact: true }).waitFor();
    await host.getByRole('button', { name: 'Skip opening', exact: true }).waitFor();
    await Promise.all(savedDestinations.map(({ name }) =>
      host.locator('.participant-item').filter({ hasText: name }).getByText('live', { exact: true }).waitFor({ timeout: 32_000 })));
    assert.equal(await layout.isEnabled(), true, 'the alternate layout can be changed while live');
    // Require payload from both live outputs before ending the broadcast.
    await Promise.all(outputs.map((output) =>
      eventually(async () => (await stat(output)).size > 1000, { message: 'No capture for ' + output })));
    await host.getByRole('heading', { name: 'Starting Soon', exact: true }).waitFor({ state: 'detached' });
    const stop = host.getByRole('button', { name: 'Stop Streaming (2 destinations)' });
    if (withClips) await host.waitForFunction(() => document.querySelector('video[data-broadcast-screen-video]') === null);
    await stop.click();
    await host.getByRole('heading', { name: 'Thanks for watching', exact: true }).waitFor();
    const endNow = host.getByRole('button', { name: 'End now', exact: true });
    await endNow.waitFor();
    if (!withClips) await endNow.click();
    await host.getByRole('button', { name: 'Go Live to 2 Destinations' }).waitFor();

    const [landscape, portrait] = outputs;
    assert.match(await readEncoding(landscape), /Video: h264.*1280x720/);
    assert.match(await readEncoding(portrait), /Video: h264.*720x1280/);
    if (withClips) {
      for (const file of outputs) {
        const [{ stdout: frames }, { stderr: audioMeasure }] = await Promise.all([
          run(ffmpeg, ['-v', 'error', '-i', file, '-an', '-vf', 'fps=4,scale=16:16', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
            { encoding: 'buffer', timeout: 15_000 }),
          run(ffmpeg, ['-hide_banner', '-i', file, '-vn', '-af', 'bandpass=f=1100:width_type=h:w=100,volumedetect',
            '-f', 'null', '-'], { timeout: 15_000 }),
        ]);
        const redFrames = [];
        for (let offset = 0; offset + 768 <= frames.length; offset += 768) {
          // The clip is letterboxed in portrait, so sample the center pixel.
          const center = offset + (8 * 16 + 8) * 3;
          if (frames[center] > 150 && frames[center + 1] < 50) redFrames.push(offset / 768);
        }
        assert.ok(redFrames.length >= 8, 'the uploaded clip is visible in the received video');
        const maxTone = Number(audioMeasure.match(/max_volume: (-?[\d.]+) dB/)?.[1]);
        assert.ok(maxTone > -37, 'the uploaded clip tone reaches the receiver');
      }
    }
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
