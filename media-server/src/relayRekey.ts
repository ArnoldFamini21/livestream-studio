import type { RtmpRelayDestination } from '@studio/shared';

/**
 * A returning studio names its destinations with ids of its own (they are local
 * to one page visit). The broadcast it continues was started under other ids.
 * What a destination IS is its RTMP URL plus stream key; the id is only the
 * name the studio uses for it. This module pairs the two lists and moves every
 * per-destination record of a running session over to the returning ids.
 */

/** The identity of a destination: where it goes. The id and the display name are not part of it. */
export function destinationTarget(destination: Pick<RtmpRelayDestination, 'rtmpUrl' | 'streamKey'>): string {
  return JSON.stringify([destination.rtmpUrl, destination.streamKey]);
}

/** The identity of a whole list: the sorted multiset of targets. Order and ids are ignored; duplicates count. */
export function destinationSetKey(destinations: ReadonlyArray<Pick<RtmpRelayDestination, 'rtmpUrl' | 'streamKey'>>): string {
  return JSON.stringify(destinations.map(destinationTarget).sort());
}

/**
 * Pairs each running destination with the incoming one that streams to the same
 * target, as oldId -> incoming destination. Destinations with an identical URL
 * and key (validateDestinations allows them as long as their ids differ) are
 * paired by equal id first, then in list order, so a pairing is always one to one.
 * Returns null when the two lists do not stream to the same set of targets.
 */
export function pairDestinationsByTarget(
  running: ReadonlyArray<RtmpRelayDestination>,
  incoming: ReadonlyArray<RtmpRelayDestination>
): Map<string, RtmpRelayDestination> | null {
  if (running.length !== incoming.length) return null;
  if (destinationSetKey(running) !== destinationSetKey(incoming)) return null;
  const free = new Map<string, RtmpRelayDestination[]>();
  for (const destination of incoming) {
    const key = destinationTarget(destination);
    free.set(key, [...(free.get(key) ?? []), destination]);
  }
  const pairs = new Map<string, RtmpRelayDestination>();
  const take = (key: string, pick: (candidate: RtmpRelayDestination) => boolean): RtmpRelayDestination | null => {
    const list = free.get(key) ?? [];
    const index = list.findIndex(pick);
    if (index < 0) return null;
    return list.splice(index, 1)[0];
  };
  const unmatched: RtmpRelayDestination[] = [];
  for (const destination of running) {
    const same = take(destinationTarget(destination), (candidate) => candidate.id === destination.id);
    if (same) pairs.set(destination.id, same);
    else unmatched.push(destination);
  }
  for (const destination of unmatched) {
    const next = take(destinationTarget(destination), () => true);
    if (!next) return null;
    pairs.set(destination.id, next);
  }
  return pairs;
}

/** The parts of a relay session that are keyed by destination id. */
export interface RekeyableSession {
  destinations: RtmpRelayDestination[];
  relays: Map<string, { destination: RtmpRelayDestination }>;
  confirmedDestinations: Set<string>;
  stopTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartAttempts: Map<string, number>;
}

function rekeyMap<V>(map: Map<string, V>, ids: ReadonlyMap<string, string>): void {
  const entries = Array.from(map.entries());
  map.clear();
  // Built from a snapshot so ids that swap places (a -> b and b -> a) cannot overwrite each other.
  for (const [key, value] of entries) map.set(ids.get(key) ?? key, value);
}

/**
 * Moves every record of a running session from its old destination ids to the
 * returning studio's ids, in one place: relays (and the destination each one
 * carries), confirmed destinations, stop and restart timers, reconnect counts,
 * and the stored destination list. Timers keep running; only their key changes.
 * Code that runs later (an exit handler, a restart timer) must read the id from
 * relay.destination, never from a copy taken before the resume.
 * Returns false and changes nothing if the lists do not stream to the same targets.
 */
export function rekeySessionDestinations(
  session: RekeyableSession,
  incoming: ReadonlyArray<RtmpRelayDestination>
): boolean {
  const pairs = pairDestinationsByTarget(session.destinations, incoming);
  if (!pairs) return false;
  const ids = new Map<string, string>();
  for (const [oldId, destination] of pairs) ids.set(oldId, destination.id);
  for (const relay of session.relays.values()) {
    const next = pairs.get(relay.destination.id);
    if (next) relay.destination = next;
  }
  rekeyMap(session.relays, ids);
  rekeyMap(session.stopTimers, ids);
  rekeyMap(session.restartTimers, ids);
  rekeyMap(session.restartAttempts, ids);
  const confirmed = Array.from(session.confirmedDestinations, (id) => ids.get(id) ?? id);
  session.confirmedDestinations.clear();
  for (const id of confirmed) session.confirmedDestinations.add(id);
  session.destinations = [...incoming];
  return true;
}
