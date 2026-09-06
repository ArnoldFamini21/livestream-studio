import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectMediaElementAudio } from '../src/utils/mediaElementAudio.ts';
import type { BroadcastAudioBus } from '../src/hooks/useBroadcastAudioBus.ts';

function createBus() {
  let sourceCount = 0;
  let activeRoutes = 0;
  let resumed = 0;
  const routes: unknown[] = [];
  const context = {
    state: 'suspended',
    createMediaElementSource: () => {
      sourceCount++;
      return { context };
    },
    resume: async () => { resumed++; context.state = 'running'; },
  };
  const bus = {
    getContext: () => context,
    connectNode: (_source: unknown, routing: unknown) => {
      activeRoutes++;
      routes.push(routing);
      return () => { activeRoutes--; };
    },
  } as unknown as BroadcastAudioBus;
  return { bus, routes, counts: () => ({ sourceCount, activeRoutes, resumed }) };
}

describe('shared clip audio routing', () => {
  it('routes the clip to both the broadcast mix and monitor once, then releases its route', async () => {
    const { bus, routes, counts } = createBus();
    const route = connectMediaElementAudio({} as HTMLMediaElement, bus);
    await route.resume();
    await route.resume();
    assert.deepEqual(routes, [{ stream: true, monitor: true }]);
    assert.deepEqual(counts(), { sourceCount: 1, activeRoutes: 1, resumed: 1 });
    route.disconnect();
    route.disconnect();
    assert.equal(counts().activeRoutes, 0);
  });

  it('reuses the browser source when the same video is reattached', () => {
    const { bus, counts } = createBus();
    const element = {} as HTMLMediaElement;
    const first = connectMediaElementAudio(element, bus);
    first.disconnect();
    const second = connectMediaElementAudio(element, bus);
    assert.deepEqual(counts(), { sourceCount: 1, activeRoutes: 1, resumed: 0 });
    second.disconnect();
    assert.equal(counts().activeRoutes, 0);
  });

  it('rejects an element tied to an earlier audio session instead of silently dropping broadcast audio', () => {
    const element = {} as HTMLMediaElement;
    const first = connectMediaElementAudio(element, createBus().bus);
    first.disconnect();
    const next = createBus();
    assert.throws(() => connectMediaElementAudio(element, next.bus), /audio session changes/);
    assert.equal(next.counts().activeRoutes, 0);
  });
});
