import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createElement as h } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useBroadcastAudioBus, type BroadcastAudioBus } from '../src/hooks/useBroadcastAudioBus.ts';
import type { AudioClockDeps } from '../src/audio/programAudioClock.ts';
import {
  areProcessingSoundDevicesReleased,
  registerProcessingAudioContext,
  resetSoundDevicePolicyForTests,
} from '../src/audio/soundDevicePolicy.ts';
import {
  relayNotSendingNotice,
  shouldRestoreSoundQuietly,
  soundOutputOffMarker,
  soundOutputOffNotice,
  RELAY_NOT_SENDING_HEALTH,
  RELAY_NOT_SENDING_NOTICE,
  SOUND_OUTPUT_OFF_IDLE_MARKER,
  SOUND_OUTPUT_OFF_MARKER,
  SOUND_OUTPUT_OFF_NOTICE,
  SOUND_OUTPUT_RESTORE_FAILED,
  SOUND_OUTPUT_RESTORE_LABEL,
} from '../src/utils/relayMediaNotices.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A fake audio context in a fake world; the sound device may be stuck. */
const world = { wallMs: 0, deviceStuck: false, contexts: [] as FakeContext[], sinkCalls: [] as unknown[] };

class FakeNode {
  gain = { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} };
  connect() {}
  disconnect() {}
}

