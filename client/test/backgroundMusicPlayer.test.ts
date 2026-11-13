import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BackgroundMusicPlayer } from '../src/audio/backgroundMusicPlayer.ts';

class FakeAudio {
  src = '';
  volume = 1;
  loop = false;
  preload = '';
  currentTime = 0;
  duration = 0;
  paused = true;
  private listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string) { (this.listeners.get(type) ?? []).forEach((listener) => listener()); }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}

class FakeParam {
  value = 1;
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}

function setup() {
  const audios: FakeAudio[] = [];
  const routes: Array<{ routing: unknown; connected: boolean }> = [];
  const context = {
    currentTime: 0,
    createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: new FakeParam(), connect() {}, disconnect() {} }),
  };
  const revoked: string[] = [];
  const player = new BackgroundMusicPlayer({
    getBus: () => ({
      getContext: () => context as unknown as AudioContext,
      connectNode: (_node: AudioNode, routing?: unknown) => {
        const route = { routing, connected: true };
        routes.push(route);
        return () => { route.connected = false; };
      },
    }),
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    createObjectURL: (file) => `blob:${(file as File).name}`,
    revokeObjectURL: (url) => { revoked.push(url); },
  });
  return { player, audios, routes, revoked };
}

function file(name: string, type = 'audio/mpeg') {
  return { name, type } as File;
}

describe('background music player', () => {
  it('plays through the ducked bus path and keeps state outside any panel', async () => {
    const { player, audios, routes } = setup();
    player.addFiles([file('Intro.mp3'), file('notes.txt', 'text/plain'), file('Outro.wav', 'audio/wav')]);
    assert.deepEqual(player.getSnapshot().tracks.map((track) => track.name), ['Intro', 'Outro']);

    player.togglePlayPause();
    const element = audios[audios.length - 1];
    assert.equal(element.src, 'blob:Intro.mp3');
    assert.equal(player.getSnapshot().isPlaying, true);
    assert.deepEqual(routes.map((route) => route.routing), [{ stream: true, monitor: true, duck: true }]);

    element.currentTime = 12;
    element.emit('timeupdate');
    assert.equal(player.getSnapshot().currentTime, 12);

    player.skipTrack(1);
    assert.equal(element.src, 'blob:Outro.wav');
    player.setMonitorEnabled(false);
    assert.equal(routes[0].connected, false);
    assert.deepEqual(routes[1].routing, { stream: true, monitor: false, duck: true });
  });

  it('stops the current track when it is removed and revokes its URL', () => {
    const { player, audios, revoked } = setup();
    player.addFiles([file('Bed.mp3')]);
    const [track] = player.getSnapshot().tracks;
    player.playTrack(track);
    const element = audios[audios.length - 1];
    assert.equal(element.paused, false);
    player.removeTrack(track.id);
    const snapshot = player.getSnapshot();
    assert.equal(snapshot.isPlaying, false);
    assert.equal(snapshot.currentTrackId, null);
    assert.equal(element.paused, true);
    assert.ok(revoked.includes('blob:Bed.mp3'));
  });

  it('notifies subscribers only on real changes', () => {
    const { player } = setup();
    let calls = 0;
    const unsubscribe = player.subscribe(() => { calls++; });
    player.setLoop(true);
    player.setLoop(true);
    player.setVolume(40);
    unsubscribe();
    player.setVolume(10);
    assert.equal(calls, 2);
  });
});

describe('background music transport', () => {
  function loaded() {
    const ctx = setup();
    ctx.player.addFiles([file('Song.mp3')]);
    ctx.player.togglePlayPause();
    const element = ctx.audios[ctx.audios.length - 1];
    element.duration = 200;
    element.emit('loadedmetadata');
    return { ...ctx, element };
  }

  it('seeks the playing element and shows the new time at once', () => {
    const { player, element } = loaded();
    assert.equal(player.getSnapshot().duration, 200);
    player.seek(100);
    assert.equal(element.currentTime, 100);
    assert.equal(player.getSnapshot().currentTime, 100);
  });

  it('seeks while paused and keeps it paused', () => {
    const { player, element } = loaded();
    player.pauseTrack();
    element.paused = true;
    player.seek(40);
    assert.equal(element.currentTime, 40);
    assert.equal(player.getSnapshot().isPlaying, false);
    assert.equal(element.paused, true);
  });

  it('clamps seeks to the track and ignores them with nothing loaded', () => {
    const { player, element } = loaded();
    player.seek(999);
    assert.equal(element.currentTime, 200);
    player.seek(-5);
    assert.equal(element.currentTime, 0);
    const fresh = setup();
    assert.doesNotThrow(() => fresh.player.seek(10));
    assert.equal(fresh.player.getSnapshot().currentTime, 0);
  });

  it('publishes elapsed time at most about four times a second', () => {
    const { player, element } = loaded();
    let notifications = 0;
    player.subscribe(() => { notifications += 1; });
    for (let t = 0; t <= 2; t += 0.05) {
      element.currentTime = t;
      element.emit('timeupdate');
    }
    assert.ok(notifications <= 9, `expected few updates, got ${notifications}`);
    assert.ok(player.getSnapshot().currentTime >= 1.5);
  });

  it('keeps the duration unknown for live streams and not-yet-loaded tracks', () => {
    const { player, element } = loaded();
    element.duration = Infinity;
    element.emit('durationchange');
    assert.equal(player.getSnapshot().duration, 0);
    element.duration = NaN;
    element.emit('loadedmetadata');
    assert.equal(player.getSnapshot().duration, 0);
  });
});
