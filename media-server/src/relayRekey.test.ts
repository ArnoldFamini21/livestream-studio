import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RtmpRelayDestination } from '@studio/shared';
import { destinationSetKey, pairDestinationsByTarget, rekeySessionDestinations, type RekeyableSession } from './relayRekey.js';

const dest = (id: string, rtmpUrl: string, streamKey: string, name = id): RtmpRelayDestination => ({ id, name, rtmpUrl, streamKey });

function sessionFor(destinations: RtmpRelayDestination[]) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const timer = () => {
    const handle = setTimeout(() => {}, 60_000);
    timers.push(handle);
    return handle;
  };
  const session: RekeyableSession = {
    destinations,
    relays: new Map(destinations.map((destination) => [destination.id, { destination }])),
    confirmedDestinations: new Set(destinations.map((destination) => destination.id)),
    stopTimers: new Map(destinations.map((destination) => [destination.id, timer()])),
    restartTimers: new Map(destinations.map((destination) => [destination.id, timer()])),
    restartAttempts: new Map(destinations.map((destination, index) => [destination.id, index + 1])),
  };
  return { session, done: () => timers.forEach(clearTimeout) };
}

describe('destinationSetKey', () => {
  it('ignores ids, names and order', () => {
    const a = [dest('a', 'rtmp://x/live', 'k1'), dest('b', 'rtmp://y/live', 'k2')];
    const b = [dest('saved-1', 'rtmp://y/live', 'k2', 'Other name'), dest('dest-9', 'rtmp://x/live', 'k1')];
    assert.equal(destinationSetKey(a), destinationSetKey(b));
  });

  it('differs for another key, another URL, one more or one fewer', () => {
    const base = [dest('a', 'rtmp://x/live', 'k1')];
    assert.notEqual(destinationSetKey(base), destinationSetKey([dest('a', 'rtmp://x/live', 'k2')]));
    assert.notEqual(destinationSetKey(base), destinationSetKey([dest('a', 'rtmp://x/live2', 'k1')]));
    assert.notEqual(destinationSetKey(base), destinationSetKey([...base, dest('b', 'rtmp://y/live', 'k')]));
    assert.notEqual(destinationSetKey(base), destinationSetKey([]));
  });

  it('compares exactly: no trimming or case folding', () => {
    assert.notEqual(destinationSetKey([dest('a', 'rtmp://x/live', 'k1')]), destinationSetKey([dest('a', 'rtmp://x/live', 'k1 ')]));
    assert.notEqual(destinationSetKey([dest('a', 'rtmp://x/live', 'k1')]), destinationSetKey([dest('a', 'rtmp://X/live', 'k1')]));
  });

  it('counts duplicates: two identical targets are not one', () => {
    const one = [dest('a', 'rtmp://x/live', 'k1')];
    const two = [dest('a', 'rtmp://x/live', 'k1'), dest('b', 'rtmp://x/live', 'k1')];
    assert.notEqual(destinationSetKey(one), destinationSetKey(two));
    assert.equal(destinationSetKey(two), destinationSetKey([dest('p', 'rtmp://x/live', 'k1'), dest('q', 'rtmp://x/live', 'k1')]));
  });

  it('cannot be fooled by a separator inside a key', () => {
    assert.notEqual(
      destinationSetKey([dest('a', 'rtmp://x/live', 'k1","b')]),
      destinationSetKey([dest('a', 'rtmp://x/live', 'k1'), dest('b', 'b', 'b')])
    );
  });
});

describe('pairDestinationsByTarget', () => {
  it('pairs by target whatever the ids and order', () => {
    const running = [dest('dest-1', 'rtmp://x/live', 'k1'), dest('dest-2', 'rtmp://y/live', 'k2')];
    const incoming = [dest('saved-1', 'rtmp://y/live', 'k2'), dest('saved-0', 'rtmp://x/live', 'k1')];
    const pairs = pairDestinationsByTarget(running, incoming)!;
    assert.equal(pairs.get('dest-1')?.id, 'saved-0');
    assert.equal(pairs.get('dest-2')?.id, 'saved-1');
  });

  it('returns null when the lists differ', () => {
    const running = [dest('a', 'rtmp://x/live', 'k1')];
    assert.equal(pairDestinationsByTarget(running, [dest('a', 'rtmp://x/live', 'other')]), null);
    assert.equal(pairDestinationsByTarget(running, []), null);
  });

  it('pairs duplicates one to one, equal ids first, then in list order', () => {
    const running = [dest('a', 'rtmp://x/live', 'k'), dest('b', 'rtmp://x/live', 'k')];
    const sameIds = pairDestinationsByTarget(running, [dest('b', 'rtmp://x/live', 'k'), dest('a', 'rtmp://x/live', 'k')])!;
    assert.equal(sameIds.get('a')?.id, 'a');
    assert.equal(sameIds.get('b')?.id, 'b');
    const newIds = pairDestinationsByTarget(running, [dest('p', 'rtmp://x/live', 'k'), dest('q', 'rtmp://x/live', 'k')])!;
    assert.equal(newIds.get('a')?.id, 'p');
    assert.equal(newIds.get('b')?.id, 'q');
    assert.equal(new Set(Array.from(newIds.values(), (d) => d.id)).size, 2);
  });
});

