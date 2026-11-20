import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { WatchLiveResponse } from '@studio/shared';
import { useWatchLive, type WatchLive } from '../src/hooks/useWatchLive.ts';

it('serializes foreground polls and refreshes the moderated feed after a send', { timeout: 3000 }, async (t) => {
  const documentMock = Object.assign(new EventTarget(), { hidden: false });
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: documentMock, configurable: true });
  const requests: Array<{ url: string; signal?: AbortSignal | null; finish: (response: Response) => void }> = [];
  let didRequest: (() => void) | undefined;
  const nextRequest = () => new Promise<void>((resolve) => { didRequest = resolve; });
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => new Promise<Response>((finish) => {
    requests.push({ url, signal: init?.signal, finish });
    didRequest?.();
    didRequest = undefined;
  }));

  const answer = (overrides: Partial<WatchLiveResponse>) => Response.json({
    epoch: 'epoch-a',
    cursor: 1,
    reset: false,
    switches: { chat: true, reactions: false, questions: false },
    messages: [],
    removed: [],
    reactions: {},
    pollMs: 4000,
    ...overrides,
  });
  let live!: WatchLive;
  const Probe = () => {
    live = useWatchLive({ watchId: 'test-room', onReactions: () => {} });
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(Probe)); });
    assert.equal(requests.length, 1);
    await act(async () => {
      documentMock.dispatchEvent(new Event('visibilitychange'));
      live.refresh();
      live.refresh();
      await delay(0);
    });
    assert.equal(requests.length, 1, 'the pending poll also covers coming back to the tab');

    const queuedRefresh = nextRequest();
    await act(async () => {
      requests[0].finish(answer({
        reset: true,
        messages: [{ id: 'visible-line', name: 'Ana', text: 'Hello', from: 'viewer', at: 1 }],
      }));
      await queuedRefresh;
    });
    assert.equal(requests.length, 2, 'successful writes coalesce into one refresh after the pending read');
    assert.match(requests[1].url, /\?after=1&epoch=epoch-a$/);
    assert.deepEqual(live.messages.map(({ id }) => id), ['visible-line']);

    await act(async () => {
      requests[1].finish(answer({ cursor: 2, removed: ['visible-line'] }));
    });
    assert.deepEqual(live.messages, []);

    const foregroundPoll = nextRequest();
    await act(async () => {
      documentMock.dispatchEvent(new Event('visibilitychange'));
      await foregroundPoll;
    });
    assert.equal(requests.length, 3);
    assert.match(requests[2].url, /\?after=2&epoch=epoch-a$/);
  } finally {
    await act(async () => renderer?.unmount());
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
  assert.equal(requests[2].signal?.aborted, true);
});
