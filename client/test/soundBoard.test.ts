import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_CUSTOM_SOUNDS,
  MAX_CUSTOM_SOUND_BYTES,
  SOUND_PAD_VOLUMES_STORAGE_KEY,
  customSoundName,
  formatSoundPadHotkey,
  parsePadVolumes,
  resolveSoundPadHotkey,
  validateCustomSoundDuration,
  validateCustomSoundFile,
} from '../src/utils/soundBoard.ts';
import { SoundBoardPlayer, listSoundPads } from '../src/audio/soundBoardPlayer.ts';
import { BUILT_IN_SOUND_EFFECTS } from '../src/audio/soundEffects.ts';
import type { SoundBoardLibrary, StoredCustomSound } from '../src/utils/soundBoardLibrary.ts';

describe('sound pad hotkeys', () => {
  it('maps Shift + digit row to pads 1-10 by physical key', () => {
    assert.equal(resolveSoundPadHotkey({ code: 'Digit1', key: '!', shiftKey: true }), 0);
    assert.equal(resolveSoundPadHotkey({ code: 'Digit9', key: '(', shiftKey: true }), 8);
    assert.equal(resolveSoundPadHotkey({ code: 'Digit0', key: ')', shiftKey: true }), 9);
    assert.equal(formatSoundPadHotkey(9), 'Shift+0');
    assert.equal(formatSoundPadHotkey(10), null);
  });

  it('leaves bare digits to the layout shortcuts and ignores typing', () => {
    assert.equal(resolveSoundPadHotkey({ code: 'Digit1', key: '1' }), null);
    assert.equal(resolveSoundPadHotkey({ code: 'Digit1', key: '!', shiftKey: true, metaKey: true }), null);
    assert.equal(resolveSoundPadHotkey({ code: 'Digit1', key: '!', shiftKey: true, repeat: true }), null);
    assert.equal(resolveSoundPadHotkey({ code: 'Digit1', key: '!', shiftKey: true, target: { tagName: 'INPUT' } }), null);
    assert.equal(resolveSoundPadHotkey({ code: 'Digit1', key: '!', shiftKey: true, target: { tagName: 'DIV', isContentEditable: true } }), null);
    assert.equal(resolveSoundPadHotkey({ code: 'KeyQ', key: 'Q', shiftKey: true }), null);
  });
});

describe('custom sound validation', () => {
  it('rejects non-audio, oversized and over-limit files before decoding', () => {
    assert.equal(validateCustomSoundFile({ name: 'a.mp3', size: 1000, type: 'audio/mpeg' }, 0), null);
    assert.match(validateCustomSoundFile({ name: 'a.png', size: 1000, type: 'image/png' }, 0) ?? '', /audio file/);
    assert.match(validateCustomSoundFile({ name: 'a.mp3', size: MAX_CUSTOM_SOUND_BYTES + 1, type: 'audio/mpeg' }, 0) ?? '', /short clips/);
    assert.match(validateCustomSoundFile({ name: 'a.mp3', size: 10, type: 'audio/mpeg' }, MAX_CUSTOM_SOUNDS) ?? '', /Remove one/);
    assert.match(validateCustomSoundDuration(120) ?? '', /Background Music/);
    assert.equal(validateCustomSoundDuration(3), null);
  });

  it('names pads from the file name', () => {
    assert.equal(customSoundName('Big Laugh.final.wav'), 'Big Laugh.final');
    assert.equal(customSoundName('.mp3'), 'Sound');
  });

  it('reads stored per-pad volumes defensively', () => {
    assert.deepEqual(parsePadVolumes('{"ding":0.5,"horn":4,"bad":"x"}'), { ding: 0.5, horn: 1 });
    assert.deepEqual(parsePadVolumes('not json'), {});
    assert.deepEqual(parsePadVolumes(null), {});
  });
});

// ---- Fake Web Audio, just enough for the player's routing ----

