import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { admitGuest, createStudio, eventually, joinStudio, repoRoot, screenshot, stageGuest, startHarness } from './harness.mjs';

// Opt-in. Build shared, server, and media-server first, then run:
// VITE_API_URL=http://localhost:3079 VITE_WS_URL=ws://localhost:3079/ws \
// VITE_MEDIA_HTTP_URL=http://localhost:3379 VITE_MEDIA_WS_URL=ws://localhost:3379/rtmp \
// npm run -w @studio/client build
// Run node --test e2e/sfu-native-screen.mjs through the normal workspace wrapper.
const apiPort = Number(process.env.E2E_API_PORT || 3079);
const port = Number(process.env.E2E_PORT || 5279);
const mediaPort = Number(process.env.E2E_SFU_MEDIA_PORT || 3379);
const artifactDir = path.resolve(process.env.E2E_ARTIFACT_DIR || 'output/sfu-native-screen');
const secret = 'loopback-native-screen-fixture-not-for-production';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TMPDIR|TMP|TEMP|XDG_.*|SYSTEMROOT)$/.test(key)));

function installBrowserFixture() {
  const peers = [];
  window.__nativeScreenFixturePeers = peers;
  window.RTCPeerConnection = class extends window.RTCPeerConnection {
    constructor(...args) {
      super(...args);
      peers.push(this);
    }
  };
  if (!navigator.mediaDevices) return;
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints) => capture(constraints.video ? {
    ...constraints, video: { width: { ideal: 320, max: 480 }, height: { ideal: 180, max: 270 }, frameRate: { ideal: 15, max: 20 } },
  } : constraints);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 450;
      const context = canvas.getContext('2d');
      const picture = canvas.captureStream(20).getVideoTracks()[0];
      const audio = new AudioContext();
      await audio.resume();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const output = audio.createMediaStreamDestination();
      oscillator.frequency.value = 840;
      gain.gain.value = 0.1;
      oscillator.connect(gain).connect(output);
      oscillator.start();
      const sound = output.stream.getAudioTracks()[0];
      let frame = 0;
      const paint = () => {
        context.fillStyle = '#243ef5';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = 'white';
        context.fillRect((frame++ * 8) % 760, 180, 40, 70);
      };
      paint();
      const timer = setInterval(() => {
        if (picture.readyState !== 'live') {
          clearInterval(timer);
          sound.stop();
          void audio.close().catch(() => undefined);
          return;
        }
        paint();
      }, 50);
      return new MediaStream([picture, sound]);
    },
  });
}

function observeSfu(browser) {
  const received = [];
  const sent = [];
  const warnings = [];
  const remember = (frames) => ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type !== 'sfu-auth') frames.push(frame);
  };
  browser.on('page', (page) => {
    page.on('console', (message) => { if (message.text().startsWith('SFU media')) warnings.push(message.text()); });
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/sfu') return;
      socket.on('framereceived', remember(received));
      socket.on('framesent', remember(sent));
    });
  });
  return { received, sent, warnings };
}

function subscribeOffer(frames, producerIds, after = 0) {
  return frames.slice(after).findLast((frame) =>
    frame.type === 'sfu-transport-offer' && frame.side === 'subscribe' &&
    producerIds.every((id) => frame.producerMids?.[id]?.video && frame.producerMids?.[id]?.audio));
}

async function receiverStats(page, offer, requestedMids) {
  const ice = offer.sdp.match(/^a=ice-ufrag:[^\r\n]+/m)?.[0];
  assert.ok(ice, 'the SFU subscription has an ICE identity');
  return page.evaluate(async ({ ice, requestedMids }) => {
    const pc = window.__nativeScreenFixturePeers.findLast((candidate) =>
      candidate.connectionState !== 'closed' && candidate.remoteDescription?.sdp.includes(ice)
      && Object.values(requestedMids).every((mid) => candidate.getTransceivers().some((transceiver) => transceiver.mid === mid)));
    if (!pc) return null;
    const result = {};
    for (const [name, mid] of Object.entries(requestedMids)) {
      const receiver = pc.getTransceivers().find((transceiver) => transceiver.mid === mid)?.receiver;
      if (!receiver?.track || receiver.track.readyState !== 'live') return null;
      const report = await receiver.getStats();
      const packets = [...report.values()].filter((stat) => stat.type === 'inbound-rtp');
      const count = Math.max(0, ...packets.map((stat) => (
        receiver.track.kind === 'video' ? (stat.framesDecoded ?? 0) : (stat.packetsReceived ?? 0)
      )));
      result[name] = { id: receiver.track.id, count };
    }
    return result;
  }, { ice, requestedMids });
}

