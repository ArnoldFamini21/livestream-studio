import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProgramAudioMixer,
  buildProgramAudioInputs,
  type AudioTrackLike,
  type ProgramAudioGraph,
  type ProgramAudioMembershipState,
} from '../src/audio/programAudioMixer.ts';
import { ProgramAudioController } from '../src/audio/programAudioController.ts';

interface FakeTrack extends AudioTrackLike {
  clone(): FakeTrack;
  stop(): void;
}

function track(id: string, readyState = 'live'): FakeTrack {
  const t: FakeTrack = {
    id,
    readyState,
    clone: () => track(`${id}-clone`),
    stop: () => { t.readyState = 'ended'; },
  };
  return t;
}

function stream(...tracks: FakeTrack[]) {
  return { getAudioTracks: () => tracks };
}

function fakeGraph() {
  const log: string[] = [];
  let next = 0;
  const graph: ProgramAudioGraph<FakeTrack, { n: number; trackId: string }> = {
    connectTrack: (t, gain) => {
      if (t.id.startsWith('broken')) throw new Error('sample rate mismatch');
      const handle = { n: next++, trackId: t.id };
      log.push(`connect ${t.id} @${gain}`);
      return handle;
    },
    setGain: (handle, gain) => { log.push(`gain ${handle.trackId} @${gain}`); },
    disconnect: (handle) => { log.push(`disconnect ${handle.trackId}`); },
  };
  return { graph, log };
}

type Status = 'green-room' | 'backstage' | 'on-stage';

function state(overrides: Partial<ProgramAudioMembershipState<FakeTrack>> & {
  people?: Record<string, Status>;
}): ProgramAudioMembershipState<FakeTrack> {
  const { people = {}, ...rest } = overrides;
  return {
    localParticipant: { id: 'host', status: 'on-stage' },
    localStream: null,
    participants: Object.entries(people).map(([id, status]) => [id, { status }] as [string, { status: Status }]),
    remoteStreams: new Map(),
    participantVolumes: {},
    ...rest,
  };
}

describe('program audio membership', () => {
  it('mixes only on-stage people, plus screen audio', () => {
    const inputs = buildProgramAudioInputs(state({
      localStream: stream(track('host-mic')),
      people: { amy: 'on-stage', bob: 'backstage', cat: 'green-room' },
      remoteStreams: new Map([
        ['amy', stream(track('amy-mic'))],
        ['bob', stream(track('bob-mic'))],
        ['cat', stream(track('cat-mic'))],
      ]),
      remoteScreenStreams: new Map([['amy', stream(track('amy-screen'))], ['bob', stream(track('bob-screen'))]]),
      localScreenStream: stream(track('host-tab')),
      participantVolumes: { amy: 0.4, host: 2 },
    }));
    assert.deepEqual(inputs.map((input) => [input.key, input.track.id, input.gain]), [
      ['participant:host#0', 'host-mic', 1],
      ['participant:amy#0', 'amy-mic', 0.4],
      ['screen:amy#0', 'amy-screen', 1],
      ['screen:local#0', 'host-tab', 1],
    ]);
  });

  it('leaves the host mic out while the host is backstage', () => {
    const inputs = buildProgramAudioInputs(state({
      localParticipant: { id: 'host', status: 'backstage' },
      localStream: stream(track('host-mic')),
    }));
    assert.deepEqual(inputs, []);
  });

  it('skips ended tracks and a track carried by two streams', () => {
    const shared = track('shared');
    const inputs = buildProgramAudioInputs(state({
      localStream: stream(track('dead', 'ended')),
      people: { amy: 'on-stage' },
      remoteStreams: new Map([['amy', stream(shared)]]),
      remoteScreenStreams: new Map([['amy', stream(shared)]]),
    }));
    assert.deepEqual(inputs.map((input) => input.key), ['participant:amy#0']);
  });
});