class FakeParam {
  value = 1;
  events: Array<[string, number]> = [];
  setTargetAtTime(value: number) { this.events.push(['target', value]); this.value = value; }
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeNode {
  connections = new Set<FakeNode>();
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = '';
  curve: unknown = null;
  stopped = false;
  buffer: unknown = null;
  constructor(readonly context: FakeContext, readonly label: string) {}
  connect(target: FakeNode) { this.connections.add(target); return target; }
  disconnect(target?: FakeNode) {
    if (target) this.connections.delete(target);
    else this.connections.clear();
  }
  start() {}
  stop() { this.stopped = true; }
}

class FakeContext {
  currentTime = 0;
  state = 'running';
  created: FakeNode[] = [];
  createGain() { const node = new FakeNode(this, 'gain'); this.created.push(node); return node; }
  sampleRate = 8_000;
  createBufferSource() { const node = new FakeNode(this, 'buffer'); this.created.push(node); return node; }
  createOscillator() { return new FakeNode(this, 'oscillator'); }
  createBiquadFilter() { return new FakeNode(this, 'filter'); }
  createWaveShaper() { return new FakeNode(this, 'shaper'); }
  createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  async decodeAudioData() { return { duration: 2 }; }
}

function fakeBus() {
  const context = new FakeContext();
  const routes: Array<{ node: FakeNode; routing: unknown; connected: boolean }> = [];
  return {
    context,
    routes,
    bus: {
      getContext: () => context as unknown as AudioContext,
      connectNode: (node: AudioNode, routing?: unknown) => {
        const route = { node: node as unknown as FakeNode, routing, connected: true };
        routes.push(route);
        return () => { route.connected = false; };
      },
    },
  };
}

function memoryLibrary(initial: StoredCustomSound[] = []): SoundBoardLibrary & { items: StoredCustomSound[] } {
  const items = [...initial];
  return {
    items,
    list: async () => [...items],
    put: async (sound) => { items.push(sound); },
    remove: async (id) => {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) items.splice(index, 1);
    },
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}

describe('sound board player', () => {
  it('orders built-in pads before custom sounds and gives the first ten hotkeys', () => {
    const pads = listSoundPads([{ id: 'c1', name: 'Laugh' }, { id: 'c2', name: 'Boo' }, { id: 'c3', name: 'Yay' }]);
    assert.equal(pads.length, BUILT_IN_SOUND_EFFECTS.length + 3);
    assert.equal(pads[0].hotkey, 'Shift+1');
    assert.equal(pads[9].id, 'c2');
    assert.equal(pads[9].hotkey, 'Shift+0');
    assert.equal(pads[10].hotkey, null);
  });

  it('routes through one master gain with per-pad gains, and stop-all silences every voice', async () => {
    const { bus, routes, context } = fakeBus();
    const storage = memoryStorage();
    const player = new SoundBoardPlayer({ getBus: () => bus, library: memoryLibrary(), storage });
    player.setPadVolume('ding', 0.3);
    await player.play('ding');
    await player.play('airhorn');
    assert.deepEqual(routes.map((route) => route.routing), [{ stream: true, monitor: true }]);
    assert.deepEqual([...player.getSnapshot().playingIds].sort(), ['airhorn', 'ding']);
    assert.equal(JSON.parse(storage.map.get(SOUND_PAD_VOLUMES_STORAGE_KEY) ?? '{}').ding, 0.3);

    const master = routes[0].node;
    const padGains = context.created.filter((node) => node.connections.has(master));
    assert.equal(padGains.length, 2);
    assert.ok(padGains.some((gain) => gain.gain.value === 0.3));

    player.stopAll();
    assert.deepEqual(player.getSnapshot().playingIds, []);

    player.setSendToStream(false);
    assert.equal(routes[0].connected, false);
    assert.deepEqual(routes[1].routing, { stream: false, monitor: true });
    player.dispose();
  });

  it('loads saved custom sounds and forgets removed ones', async () => {
    const { bus } = fakeBus();
    const blob = new Blob(['x'], { type: 'audio/wav' });
    const library = memoryLibrary([{ id: 's1', name: 'Laugh', mimeType: 'audio/wav', size: 1, addedAt: '2026-01-01T00:00:00Z', data: blob }]);
    const player = new SoundBoardPlayer({ getBus: () => bus, library, storage: null });
    await player.loadLibrary();
    assert.deepEqual(player.getSnapshot().customSounds, [{ id: 's1', name: 'Laugh' }]);
    assert.equal(player.pads.at(-1)?.id, 's1');
    await player.play('s1');
    assert.deepEqual(player.getSnapshot().playingIds, ['s1']);

    await player.removeCustomSound('s1');
    assert.deepEqual(player.getSnapshot().customSounds, []);
    assert.deepEqual(player.getSnapshot().playingIds, []);
    assert.equal(library.items.length, 0);
    player.dispose();
  });

  it('refuses an oversized upload without decoding it', async () => {
    const { bus } = fakeBus();
    const library = memoryLibrary();
    const player = new SoundBoardPlayer({ getBus: () => bus, library, storage: null });
    const huge = { name: 'long.mp3', type: 'audio/mpeg', size: MAX_CUSTOM_SOUND_BYTES + 1, arrayBuffer: async () => { throw new Error('should not read'); } } as unknown as File;
    assert.equal(await player.addCustomSound(huge), false);
    assert.match(player.getSnapshot().message ?? '', /short clips/);
    assert.equal(library.items.length, 0);
  });
});