class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = new FakeNode();
  onstatechange: (() => void) | null = null;
  sink: unknown = '';
  constructor() { world.contexts.push(this); }
  createGain() { return new FakeNode(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  setSinkId(id: unknown) { world.sinkCalls.push(id); this.sink = id; return Promise.resolve(); }
  ticks() { return typeof this.sink === 'object' || !world.deviceStuck; }
}

const deps: AudioClockDeps = {
  callTimeoutMs: 5,
  now: () => world.wallMs,
  sleep: (ms) => {
    world.wallMs += ms;
    for (const context of world.contexts) if (context.state === 'running' && context.ticks()) context.currentTime += ms / 1000;
    return Promise.resolve();
  },
};

let bus: BroadcastAudioBus;
let renderer: TestRenderer.ReactTestRenderer;

function Probe() {
  bus = useBroadcastAudioBus(deps);
  return null;
}

const globals = globalThis as Record<string, unknown>;
let saved: { window: unknown; document: unknown };

beforeEach(async () => {
  saved = { window: globals.window, document: globals.document };
  resetSoundDevicePolicyForTests();
  world.wallMs = 0;
  world.deviceStuck = false;
  world.contexts = [];
  world.sinkCalls = [];
  globals.window = {
    AudioContext: FakeContext,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
  globals.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  await act(async () => { renderer = TestRenderer.create(h(Probe)); });
  // The bus context is created on first use, like the studio does.
  await act(async () => { bus.getContext(); });
});

afterEach(async () => {
  await act(async () => { renderer.unmount(); });
  globals.window = saved.window;
  globals.document = saved.document;
});

describe('the studio audio bus: program audio check and sound output', () => {
  it('starts with the sound output on', () => {
    assert.equal(bus.soundOutputOff, false);
  });

  it('reports running for a healthy clock and leaves the sound output alone', async () => {
    let result;
    await act(async () => { result = await bus.checkProgramAudio(); });
    assert.deepEqual(result, { state: 'running' });
    assert.equal(bus.soundOutputOff, false);
    assert.deepEqual(world.sinkCalls, []);
  });

  it('recovers a stuck clock by switching the sound device off, and remembers it', async () => {
    world.deviceStuck = true;
    let result;
    await act(async () => { result = await bus.checkProgramAudio(); });
    assert.deepEqual(result, { state: 'recovered' });
    assert.equal(bus.soundOutputOff, true);
    assert.deepEqual(world.sinkCalls, [{ type: 'none' }]);
  });

  it('the voice contexts follow the studio: untouched while healthy, off the device with it, back with it', async () => {
    const voiceCalls: unknown[] = [];
    const voice = { state: 'running', setSinkId(id: unknown) { voiceCalls.push(id); return Promise.resolve(); } };
    registerProcessingAudioContext(voice as unknown as AudioContext);

    await act(async () => { await bus.checkProgramAudio(); });
    assert.deepEqual(voiceCalls, [], 'a healthy check leaves the microphone processing alone');

    world.deviceStuck = true;
    await act(async () => { await bus.checkProgramAudio(); });
    assert.equal(bus.soundOutputOff, true);
    assert.deepEqual(voiceCalls, [{ type: 'none' }]);

    // Still stuck: the sound stays off, and so do the voice contexts.
    await act(async () => { await bus.restoreAudioOutput(); });
    assert.equal(bus.soundOutputOff, true);
    assert.deepEqual(voiceCalls, [{ type: 'none' }]);

    world.deviceStuck = false;
    await act(async () => { await bus.restoreAudioOutput(); });
    assert.equal(bus.soundOutputOff, false);
    assert.deepEqual(voiceCalls, [{ type: 'none' }, '']);
  });

  it('leaving the studio with the sound off gives the voice contexts their device back', async () => {
    world.deviceStuck = true;
    await act(async () => { await bus.checkProgramAudio(); });
    assert.equal(areProcessingSoundDevicesReleased(), true);
    await act(async () => { renderer.unmount(); });
    assert.equal(areProcessingSoundDevicesReleased(), false);
    // The shared afterEach unmounts again; give it something to unmount.
    await act(async () => { renderer = TestRenderer.create(h(Probe)); });
  });

  it('after recovery the same check says running (the clock now moves on a timer)', async () => {
    world.deviceStuck = true;
    await act(async () => { await bus.checkProgramAudio(); });
    let again;
    await act(async () => { again = await bus.checkProgramAudio(); });
    assert.deepEqual(again, { state: 'running' });
    assert.equal(bus.soundOutputOff, true);
  });

  it('restoreAudioOutput turns the sound back on when the device works again', async () => {
    world.deviceStuck = true;
    await act(async () => { await bus.checkProgramAudio(); });
    world.deviceStuck = false;
    let restored;
    await act(async () => { restored = await bus.restoreAudioOutput(); });
    assert.equal(restored, true);
    assert.equal(bus.soundOutputOff, false);
    assert.deepEqual(world.sinkCalls, [{ type: 'none' }, '']);
  });

  it('restoreAudioOutput leaves the sound off when the device is still stuck', async () => {
    world.deviceStuck = true;
    await act(async () => { await bus.checkProgramAudio(); });
    let restored;
    await act(async () => { restored = await bus.restoreAudioOutput(); });
    assert.equal(restored, false);
    assert.equal(bus.soundOutputOff, true);
    assert.deepEqual(world.sinkCalls, [{ type: 'none' }, '', { type: 'none' }]);
  });

  it('restoreAudioOutput does nothing when the sound is not off', async () => {
    let restored;
    await act(async () => { restored = await bus.restoreAudioOutput(); });
    assert.equal(restored, true);
    assert.deepEqual(world.sinkCalls, []);
  });

  it('runs one check or restore at a time', async () => {
    world.deviceStuck = true;
    const results: unknown[] = [];
    await act(async () => {
      const first = bus.checkProgramAudio();
      const second = bus.checkProgramAudio();
      results.push(await first, await second);
    });
    // The second check began after the first had switched the device off.
    assert.deepEqual(results, [{ state: 'recovered' }, { state: 'running' }]);
    assert.deepEqual(world.sinkCalls, [{ type: 'none' }]);
  });

  it('a new audio context starts with the sound on again', async () => {
    world.deviceStuck = true;
    await act(async () => { await bus.checkProgramAudio(); });
    assert.equal(bus.soundOutputOff, true);
    // The studio\'s context is closed and replaced (it is created again on next use).
    await act(async () => {
      world.contexts[0]!.state = 'closed';
      bus.getContext();
    });
    assert.equal(bus.soundOutputOff, false);
  });
});

describe('what the host reads when the browser stops producing the broadcast', () => {
  it('uses the planned words', () => {
    assert.equal(RELAY_NOT_SENDING_NOTICE, 'The studio is not sending your broadcast. It is restarting it now.');
    assert.equal(RELAY_NOT_SENDING_HEALTH.label, 'Not sending');
    assert.equal(RELAY_NOT_SENDING_HEALTH.detail, 'Your browser is not producing the broadcast. The studio is restarting it.');
    assert.equal(SOUND_OUTPUT_RESTORE_LABEL, 'Turn sound back on');
    assert.equal(SOUND_OUTPUT_RESTORE_FAILED, 'The sound output still does not respond. Sound stays off on this computer.');
  });

  it('says what the host stops hearing, and what stays the same', () => {
    assert.match(SOUND_OUTPUT_OFF_NOTICE, /^Your computer's sound output stopped responding\./);
    assert.match(SOUND_OUTPUT_OFF_NOTICE, /sound effects, music and clips/);
    assert.match(SOUND_OUTPUT_OFF_NOTICE, /Guests' voices are played separately and are not switched off by the studio/);
    assert.match(SOUND_OUTPUT_OFF_NOTICE, /Viewers still hear everything\./);
    assert.match(SOUND_OUTPUT_OFF_NOTICE, /press "Turn sound back on"\.$/);
    assert.match(SOUND_OUTPUT_OFF_MARKER, /Viewers still hear everything/);
  });

  it('says nothing about viewers once no broadcast runs, and uses test words for the private test', () => {
    assert.equal(soundOutputOffMarker(true), SOUND_OUTPUT_OFF_MARKER);
    assert.equal(soundOutputOffMarker(false), SOUND_OUTPUT_OFF_IDLE_MARKER);
    assert.doesNotMatch(SOUND_OUTPUT_OFF_IDLE_MARKER, /[Vv]iewers/);
    assert.match(SOUND_OUTPUT_OFF_IDLE_MARKER, /Turn sound back on/);
    assert.equal(relayNotSendingNotice(false), RELAY_NOT_SENDING_NOTICE);
    assert.match(relayNotSendingNotice(true), /test stream/);
    assert.doesNotMatch(relayNotSendingNotice(true), /broadcast/);
    assert.equal(soundOutputOffNotice(false), SOUND_OUTPUT_OFF_NOTICE);
    assert.doesNotMatch(soundOutputOffNotice(true), /[Vv]iewers|broadcast/);
  });

  it('knows when the quiet try at turning the sound back on is due', () => {
    const base = { relayStatus: 'idle' as const, studioLive: false, soundOutputOff: true };
    assert.equal(shouldRestoreSoundQuietly(base), true);
    // The relay ended with an error (the watchdog end): due.
    assert.equal(shouldRestoreSoundQuietly({ ...base, relayStatus: 'error' }), true);
    // Not while a broadcast or test runs, or while the studio still counts as live (a recorder error that did not end it).
    assert.equal(shouldRestoreSoundQuietly({ ...base, relayStatus: 'live' }), false);
    assert.equal(shouldRestoreSoundQuietly({ ...base, relayStatus: 'connecting' }), false);
    assert.equal(shouldRestoreSoundQuietly({ ...base, relayStatus: 'error', studioLive: true }), false);
    assert.equal(shouldRestoreSoundQuietly({ ...base, soundOutputOff: false }), false);
  });
});