describe('program audio mixer reconciliation', () => {
  it('adds a guest promoted to the stage after Go Live', () => {
    const { graph, log } = fakeGraph();
    const mixer = new ProgramAudioMixer(graph);
    const hostMic = track('host-mic');
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(hostMic), people: { amy: 'backstage' }, remoteStreams: new Map([['amy', stream(track('amy-mic'))]]) })));
    assert.deepEqual(log, ['connect host-mic @1']);

    const changes = mixer.update(buildProgramAudioInputs(state({
      localStream: stream(hostMic),
      people: { amy: 'on-stage' },
      remoteStreams: new Map([['amy', stream(track('amy-mic'))]]),
    })));
    assert.deepEqual(changes.added, ['participant:amy#0']);
    assert.deepEqual(log, ['connect host-mic @1', 'connect amy-mic @1']);
  });

  it('swaps the source when the local mic is switched (new track id)', () => {
    const { graph, log } = fakeGraph();
    const mixer = new ProgramAudioMixer(graph);
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(track('mic-a')) })));
    const changes = mixer.update(buildProgramAudioInputs(state({ localStream: stream(track('mic-b')) })));
    assert.deepEqual(changes.replaced, ['participant:host#0']);
    assert.deepEqual(log, ['connect mic-a @1', 'disconnect mic-a', 'connect mic-b @1']);
    assert.equal(mixer.trackIdFor('participant:host#0'), 'mic-b');
  });

  it('follows a guest who reconnects under a new participant id', () => {
    const { graph, log } = fakeGraph();
    const mixer = new ProgramAudioMixer(graph);
    mixer.update(buildProgramAudioInputs(state({ people: { old: 'on-stage' }, remoteStreams: new Map([['old', stream(track('amy-1'))]]) })));
    const changes = mixer.update(buildProgramAudioInputs(state({ people: { fresh: 'on-stage' }, remoteStreams: new Map([['fresh', stream(track('amy-2'))]]) })));
    assert.deepEqual(changes.removed, ['participant:old#0']);
    assert.deepEqual(changes.added, ['participant:fresh#0']);
    assert.deepEqual(log, ['connect amy-1 @1', 'disconnect amy-1', 'connect amy-2 @1']);
  });

  it('removes a guest sent backstage and drops a track that ended', () => {
    const { graph, log } = fakeGraph();
    const mixer = new ProgramAudioMixer(graph);
    const amy = track('amy-mic');
    mixer.update(buildProgramAudioInputs(state({ people: { amy: 'on-stage' }, remoteStreams: new Map([['amy', stream(amy)]]) })));
    mixer.update(buildProgramAudioInputs(state({ people: { amy: 'backstage' }, remoteStreams: new Map([['amy', stream(amy)]]) })));
    assert.equal(mixer.size, 0);

    const mic = track('host-mic');
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(mic) })));
    mic.readyState = 'ended';
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(mic) })));
    assert.deepEqual(log, ['connect amy-mic @1', 'disconnect amy-mic', 'connect host-mic @1', 'disconnect host-mic']);
  });

  it('applies volume changes live without reconnecting', () => {
    const { graph, log } = fakeGraph();
    const mixer = new ProgramAudioMixer(graph);
    const mic = track('host-mic');
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(mic) })));
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(mic), participantVolumes: { host: 0.25 } })));
    mixer.update(buildProgramAudioInputs(state({ localStream: stream(mic), participantVolumes: { host: 0.25 } })));
    assert.deepEqual(log, ['connect host-mic @1', 'gain host-mic @0.25']);
  });

  it('keeps mixing other inputs when one cannot be connected', () => {
    const { graph } = fakeGraph();
    const mixer = new ProgramAudioMixer(graph);
    const changes = mixer.update(buildProgramAudioInputs(state({
      localStream: stream(track('host-mic')),
      people: { amy: 'on-stage' },
      remoteStreams: new Map([['amy', stream(track('broken-mic'))]]),
    })));
    assert.deepEqual(changes.failed, ['participant:amy#0']);
    assert.deepEqual(mixer.keys(), ['participant:host#0']);
  });
});

describe('program audio controller', () => {
  function controller(inputs: () => ReturnType<typeof buildProgramAudioInputs<FakeTrack>>) {
    const { graph, log } = fakeGraph();
    let built = 0;
    let disposed = 0;
    const output = track('program');
    const ctrl = new ProgramAudioController<FakeTrack>(() => {
      built++;
      const mixer = new ProgramAudioMixer(graph);
      return {
        track: output,
        update: (next) => mixer.update(next),
        clear: () => { mixer.clear(); },
        dispose: () => { disposed++; mixer.clear(); },
      };
    }, inputs);
    return { ctrl, log, counts: () => ({ built, disposed }), output };
  }

  it('builds one graph lazily, shares it, and listens only while leased', () => {
    let current = buildProgramAudioInputs(state({ localStream: stream(track('host-mic')) }));
    const { ctrl, log, counts, output } = controller(() => current);
    ctrl.reconcile();
    assert.equal(counts().built, 0);

    const relay = ctrl.acquire();
    const recording = ctrl.acquire();
    assert.ok(relay && recording);
    assert.equal(counts().built, 1);
    assert.notEqual(relay.track, output);
    assert.notEqual(relay.track, recording.track);

    current = buildProgramAudioInputs(state({ localStream: stream(track('mic-b')) }));
    ctrl.reconcile();
    relay.release();
    relay.release();
    assert.equal(ctrl.activeLeases, 1);
    assert.equal(relay.track.readyState, 'ended');
    assert.equal(recording.track.readyState, 'live');
    assert.equal(output.readyState, 'live');

    recording.release();
    assert.deepEqual(log, ['connect host-mic @1', 'disconnect host-mic', 'connect mic-b @1', 'disconnect mic-b']);
  });

  it('rebuilds after dispose and ignores stale releases', () => {
    const { ctrl, counts } = controller(() => []);
    const stale = ctrl.acquire();
    ctrl.dispose();
    const fresh = ctrl.acquire();
    stale?.release();
    assert.equal(ctrl.activeLeases, 1);
    assert.deepEqual(counts(), { built: 2, disposed: 1 });
    fresh?.release();
    assert.equal(ctrl.activeLeases, 0);
  });

  it('returns null when Web Audio cannot build the graph', () => {
    const ctrl = new ProgramAudioController<FakeTrack>(() => { throw new Error('no audio'); }, () => []);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(ctrl.acquire(), null);
    } finally {
      console.warn = originalWarn;
    }
  });
});
