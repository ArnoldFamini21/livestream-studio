import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StreamDestination } from '@studio/shared';
import { decideHeldBanner, getGoLiveBlocker, HELD_ENDED_TEXT } from '../src/utils/heldBroadcastBanner.ts';
import type { HeldWatchState } from '../src/utils/heldBroadcastState.ts';

const youtube = { name: 'YouTube', enabled: true, rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abc' };
const facebook = { name: 'Facebook', enabled: true, rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp', streamKey: 'def' };
const held = (secondsLeft = 150, names = ['YouTube']): HeldWatchState => ({
  phase: 'held',
  secondsLeft,
  destinations: names.map((name) => ({ name, connected: true })),
});

function decide(overrides: Partial<Parameters<typeof decideHeldBanner>[0]> = {}) {
  return decideHeldBanner({
    watch: held(),
    isHost: true,
    isLive: false,
    destinations: [youtube],
    goLiveBlocker: null,
    starting: false,
    ...overrides,
  });
}

describe('decideHeldBanner', () => {
  it('offers Continue with the countdown while a broadcast is held', () => {
    const view = decide();
    assert.equal(view?.kind, 'continue');
    assert.equal(view?.message, 'Your broadcast is still on the air. Viewers see the "be right back" screen. Continue within 2:30.');
    assert.equal(view?.buttonLabel, 'Continue broadcast');
    assert.equal(view?.action, 'continue');
    assert.equal(view?.buttonDisabled, false);
    assert.equal(view?.note, null);
  });

  it('follows the local countdown', () => {
    assert.match(decide({ watch: held(61) })?.message || '', /Continue within 1:01\.$/);
    assert.match(decide({ watch: held(5) })?.message || '', /Continue within 0:05\.$/);
  });

  it('shows nothing to a guest or co-host, and nothing once live by any path', () => {
    assert.equal(decide({ isHost: false }), null);
    assert.equal(decide({ isLive: true }), null);
    assert.equal(decide({ isHost: false, watch: { phase: 'ended' } }), null);
    assert.equal(decide({ isLive: true, watch: { phase: 'ended' } }), null);
  });

  it('shows nothing when nothing is held', () => {
    assert.equal(decide({ watch: { phase: 'idle' } }), null);
  });

  it('says the broadcast ended, with a Dismiss button', () => {
    const view = decide({ watch: { phase: 'ended' } });
    assert.equal(view?.kind, 'ended');
    assert.equal(view?.message, HELD_ENDED_TEXT);
    assert.equal(view?.message, 'The broadcast ended. Press Go Live to start a new one.');
    assert.equal(view?.action, 'dismiss');
    assert.equal(view?.buttonDisabled, false);
  });

  it('asks for the stream key when a remembered destination came back without it', () => {
    const view = decide({ destinations: [{ ...youtube, streamKey: '', enabled: false }] });
    assert.equal(view?.kind, 'needs-key');
    assert.match(view?.message || '', /Paste the stream key for YouTube first/);
    assert.match(view?.message || '', /2:30/);
    assert.equal(view?.action, 'open-destinations');
    assert.equal(view?.buttonDisabled, false);
  });

  it('names every destination that needs its key', () => {
    const view = decide({
      watch: held(100, ['YouTube', 'Facebook']),
      destinations: [{ ...youtube, streamKey: '' }, { ...facebook, streamKey: '  ', enabled: false }],
    });
    assert.match(view?.message || '', /key for YouTube and Facebook first/);
  });

  it('asks for the key of a switched-on destination even when it is not one of the held ones', () => {
    const view = decide({ destinations: [{ ...facebook, streamKey: '' }] });
    assert.equal(view?.kind, 'needs-key');
  });

  it('asks the host to switch a destination on when none is on', () => {
    const view = decide({ destinations: [{ ...youtube, enabled: false }] });
    assert.equal(view?.kind, 'needs-destination');
    assert.equal(view?.action, 'open-destinations');
    assert.match(view?.message || '', /Switch on the places to stream to first/);
    assert.equal(decide({ destinations: [] })?.kind, 'needs-destination');
  });

  it('keeps the button off, with the reason, when Go Live would be refused', () => {
    const view = decide({ goLiveBlocker: 'Media relay readiness check is still running.' });
    assert.equal(view?.kind, 'blocked');
    assert.equal(view?.buttonDisabled, true);
    assert.equal(view?.note, 'Media relay readiness check is still running.');
    assert.match(view?.message || '', /Continue within 2:30/);
  });

  it('keeps the button off for a destination with a bad address', () => {
    const view = decide({ destinations: [{ ...youtube, rtmpUrl: 'http://nope' }] });
    assert.equal(view?.kind, 'blocked');
    assert.equal(view?.buttonDisabled, true);
    assert.match(view?.note || '', /RTMP URL must start with/);
  });

  it('warns when the places to stream to are not the ones on the air', () => {
    const view = decide({ destinations: [youtube, facebook] });
    assert.equal(view?.kind, 'continue');
    assert.match(view?.note || '', /would start a new broadcast instead of continuing/);
    assert.equal(decide({ destinations: [{ ...youtube, name: '  youtube ' }] })?.note, null, 'names compare loosely');
  });

  it('shows the button as busy while the broadcast starts', () => {
    const view = decide({ starting: true });
    assert.equal(view?.buttonDisabled, true);
    assert.equal(view?.buttonLabel, 'Continuing…');
  });
});

describe('getGoLiveBlocker', () => {
  const destination: StreamDestination = {
    id: 'd1', platform: 'custom', name: 'YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abc', enabled: true, status: 'idle',
  };
  const ready = { status: 'ready' as const, message: 'Ready' };
  const goodChecks = ['signaling', 'network', 'encoding', 'audio', 'video', 'turn-relay', 'participant-connections', 'storage']
    .map((id) => ({ id, label: id, status: 'good' as const, detail: 'ok' }));

  it('is null when everything allows Go Live', () => {
    assert.equal(getGoLiveBlocker({ destinations: [destination], relayReadiness: ready, sessionHealth: { checks: goodChecks }, sceneCount: 1 }), null);
  });

  it('says why when the media relay is not ready, as the button does', () => {
    assert.match(getGoLiveBlocker({ destinations: [destination], relayReadiness: { status: 'checking', message: '' }, sessionHealth: { checks: goodChecks }, sceneCount: 1 }) || '', /still running/);
    assert.equal(getGoLiveBlocker({ destinations: [destination], relayReadiness: undefined, sessionHealth: { checks: goodChecks }, sceneCount: 1 }), 'Media relay readiness has not been checked.');
    assert.equal(getGoLiveBlocker({ destinations: [destination], relayReadiness: { status: 'unavailable', message: 'Media server is down.' }, sessionHealth: { checks: goodChecks }, sceneCount: 1 }), 'Media server is down.');
  });

  it('says why when a blocking studio check is bad, or the destinations are not usable', () => {
    const badNetwork = goodChecks.map((check) => (check.id === 'network' ? { ...check, status: 'bad' as const, detail: 'Offline.' } : check));
    assert.equal(getGoLiveBlocker({ destinations: [destination], relayReadiness: ready, sessionHealth: { checks: badNetwork }, sceneCount: 1 }), 'Offline.');
    assert.match(getGoLiveBlocker({ destinations: [{ ...destination, enabled: false }], relayReadiness: ready, sessionHealth: { checks: goodChecks }, sceneCount: 1 }) || '', /Enable at least one destination/);
    assert.match(getGoLiveBlocker({ destinations: [{ ...destination, streamKey: '' }], relayReadiness: ready, sessionHealth: { checks: goodChecks }, sceneCount: 1 }) || '', /Missing stream key/);
  });
});
