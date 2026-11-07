import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyTalkbackVolumes, getTalkbackKeyAction, TALKBACK_BADGE_TEXT } from '../src/utils/talkback.ts';
import { ProgramAudioMixer, buildProgramAudioInputs } from '../src/audio/programAudioMixer.ts';
import { STUDIO_SHORTCUTS, getShortcutsForRole, resolveShortcutId } from '../src/utils/keyboardShortcuts.ts';

describe('talk backstage volumes', () => {
  it('silences only the talking host, and keeps the same object while off', () => {
    const volumes = { host: 0.8, guest: 1 };
    assert.equal(applyTalkbackVolumes(volumes, 'host', false), volumes);
    assert.equal(applyTalkbackVolumes(volumes, null, true), volumes);
    assert.deepEqual(applyTalkbackVolumes(volumes, 'host', true), { host: 0, guest: 1 });
    assert.deepEqual(volumes, { host: 0.8, guest: 1 }, 'the stored broadcast volume is not changed');
    const silent = { host: 0 };
    assert.equal(applyTalkbackVolumes(silent, 'host', true), silent);
  });

  it('takes the host off the live program mix without reconnecting, and back on', () => {
    const gains: Array<[string, number]> = [];
    let connects = 0;
    const mixer = new ProgramAudioMixer<{ id: string; readyState: string }, string>({
      connectTrack: (track) => { connects += 1; return track.id; },
      setGain: (handle, gain) => { gains.push([handle, gain]); },
      disconnect: () => {},
    });
    const mic = { id: 'host-mic', readyState: 'live' };
    const state = (talking: boolean) => ({
      localParticipant: { id: 'host', status: 'on-stage' },
      localStream: { getAudioTracks: () => [mic] },
      participants: [] as Array<[string, { status: string }]>,
      remoteStreams: new Map(),
      participantVolumes: applyTalkbackVolumes({}, 'host', talking),
    });
    mixer.update(buildProgramAudioInputs(state(false)));
    mixer.update(buildProgramAudioInputs(state(true)));
    mixer.update(buildProgramAudioInputs(state(false)));
    assert.equal(connects, 1);
    assert.deepEqual(gains, [['host-mic', 0], ['host-mic', 1]]);
  });

  it('has a clear off-air badge', () => {
    assert.match(TALKBACK_BADGE_TEXT, /Off air/);
    assert.match(TALKBACK_BADGE_TEXT, /backstage/);
  });
});

describe('push-to-talk key', () => {
  const key = (type: string, extra: Record<string, unknown> = {}) => ({ type, key: 'k', ...extra });

  it('holds on K down and releases on K up', () => {
    assert.equal(getTalkbackKeyAction(key('keydown'), false), 'hold-start');
    assert.equal(getTalkbackKeyAction(key('keydown', { key: 'K', shiftKey: true }), false), null, 'Shift+K is the latch, handled as a shortcut');
    assert.equal(getTalkbackKeyAction(key('keydown', { key: 'K' }), false), 'hold-start', 'Caps Lock still holds');
    assert.equal(getTalkbackKeyAction(key('keydown', { repeat: true }), false), null);
    assert.equal(getTalkbackKeyAction(key('keydown'), true), null);
    assert.equal(getTalkbackKeyAction(key('keyup'), true), 'hold-end');
    assert.equal(getTalkbackKeyAction(key('keyup'), false), null);
  });

  it('ignores typing and modifier combos, but always releases', () => {
    assert.equal(getTalkbackKeyAction(key('keydown', { target: { tagName: 'INPUT' } }), false), null);
    assert.equal(getTalkbackKeyAction(key('keydown', { target: { isContentEditable: true } }), false), null);
    assert.equal(getTalkbackKeyAction(key('keydown', { ctrlKey: true }), false), null);
    assert.equal(getTalkbackKeyAction(key('keydown', { shiftKey: true }), false), null);
    assert.equal(getTalkbackKeyAction(key('keyup', { target: { tagName: 'TEXTAREA' } }), true), 'hold-end');
    assert.equal(getTalkbackKeyAction({ type: 'keydown', key: 'j' }, false), null);
  });

  it('is listed in the shortcut help for hosts only, and Shift+K latches it', () => {
    const hold = STUDIO_SHORTCUTS.find((shortcut) => shortcut.id === 'talkback-hold');
    assert.ok(hold?.display?.includes('K'));
    assert.ok(getShortcutsForRole(true).some((shortcut) => shortcut.id === 'toggle-talkback'));
    assert.ok(!getShortcutsForRole(false).some((shortcut) => shortcut.id.includes('talkback')));
    assert.equal(resolveShortcutId({ key: 'K', shiftKey: true }), 'toggle-talkback');
    assert.equal(resolveShortcutId({ key: 'k' }), null, 'plain K is push-to-talk, not a one-shot shortcut');
  });
});
