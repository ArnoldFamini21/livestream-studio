import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Participant } from '@studio/shared';
import {
  NO_PROGRAM_RETURN,
  PROGRAM_RETURN_FPS,
  PROGRAM_RETURN_MAX_BITRATE,
  ProgramReturnPeerSender,
  applyProgramReturnEncoding,
  getProgramReturnDemand,
  getProgramReturnAudioParticipants,
  getProgramReturnLabel,
  getProgramReturnRoute,
  isStageOwner,
  pickProgramReturnStream,
  stageContentNeedsProgramVideo,
  type ProgramReturnSource,
} from '../src/utils/programReturn.ts';
import { createLiveAudioMix } from '../src/audio/liveAudioMix.ts';
import { buildProgramAudioInputs } from '../src/audio/programAudioMixer.ts';

const person = (id: string, role: Participant['role'], status: Participant['status'], joinedAt = '2026-11-07T10:00:00.000Z', capabilities: Participant['capabilities'] = ['program-return']): Participant => ({
  id,
  name: id,
  role,
  status,
  audioEnabled: true,
  videoEnabled: true,
  screenSharing: false,
  joinedAt,
  ...(capabilities ? { capabilities } : {}),
});

describe('program return routing', () => {
  const quiet = { stageNeedsVideo: false };
  const clip = { stageNeedsVideo: true };

  it('never reaches the green room or the operators', () => {
    assert.deepEqual(getProgramReturnRoute(person('w', 'guest', 'green-room'), clip), NO_PROGRAM_RETURN);
    assert.deepEqual(getProgramReturnRoute(person('c', 'co-host', 'backstage'), clip), NO_PROGRAM_RETURN);
    assert.deepEqual(getProgramReturnRoute(person('h', 'host', 'on-stage'), clip), NO_PROGRAM_RETURN);
    assert.deepEqual(getProgramReturnRoute(undefined, clip), NO_PROGRAM_RETURN);
  });

  it('never reaches a peer whose client (or the server) does not understand the program return', () => {
    const { capabilities: _none, ...stale } = person('old', 'guest', 'backstage');
    assert.ok(_none);
    assert.deepEqual(getProgramReturnRoute(stale, clip), NO_PROGRAM_RETURN);
    assert.deepEqual(getProgramReturnRoute(person('t', 'guest', 'backstage', undefined, ['talkback']), clip), NO_PROGRAM_RETURN);
    assert.deepEqual(getProgramReturnDemand(new Map([['old', stale]]), 'host', clip), { video: false, audio: false });
  });

  it('gives backstage guests the picture and the program sound, live or not', () => {
    assert.deepEqual(getProgramReturnRoute(person('b', 'guest', 'backstage'), quiet), { video: true, audio: true });
  });

  it('gives on-stage guests the picture only, and only while a clip is on the program', () => {
    assert.deepEqual(getProgramReturnRoute(person('s', 'guest', 'on-stage'), quiet), NO_PROGRAM_RETURN);
    assert.deepEqual(getProgramReturnRoute(person('s', 'guest', 'on-stage'), clip), { video: true, audio: false });
  });

  it('builds the feed only while someone needs it', () => {
    const participants = new Map<string, Participant>([
      ['host', person('host', 'host', 'on-stage')],
      ['guest', person('guest', 'guest', 'on-stage')],
    ]);
    assert.deepEqual(getProgramReturnDemand(participants, 'host', quiet), { video: false, audio: false });
    assert.deepEqual(getProgramReturnDemand(participants, 'host', clip), { video: true, audio: false });
    participants.set('nica', person('nica', 'guest', 'backstage'));
    assert.deepEqual(getProgramReturnDemand(participants, 'host', quiet), { video: true, audio: true });
    // Our own entry never counts.
    assert.deepEqual(getProgramReturnDemand(new Map([['me', person('me', 'guest', 'backstage')]]), 'me', quiet), { video: false, audio: false });
  });

  it('needs the video for staged media without a mirrored picture', () => {
    assert.equal(stageContentNeedsProgramVideo(null), false);
    assert.equal(stageContentNeedsProgramVideo({ media: null }), false);
    assert.equal(stageContentNeedsProgramVideo({ media: { id: 'clip', type: 'video', name: 'Intro.mp4' } }), true);
    assert.equal(stageContentNeedsProgramVideo({ media: { id: 'deck', type: 'presentation', name: 'Deck', imageId: 'img', slideIndex: 0, slideCount: 3 } }), false);
    assert.equal(stageContentNeedsProgramVideo({ media: { id: 'clip', type: 'video', name: 'x' }, contentHidden: true }), false);
  });
});

