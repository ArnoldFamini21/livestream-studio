import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SfuScreenAudioMix } from '../src/utils/sfuScreenAudioMix.ts';

type FakeTrack = MediaStreamTrack & { label: string };
const track = (label: string, readyState: MediaStreamTrackState = 'live') => ({ label, readyState, id: label }) as unknown as FakeTrack;

function fakeMixer() {
  const built: Array<{ voice: string | null; disposed: boolean; track: FakeTrack }> = [];
  const mix = (_context: unknown, voice: MediaStreamTrack | null) => {
    const entry = { voice: voice ? (voice as FakeTrack).label : null, disposed: false, track: track(`mix-${built.length + 1}`) };
    built.push(entry);
    return { track: entry.track, dispose: () => { entry.disposed = true; } };
  };
  return { built, mix };
}

describe('SFU screen-share audio mix', () => {
  it('keeps publishing the shared sound when the voice track changes', () => {
    const { built, mix } = fakeMixer();
    const screen = track('screen');
    const controller = new SfuScreenAudioMix({} as never, screen, mix as never);
    const first = controller.trackFor(track('mic'));
    assert.equal(first?.label, 'mix-1');
    assert.equal(controller.active, true);
    const micTrack = track('mic-b');
    assert.equal(controller.trackFor(micTrack)?.label, 'mix-2', 'rebuilt around the new voice, not the bare voice');
    assert.equal(built[1].voice, 'mic-b');
    assert.equal(built[0].disposed, true, 'the mix reading the old mic is released');
    assert.equal(controller.trackFor(micTrack)?.label, 'mix-2', 'the same voice keeps the same mix');
    assert.equal(built.length, 2);
  });

  it('publishes the voice alone once the share or the controller ends', () => {
    const { built, mix } = fakeMixer();
    const screen = track('screen');
    const controller = new SfuScreenAudioMix({} as never, screen, mix as never);
    controller.trackFor(track('mic'));
    (screen as { readyState: string }).readyState = 'ended';
    const voice = track('mic-c');
    assert.equal(controller.trackFor(voice), voice);
    assert.equal(built[0].disposed, true);
    assert.equal(controller.active, false);
    controller.dispose();
    assert.equal(controller.trackFor(voice), voice);
  });

  it('falls back to the voice when mixing is not possible', () => {
    const controller = new SfuScreenAudioMix({} as never, track('screen'), (() => null) as never);
    const voice = track('mic');
    assert.equal(controller.trackFor(voice), voice);
    assert.equal(controller.active, false);
  });
});
