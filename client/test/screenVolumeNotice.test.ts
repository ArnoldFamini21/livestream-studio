import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_SCREEN_VOLUME_NOTICE_STATE,
  SHARE_RECONNECT_GRACE_MS,
  decideScreenVolumeAdvice,
  formatViewerHearing,
  listSoundShareKeys,
  markScreenVolumeNoticeAnswered,
  type ScreenVolumeNoticeState,
} from '../src/audio/screenVolumeNotice.ts';
import type { ScreenVolumeView } from '../src/audio/mixControls.ts';

const slider: ScreenVolumeView = { kind: 'slider' };

function step(
  state: ScreenVolumeNoticeState,
  now: number,
  percent: number,
  keys: string[],
  view: ScreenVolumeView = slider
) {
  return decideScreenVolumeAdvice({ view, percent, soundShareKeys: keys, now, state });
}

describe('screen share volume notice', () => {
  it('says what viewers hear in plain words', () => {
    assert.equal(formatViewerHearing(30), 'Viewers hear this screen share at 30%.');
    assert.equal(formatViewerHearing(0), 'Viewers cannot hear this screen share.');
  });

  it('shows the notice and the marker when a share starts below full volume', () => {
    const { advice } = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['local:a']);
    assert.deepEqual(advice.notice, {
      message: 'Viewers hear this screen share at 30%.',
      restoreLabel: 'Set to 100%',
      keepLabel: 'Keep 30%',
    });
    assert.equal(advice.marker?.percent, 30);
    assert.equal(advice.marker?.label, 'Share 30%');
  });

  it('uses the silent wording at zero', () => {
    const { advice } = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 0, ['local:a']);
    assert.equal(advice.notice?.message, 'Viewers cannot hear this screen share.');
    assert.equal(advice.notice?.keepLabel, 'Keep it silent');
    assert.equal(advice.marker?.percent, 0);
  });

  it('shows nothing at full volume, and nothing later if the level drops mid-share', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 100, ['local:a']);
    assert.equal(d.advice.notice, null);
    assert.equal(d.advice.marker, null);
    d = step(d.state, 2000, 40, ['local:a']);
    assert.equal(d.advice.notice, null, 'a level the host just chose needs no warning');
    assert.equal(d.advice.marker?.percent, 40, 'the marker still follows the level');
  });

  it('shows nothing without a share with sound on the program', () => {
    const d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 0, []);
    assert.deepEqual(d.advice, { notice: null, marker: null });
  });

  it('keeps the same notice across renders until it is answered', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['local:a']);
    for (let i = 1; i <= 3; i += 1) d = step(d.state, 1000 + i * 500, 30, ['local:a']);
    assert.ok(d.advice.notice);
  });

  it('does not come back once answered, but the marker stays', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['local:a']);
    d = step(markScreenVolumeNoticeAnswered(d.state), 2000, 30, ['local:a']);
    assert.equal(d.advice.notice, null);
    assert.equal(d.advice.marker?.percent, 30);
    d = step(d.state, 3000, 55, ['local:a']);
    assert.equal(d.advice.notice, null);
    assert.equal(d.advice.marker?.percent, 55);
  });

  it('goes away at 100 and does not return when the level drops again in the same share', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['local:a']);
    d = step(d.state, 2000, 100, ['local:a']);
    assert.deepEqual(d.advice, { notice: null, marker: null });
    d = step(d.state, 3000, 20, ['local:a']);
    assert.equal(d.advice.notice, null);
    assert.equal(d.advice.marker?.percent, 20);
  });

  it('removes both when the share ends and shows a fresh notice for the next share', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 0, ['local:a']);
    d = step(markScreenVolumeNoticeAnswered(d.state), 1500, 0, ['local:a']);
    d = step(d.state, 2000, 0, []);
    assert.deepEqual(d.advice, { notice: null, marker: null });
    d = step(d.state, 2500, 0, ['local:b']);
    assert.equal(d.advice.notice?.message, 'Viewers cannot hear this screen share.');
    assert.equal(d.advice.marker?.percent, 0);
  });

  it('treats a new local share as new even right after the old one stopped', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['local:a']);
    d = step(markScreenVolumeNoticeAnswered(d.state), 1100, 30, ['local:a']);
    d = step(d.state, 1200, 30, []);
    d = step(d.state, 1300, 30, ['local:b']);
    assert.ok(d.advice.notice);
  });

  it('does not repeat the notice when the same remote share reconnects', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['remote:g1']);
    assert.ok(d.advice.notice);
    d = step(d.state, 4000, 30, []);
    assert.equal(d.advice.notice, null);
    d = step(d.state, 4000 + SHARE_RECONNECT_GRACE_MS, 30, ['remote:g1']);
    assert.equal(d.advice.notice, null, 'back within the grace period is the same share');
    assert.equal(d.advice.marker?.percent, 30);
  });

  it('treats a remote share back after the grace period as a new start', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['remote:g1']);
    d = step(d.state, 4000, 30, []);
    d = step(d.state, 4000 + SHARE_RECONNECT_GRACE_MS + 1, 30, ['remote:g1']);
    assert.ok(d.advice.notice);
  });

  it('shows nothing to a co-host who does not run the program, or to a guest', () => {
    for (const view of [{ kind: 'set-by-program-runner' }, { kind: 'hidden' }, { kind: 'no-sound' }] as ScreenVolumeView[]) {
      const d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 0, ['remote:g1'], view);
      assert.deepEqual(d.advice, { notice: null, marker: null }, view.kind);
    }
  });

  it('applies the new stage owner own stored value when the program changes hands', () => {
    // The co-host was not running the program, so they saw nothing while the share ran.
    let coHost = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 100, ['remote:g1'], { kind: 'set-by-program-runner' });
    assert.deepEqual(coHost.advice, { notice: null, marker: null });
    // The host leaves: the co-host now runs the program, with their own stored 25%.
    coHost = step(coHost.state, 5000, 25, ['remote:g1']);
    assert.equal(coHost.advice.notice?.message, 'Viewers hear this screen share at 25%.');
    assert.equal(coHost.advice.marker?.percent, 25);
    // And at 100 they would get nothing.
    const quiet = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 5000, 100, ['remote:g1']);
    assert.deepEqual(quiet.advice, { notice: null, marker: null });
  });

  it('drops the notice when the stage owner role is lost mid-share', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['local:a']);
    d = step(d.state, 2000, 30, ['local:a'], { kind: 'set-by-program-runner' });
    assert.deepEqual(d.advice, { notice: null, marker: null });
  });

  it('forgets shares that have been gone for longer than the grace period', () => {
    let d = step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1000, 30, ['remote:g1']);
    d = step(d.state, 2000, 30, []);
    d = step(d.state, 2000 + SHARE_RECONNECT_GRACE_MS + 1, 30, []);
    assert.deepEqual(d.state, {});
  });

  it('copes with unusable percentages', () => {
    assert.equal(step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1, Number.NaN, ['local:a']).advice.notice, null);
    assert.equal(step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1, -5, ['local:a']).advice.marker?.percent, 0);
    assert.equal(step(EMPTY_SCREEN_VOLUME_NOTICE_STATE, 1, 250, ['local:a']).advice.marker, null);
  });
});