describe('stage owner', () => {
  it('is the host, else the first co-host', () => {
    const host = person('host', 'host', 'on-stage', '2026-11-07T11:00:00.000Z');
    const coHost = person('co', 'co-host', 'on-stage', '2026-11-07T09:00:00.000Z');
    assert.equal(isStageOwner(host, [coHost]), true);
    assert.equal(isStageOwner(coHost, [host]), false, 'a co-host never mirrors while the host is in');
    assert.equal(isStageOwner(coHost, []), true);
    assert.equal(isStageOwner(person('g', 'guest', 'on-stage'), []), false);
    assert.equal(isStageOwner(null, [host]), false);
  });

  it('picks the owner feed first', () => {
    const streams = new Map([['co', 'co-feed'], ['host', 'host-feed']]);
    assert.equal(pickProgramReturnStream(streams, 'host'), 'host-feed');
    assert.equal(pickProgramReturnStream(streams, 'missing'), 'co-feed');
    assert.equal(pickProgramReturnStream(new Map(), 'host'), null);
  });

  it('labels the monitor LIVE or Preview', () => {
    assert.equal(getProgramReturnLabel(true), 'LIVE');
    assert.equal(getProgramReturnLabel(false), 'Preview');
  });
});

describe('program return encoding', () => {
  it('caps every encoding near 500 kbps at 15 fps', () => {
    const capped = applyProgramReturnEncoding({ transactionId: 't', encodings: [{ active: true, maxBitrate: 2_500_000 }], codecs: [], headerExtensions: [], rtcp: {} } as unknown as RTCRtpSendParameters);
    assert.equal(capped.encodings[0].maxBitrate, PROGRAM_RETURN_MAX_BITRATE);
    assert.equal(capped.encodings[0].maxFramerate, PROGRAM_RETURN_FPS);
    assert.equal(capped.encodings[0].active, true);
    assert.ok(PROGRAM_RETURN_MAX_BITRATE <= 500_000);
  });
});

// ---- ProgramReturnPeerSender with a fake peer connection ----

interface FakeTrack { id: string; kind: string; readyState: string }

class FakeSender {
  track: FakeTrack | null;
  streams: Array<{ id: string }> = [];
  parameters: { encodings: Array<Record<string, unknown>> } = { encodings: [{}] };
  setParameterCalls = 0;
  constructor(track: FakeTrack | null) { this.track = track; }
  async replaceTrack(track: FakeTrack | null) { this.track = track; }
  setStreams(...streams: Array<{ id: string }>) { this.streams = streams; }
  getParameters() { return JSON.parse(JSON.stringify(this.parameters)); }
  async setParameters(parameters: { encodings: Array<Record<string, unknown>> }) {
    this.setParameterCalls += 1;
    this.parameters = parameters;
  }
}

class FakeTransceiver {
  currentDirection: string | null = null;
  constructor(public sender: FakeSender, public direction: string) {}
}

class FakePeerConnection {
  signalingState = 'stable';
  transceivers: FakeTransceiver[] = [];
  constructor(private readonly log: string[]) {}
  initLog: Array<Record<string, unknown>> = [];
  addTransceiver(track: FakeTrack, init: { direction: string; streams: Array<{ id: string }>; sendEncodings?: unknown[] }) {
    this.initLog.push(init);
    this.log.push(`add:${track.kind}`);
    const sender = new FakeSender(track);
    sender.streams = init.streams;
    const transceiver = new FakeTransceiver(sender, init.direction);
    this.transceivers.push(transceiver);
    return transceiver;
  }
}

