import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BroadcastScreenVideo } from '../src/components/BroadcastScreenVideo.tsx';
import type { BroadcastAudioBus } from '../src/hooks/useBroadcastAudioBus.ts';

it('publishes clip video and audio only while a decoded frame is playing', async () => {
  const attributes = new Set<string>();
  const video = Object.assign(new EventTarget(), {
    paused: true,
    ended: false,
    readyState: 1,
    HAVE_CURRENT_DATA: 2,
    videoWidth: 640,
    style: { visibility: 'hidden' },
    setAttribute: (name: string) => attributes.add(name),
    removeAttribute: (name: string) => attributes.delete(name),
    play: async () => { video.paused = false; },
    pause: () => { video.paused = true; },
  });
  const context = { state: 'running', createMediaElementSource: () => ({ context }) };
  let routes = 0;
  const bus = {
    getContext: () => context,
    connectNode: () => {
      routes += 1;
      return () => { routes -= 1; };
    },
  } as unknown as BroadcastAudioBus;
  let failures = 0;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(BroadcastScreenVideo, {
      url: 'blob:clip',
      bus,
      onEnded: () => {},
      onFailure: () => { failures += 1; },
    }), { createNodeMock: () => video });
  });

  const published = () => attributes.has('data-broadcast-screen-video');
  video.dispatchEvent(new Event('playing'));
  assert.equal(published(), false);
  assert.equal(video.style.visibility, 'hidden');
  assert.equal(routes, 0);

  video.readyState = video.HAVE_CURRENT_DATA;
  video.dispatchEvent(new Event('playing'));
  assert.equal(published(), true);
  assert.equal(video.style.visibility, 'visible');
  assert.equal(routes, 1);

  video.dispatchEvent(new Event('waiting'));
  assert.equal(published(), false);
  assert.equal(video.style.visibility, 'hidden');
  assert.equal(routes, 0);
  video.dispatchEvent(new Event('playing'));
  assert.equal(routes, 1);
  video.dispatchEvent(new Event('error'));
  assert.equal(failures, 1);
  assert.equal(video.paused, true);
  assert.equal(published(), false);
  assert.equal(routes, 0);

  act(() => renderer?.unmount());
  assert.equal(routes, 0);
});