async function captureTransportDiagnostics(page, observer) {
  const summarizeFrames = (frames) => {
    const summary = {};
    for (const frame of frames) {
      const key = [frame.type, frame.side].filter(Boolean).join('/');
      summary[key] = (summary[key] || 0) + 1;
    }
    return summary;
  };
  const peers = await page.evaluate(async () => Promise.all(window.__nativeScreenFixturePeers.map(async (pc) => {
    const report = await pc.getStats().catch(() => new Map());
    return {
      signaling: pc.signalingState,
      ice: pc.iceConnectionState,
      dtls: pc.connectionState,
      mids: pc.getTransceivers().map((item) => ({
        mid: item.mid, direction: item.direction, currentDirection: item.currentDirection,
        receiverKind: item.receiver.track.kind,
        senderKind: item.sender.track?.kind, senderState: item.sender.track?.readyState,
        encodings: item.sender.getParameters().encodings.map(({ rid, active }) => ({ rid, active })),
      })),
      streams: [...report.values()].filter((stat) => /^(inbound|outbound)-rtp$/.test(stat.type)).map((stat) => ({
        type: stat.type, kind: stat.kind, mid: stat.mid,
        packetsReceived: stat.packetsReceived, packetsSent: stat.packetsSent, framesDecoded: stat.framesDecoded,
      })),
    };
  })));
  return { sent: summarizeFrames(observer.sent), received: summarizeFrames(observer.received), warnings: observer.warnings, peers };
}

function waitForMedia(page, offer, requestedMids, baseline, message) {
  return eventually(async () => {
    const result = await receiverStats(page, offer, requestedMids);
    if (!result) return false;
    return Object.entries(result).every(([name, data]) => data.count >= (baseline?.[name]?.count ?? 0) + 2) && result;
  }, { message });
}