describe('rekeySessionDestinations', () => {
  it('moves every id-keyed record to the returning ids and keeps the timers', () => {
    const running = [dest('dest-1', 'rtmp://x/live', 'k1', 'YouTube'), dest('dest-2', 'rtmp://y/live', 'k2', 'Facebook')];
    const { session, done } = sessionFor(running);
    session.confirmedDestinations.delete('dest-2');
    const stopTimer = session.stopTimers.get('dest-1');
    const restartTimer = session.restartTimers.get('dest-2');
    const incoming = [dest('saved-1', 'rtmp://y/live', 'k2', 'Facebook (saved)'), dest('saved-0', 'rtmp://x/live', 'k1', 'YouTube (saved)')];
    assert.equal(rekeySessionDestinations(session, incoming), true);

    assert.deepEqual([...session.relays.keys()].sort(), ['saved-0', 'saved-1']);
    assert.equal(session.relays.get('saved-0')?.destination.rtmpUrl, 'rtmp://x/live');
    assert.equal(session.relays.get('saved-0')?.destination.id, 'saved-0');
    assert.equal(session.relays.get('saved-1')?.destination.name, 'Facebook (saved)');
    assert.deepEqual([...session.confirmedDestinations], ['saved-0']);
    assert.equal(session.stopTimers.get('saved-0'), stopTimer);
    assert.equal(session.restartTimers.get('saved-1'), restartTimer);
    assert.equal(session.restartAttempts.get('saved-0'), 1);
    assert.equal(session.restartAttempts.get('saved-1'), 2);
    assert.deepEqual(session.destinations.map((d) => d.id), ['saved-1', 'saved-0']);
    for (const map of [session.stopTimers, session.restartTimers, session.restartAttempts]) {
      assert.deepEqual([...map.keys()].sort(), ['saved-0', 'saved-1']);
    }
    done();
  });

  it('survives ids that swap places', () => {
    const running = [dest('a', 'rtmp://x/live', 'k1'), dest('b', 'rtmp://y/live', 'k2')];
    const { session, done } = sessionFor(running);
    // The returning studio calls the YouTube-like target "b" and the other "a".
    const incoming = [dest('b', 'rtmp://x/live', 'k1'), dest('a', 'rtmp://y/live', 'k2')];
    assert.equal(rekeySessionDestinations(session, incoming), true);
    assert.equal(session.relays.get('b')?.destination.rtmpUrl, 'rtmp://x/live');
    assert.equal(session.relays.get('a')?.destination.rtmpUrl, 'rtmp://y/live');
    assert.equal(session.restartAttempts.get('b'), 1);
    assert.equal(session.restartAttempts.get('a'), 2);
    done();
  });

  it('lets a handler that reads relay.destination see the new id, but not one that copied the old one', () => {
    const { session, done } = sessionFor([dest('old', 'rtmp://x/live', 'k')]);
    const relay = session.relays.get('old')!;
    const copiedId = relay.destination.id;
    assert.equal(rekeySessionDestinations(session, [dest('new', 'rtmp://x/live', 'k')]), true);
    assert.equal(relay.destination.id, 'new');
    assert.equal(copiedId, 'old');
    done();
  });

  it('changes nothing when the lists differ', () => {
    const { session, done } = sessionFor([dest('a', 'rtmp://x/live', 'k1')]);
    assert.equal(rekeySessionDestinations(session, [dest('z', 'rtmp://x/live', 'other')]), false);
    assert.deepEqual([...session.relays.keys()], ['a']);
    assert.deepEqual([...session.confirmedDestinations], ['a']);
    assert.deepEqual(session.destinations.map((d) => d.id), ['a']);
    done();
  });

  it('keeps duplicates unambiguous', () => {
    const running = [dest('a', 'rtmp://x/live', 'k'), dest('b', 'rtmp://x/live', 'k')];
    const { session, done } = sessionFor(running);
    assert.equal(rekeySessionDestinations(session, [dest('p', 'rtmp://x/live', 'k'), dest('q', 'rtmp://x/live', 'k')]), true);
    assert.deepEqual([...session.relays.keys()].sort(), ['p', 'q']);
    assert.equal(session.restartAttempts.get('p'), 1);
    assert.equal(session.restartAttempts.get('q'), 2);
    done();
  });
});