function setup() {
  const log: string[] = [];
  const pc = new FakePeerConnection(log);
  const sender = new ProgramReturnPeerSender(pc as unknown as RTCPeerConnection, (streamId) => log.push(`announce:${streamId}`));
  const video: FakeTrack = { id: 'v1', kind: 'video', readyState: 'live' };
  const audio: FakeTrack = { id: 'a1', kind: 'audio', readyState: 'live' };
  const source = { stream: { id: 'program-stream' }, video, audio } as unknown as ProgramReturnSource;
  return { log, pc, sender, source, video, audio };
}

describe('ProgramReturnPeerSender', () => {
  it('names the stream before attaching the backstage feed, and caps the picture', async () => {
    const { log, pc, sender, source } = setup();
    await sender.sync(source, { video: true, audio: true });
    assert.deepEqual(log, ['announce:program-stream', 'add:video', 'add:audio']);
    assert.equal(pc.transceivers[0].direction, 'sendonly');
    assert.deepEqual(pc.transceivers[0].sender.streams, [{ id: 'program-stream' }]);
    assert.equal(pc.transceivers[0].sender.parameters.encodings[0].maxBitrate, PROGRAM_RETURN_MAX_BITRATE);
    assert.equal(sender.sending, true);
    assert.deepEqual(pc.initLog[0].sendEncodings, [{ maxBitrate: PROGRAM_RETURN_MAX_BITRATE, maxFramerate: PROGRAM_RETURN_FPS }], 'capped from the first frame');
    assert.equal(pc.initLog[1].sendEncodings, undefined);
  });

  it('sends on-stage guests the picture without the program sound', async () => {
    const { log, sender, source } = setup();
    await sender.sync(source, { video: true, audio: false });
    assert.deepEqual(log, ['announce:program-stream', 'add:video']);
    assert.equal(sender.audioTransceiver, null);
  });

  it('pauses and resumes on the same transceivers without announcing again', async () => {
    const { log, pc, sender, source } = setup();
    await sender.sync(source, { video: true, audio: true });
    await sender.sync(source, NO_PROGRAM_RETURN);
    assert.equal(pc.transceivers[0].sender.track, null);
    assert.equal(pc.transceivers[0].direction, 'inactive');
    assert.equal(pc.transceivers[1].direction, 'inactive');
    assert.equal(sender.sending, false);
    await sender.sync(source, { video: true, audio: true });
    assert.deepEqual(log, ['announce:program-stream', 'add:video', 'add:audio'], 'no new transceivers, no second announcement');
    assert.equal(pc.transceivers[0].direction, 'sendonly');
    assert.equal(pc.transceivers[0].sender.track?.id, 'v1');
  });

  it('serializes bursts so a peer never gets two program transceivers', async () => {
    const { pc, sender, source } = setup();
    await Promise.all([
      sender.sync(source, { video: true, audio: true }),
      sender.sync(source, { video: true, audio: true }),
      sender.sync(source, { video: true, audio: false }),
    ]);
    assert.equal(pc.transceivers.length, 2);
    assert.equal(pc.transceivers[1].direction, 'inactive', 'the last call (no audio) wins');
  });

  it('sends nothing without a live picture, and nothing to audio-only routes', async () => {
    const { log, sender, source, video } = setup();
    await sender.sync(source, { video: false, audio: true });
    video.readyState = 'ended';
    await sender.sync(source, { video: true, audio: true });
    await sender.sync(null, { video: true, audio: true });
    assert.deepEqual(log, []);
  });

  it('stops touching a closed or disposed connection', async () => {
    const { log, pc, sender, source } = setup();
    pc.signalingState = 'closed';
    await sender.sync(source, { video: true, audio: true });
    pc.signalingState = 'stable';
    sender.dispose();
    await sender.sync(source, { video: true, audio: true });
    assert.deepEqual(log, []);
  });

  it('applies the cap once encodings exist after negotiation', async () => {
    const { pc, sender, source } = setup();
    await sender.sync(source, { video: true, audio: false });
    const videoSender = pc.transceivers[0].sender;
    const calls = videoSender.setParameterCalls;
    await sender.refreshLimits();
    assert.equal(videoSender.setParameterCalls, calls, 'already capped: no extra setParameters');
    videoSender.parameters = { encodings: [{ maxBitrate: 3_000_000 }] };
    await sender.refreshLimits();
    assert.equal(videoSender.parameters.encodings[0].maxBitrate, PROGRAM_RETURN_MAX_BITRATE);
  });
});