function startMedia(url) {
  const log = createWriteStream(path.join(artifactDir, 'media.log'));
  const child = spawn(process.execPath, [path.join(repoRoot, 'media-server/dist/index.js')], {
    cwd: artifactDir, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env, NODE_ENV: 'test', PORT: String(mediaPort), LIVE_STREAM_TOKEN_SECRET: secret, CLIENT_URL: url,
      SFU_NATIVE_SCREEN_ENABLED: 'true', HLS_OUTPUT_DIR: path.join(artifactDir, 'hls'),
      ...(process.env.FFMPEG_PATH ? { FFMPEG_PATH: process.env.FFMPEG_PATH } : {}),
    },
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  return child;
}

async function stopMedia(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

test('the native SFU publishes camera, microphone, screen and system sound independently', { timeout: 240_000 }, async () => {
  await mkdir(artifactDir, { recursive: true });
  const fixture = await startHarness({
    artifactDir, apiPort, port, loopbackMediaPort: mediaPort, liveTokenSecret: secret, mediaMembershipControl: true,
    sharedBrowserProcess: true,
  });
  const media = startMedia(fixture.url);
  let launchError;
  media.once('error', (error) => { launchError = error; });
  let host;
  let receiver;
  let presenter;
  try {
    await eventually(async () => {
      if (launchError) throw launchError;
      return (await fetch(`http://localhost:${mediaPort}/health`)).ok;
    }, { message: 'The local native-screen relay did not become healthy' });

    const openBrowser = async (name) => {
      const browser = await fixture.browser(name, {
        initScript: installBrowserFixture, viewport: { width: 1100, height: 720 },
        // The test relay uses plain host ICE. Keep browser host candidates usable by the local relay.
        extraArgs: ['--disable-audio-output', '--disable-features=WebRtcHideLocalIpsWithMdns'],
      });
      return { browser, ...observeSfu(browser) };
    };
    receiver = await openBrowser('host');
    const studio = await createStudio(receiver.browser, { url: fixture.url, name: 'SFU screen qualification' });
    host = studio.page;
    const stage = async (name) => {
      const guest = await openBrowser(name);
      const page = await joinStudio(guest.browser, { url: fixture.url, studioId: studio.studioId, name });
      await admitGuest(host, name);
      await stageGuest(host, name);
      return { ...guest, page };
    };
    presenter = await stage('Screen Presenter');
    await stage('Stage Guest Two');
    await stage('Stage Guest Three');
    await stage('Stage Guest Four');
    const identity = await eventually(() => presenter.received.findLast((frame) =>
      frame.type === 'sfu-ready' && frame.supportsScreenSource === true), { message: 'A five-person stage did not negotiate the opt-in capability' });
    await eventually(() => presenter.received.findLast((frame) => frame.type === 'sfu-screen-peers')?.participantIds.length === 5,
      { message: 'The initial five stage peers did not join the native-screen SFU' });
    const ownerId = identity.participantId;
    const screenId = `screen:${ownerId}`;
    const hearBase = await eventually(() => subscribeOffer(receiver.received, [ownerId]), { message: 'The SFU camera and microphone were not offered' });
    const baseMids = { camera: hearBase.producerMids[ownerId].video, voice: hearBase.producerMids[ownerId].audio };
    const originalBase = await waitForMedia(host, hearBase, baseMids, null, 'The SFU camera or microphone did not deliver media');

    const startScreen = () => presenter.page.getByRole('button', { name: 'Share screen', exact: true }).click();
    const stopScreen = () => presenter.page.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
    const beforeFirstShare = receiver.received.length;
    await startScreen();
    const firstPublish = await eventually(() => presenter.sent.findLast((frame) =>
      frame.type === 'sfu-publish-screen' && frame.audio === true), { message: 'The publisher fell back instead of using native screen audio' });
    const firstOffer = await eventually(() => subscribeOffer(receiver.received, [ownerId, screenId], beforeFirstShare),
      { message: 'The native screen did not get its own video and audio MIDs' });
    const screenMids = { screen: firstOffer.producerMids[screenId].video, sound: firstOffer.producerMids[screenId].audio };
    assert.equal(new Set([...Object.values(baseMids), ...Object.values(screenMids)]).size, 4);
    const firstMedia = await waitForMedia(host, firstOffer, { ...baseMids, ...screenMids }, originalBase,
      'Both SFU pictures and both audio sources must carry packets while sharing');
    assert.equal(firstMedia.camera.id, originalBase.camera.id);
    assert.equal(firstMedia.voice.id, originalBase.voice.id);
    assert.notEqual(firstMedia.camera.id, firstMedia.screen.id);
    assert.notEqual(firstMedia.voice.id, firstMedia.sound.id);

    const beforeStop = receiver.received.length;
    await stopScreen();
    await eventually(() => receiver.received.slice(beforeStop).some((frame) =>
      frame.type === 'sfu-producer-removed' && frame.producerId === screenId), { message: 'Stopping the share did not remove its producer' });
    assert.ok(!receiver.received.slice(beforeStop).some((frame) =>
      frame.type === 'sfu-producer-removed' && frame.producerId === ownerId), 'stopping a screen keeps the camera producer');

    // Keep five people on stage when the presenter is sent backstage so the
    // other clients do not turn off the SFU just because they crossed the threshold.
    await stage('Reserve Stage Guest');
    await eventually(() => presenter.received.findLast((frame) => frame.type === 'sfu-screen-peers')?.participantIds.length === 6,
      { message: 'The reserve guest did not join the native-screen SFU' });
    const beforeRestart = receiver.received.length;
    await startScreen();
    await eventually(() => presenter.sent.some((frame) =>
      frame.type === 'sfu-publish-screen' && frame.audio === true && frame.requestId !== firstPublish.requestId),
    { message: 'Restarting a share did not open a fresh publish attempt' });
    const restart = await eventually(() => subscribeOffer(receiver.received, [ownerId, screenId], beforeRestart),
      { message: 'Restarting a screen did not reach the viewer' });
    assert.deepEqual(restart.producerMids[screenId], firstOffer.producerMids[screenId]);
    const restartedMids = { ...baseMids, ...screenMids };
    const restartBaseline = await eventually(() => receiverStats(host, restart, restartedMids),
      { message: 'The viewer did not apply the restarted screen offer' });
    const restartedMedia = await waitForMedia(host, restart, restartedMids, restartBaseline,
      'The parked screen receivers did not resume receiving media');
    assert.equal(restartedMedia.screen.id, firstMedia.screen.id);
    assert.equal(restartedMedia.sound.id, firstMedia.sound.id);

    const beforeRevocation = receiver.received.length;
    await host.getByRole('navigation', { name: 'Studio panels' }).getByRole('button', { name: 'People', exact: true }).click();
    await host.getByRole('button', { name: 'Options for Screen Presenter', exact: true }).click();
    await host.getByRole('group', { name: 'Controls for Screen Presenter', exact: true })
      .getByRole('button', { name: 'Move backstage', exact: true }).click();
    await eventually(() => {
      const removals = receiver.received.slice(beforeRevocation)
        .filter((frame) => frame.type === 'sfu-producer-removed').map((frame) => frame.producerId);
      return removals.includes(ownerId) && removals.includes(screenId);
    }, { message: 'Moving the presenter backstage left a live-stage producer' });

    await writeFile(path.join(artifactDir, 'native-screen.json'), JSON.stringify({
      stageParticipants: 5, producerId: ownerId, baseMids, screenMids, firstMedia, restartedMedia, removed: [ownerId, screenId],
    }, null, 2));
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    const transport = await Promise.allSettled([
      ...(host && receiver ? [captureTransportDiagnostics(host, receiver)] : []),
      ...(presenter ? [captureTransportDiagnostics(presenter.page, presenter)] : []),
    ]);
    await writeFile(path.join(artifactDir, 'native-screen-transport.json'), JSON.stringify(transport, null, 2)).catch(() => undefined);
    if (host && !host.isClosed()) await screenshot(host, artifactDir, 'native-screen-failure').catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled([fixture.close(), stopMedia(media)]);
  }
});