describe('listSoundShareKeys', () => {
  const withAudio = (id: string) => ({ id, getAudioTracks: () => [{ readyState: 'live' }] });
  const noAudio = { id: 'x', getAudioTracks: () => [] };

  it('names the local share by its stream and remote shares by person', () => {
    assert.deepEqual(
      listSoundShareKeys({
        localScreenOnProgram: true,
        localScreenStream: withAudio('s1'),
        myParticipantId: 'me',
        participants: [['a', { status: 'on-stage' }], ['b', { status: 'backstage' }], ['c', { status: 'on-stage' }], ['me', { status: 'on-stage' }]],
        remoteScreenStreams: new Map([['a', withAudio('r1')], ['b', withAudio('r2')], ['c', noAudio], ['me', withAudio('r3')]]),
      }),
      ['local:s1', 'remote:a']
    );
  });

  it('lists nothing for a local share that is off the program or silent', () => {
    const base = { myParticipantId: 'me', participants: [], remoteScreenStreams: new Map() };
    assert.deepEqual(listSoundShareKeys({ ...base, localScreenOnProgram: false, localScreenStream: withAudio('s1') }), []);
    assert.deepEqual(listSoundShareKeys({ ...base, localScreenOnProgram: true, localScreenStream: noAudio }), []);
  });
});