describe('program return audio', () => {
  function fakeBus() {
    const outputTrack = { id: 'out', kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; }, clone() { return this; } };
    const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, offset: { value: 0 }, gain: { value: 0 } });
    const context = {
      createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [outputTrack] } }),
      createConstantSource: node,
      createGain: node,
      createOscillator: node,
    };
    const connections: string[] = [];
    return {
      connections,
      bus: {
        getContext: () => context as unknown as AudioContext,
        connectOutput: () => {
          connections.push('connect');
          return () => connections.push('disconnect');
        },
      },
    };
  }

  it('leaves the media bus out of the program return mix', () => {
    const withBus = fakeBus();
    createLiveAudioMix(withBus.bus).dispose();
    assert.deepEqual(withBus.connections, ['connect', 'disconnect']);
    const withoutBus = fakeBus();
    createLiveAudioMix(withoutBus.bus, { includeBus: false }).dispose();
    assert.deepEqual(withoutBus.connections, []);
  });

  it('carries only the on-stage guests, never our own mic or screen sound', () => {
    const track = (id: string) => ({ id, readyState: 'live' });
    const stream = (...ids: string[]) => ({ getAudioTracks: () => ids.map(track) });
    const inputs = buildProgramAudioInputs({
      localParticipant: { id: 'host', status: 'on-stage' },
      localStream: null,
      localScreenStream: null,
      participants: [['host', { status: 'on-stage' }], ['maria', { status: 'on-stage' }], ['nica', { status: 'backstage' }]],
      remoteStreams: new Map([['maria', stream('maria-mic')], ['nica', stream('nica-mic')]]),
      remoteScreenStreams: new Map([['maria', stream('maria-tab')]]),
      participantVolumes: {},
    });
    assert.deepEqual(inputs.map((input) => input.track.id), ['maria-mic', 'maria-tab']);
  });

  it('leaves on-stage co-hosts out of the return, since the mesh already brings them to the backstage', () => {
    const track = (id: string) => ({ id, readyState: 'live' });
    const stream = (...ids: string[]) => ({ getAudioTracks: () => ids.map(track) });
    const participants = new Map<string, Participant>([
      ['cohost', person('cohost', 'co-host', 'on-stage')],
      ['maria', person('maria', 'guest', 'on-stage')],
      ['nica', person('nica', 'guest', 'backstage')],
    ]);
    const filtered = getProgramReturnAudioParticipants(participants);
    const inputs = buildProgramAudioInputs({
      localParticipant: { id: 'host', status: 'on-stage' },
      localStream: null,
      localScreenStream: null,
      participants: filtered,
      remoteStreams: new Map([['cohost', stream('cohost-mic')], ['maria', stream('maria-mic')]]),
      remoteScreenStreams: new Map([['cohost', stream('cohost-tab')]]),
      participantVolumes: {},
    });
    assert.deepEqual(inputs.map((input) => input.track.id), ['maria-mic']);
    assert.equal(participants.size, 3, 'the studio map is not changed');
    const guestsOnly = new Map([['maria', person('maria', 'guest', 'on-stage')]]);
    assert.equal(getProgramReturnAudioParticipants(guestsOnly), guestsOnly);
  });
});
