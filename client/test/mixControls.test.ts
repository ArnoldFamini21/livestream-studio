import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampPercent,
  collectScreenSharesOnProgram,
  clampSeekTime,
  formatClock,
  gainToPercent,
  getMusicTransportView,
  getScreenVolumeView,
  hasKnownDuration,
  parseSavedGain,
  percentToGain,
  seekStepToTime,
  streamHasLiveAudio,
  timeToSeekStep,
} from '../src/audio/mixControls.ts';

describe('percent and gain', () => {
  it('maps percent to gain and back', () => {
    assert.equal(percentToGain(100), 1);
    assert.equal(percentToGain(50), 0.5);
    assert.equal(percentToGain(0), 0);
    assert.equal(gainToPercent(0.5), 50);
    assert.equal(gainToPercent(1), 100);
  });

  it('clamps out-of-range and unusable values', () => {
    assert.equal(clampPercent(150), 100);
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(33.6), 34);
    assert.equal(percentToGain(NaN), 1);
    assert.equal(percentToGain(undefined), 1);
    assert.equal(percentToGain(Infinity), 1);
    assert.equal(gainToPercent(2), 100);
    assert.equal(gainToPercent(-1), 0);
    assert.equal(gainToPercent(null), 100);
  });

  it('reads a saved gain, defaulting to full volume', () => {
    assert.equal(parseSavedGain('0.4'), 0.4);
    assert.equal(parseSavedGain(0.25), 0.25);
    assert.equal(parseSavedGain('0'), 0);
    assert.equal(parseSavedGain(null), 1);
    assert.equal(parseSavedGain(''), 1);
    assert.equal(parseSavedGain('loud'), 1);
    assert.equal(parseSavedGain('7'), 1);
    assert.equal(parseSavedGain('-3'), 0);
  });
});

describe('clock formatting', () => {
  it('formats m:ss and h:mm:ss', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(5.9), '0:05');
    assert.equal(formatClock(65), '1:05');
    assert.equal(formatClock(600), '10:00');
    assert.equal(formatClock(3599), '59:59');
    assert.equal(formatClock(3600), '1:00:00');
    assert.equal(formatClock(3725), '1:02:05');
  });

  it('never prints broken numbers', () => {
    assert.equal(formatClock(NaN), '0:00');
    assert.equal(formatClock(Infinity), '0:00');
    assert.equal(formatClock(-4), '0:00');
    assert.equal(formatClock(undefined), '0:00');
  });
});

describe('seeking', () => {
  it('knows when a duration is usable', () => {
    assert.equal(hasKnownDuration(180), true);
    assert.equal(hasKnownDuration(0), false);
    assert.equal(hasKnownDuration(NaN), false);
    assert.equal(hasKnownDuration(Infinity), false);
    assert.equal(hasKnownDuration(undefined), false);
  });

  it('clamps seek targets into the track', () => {
    assert.equal(clampSeekTime(-10, 200), 0);
    assert.equal(clampSeekTime(90, 200), 90);
    assert.equal(clampSeekTime(500, 200), 200);
    assert.equal(clampSeekTime(NaN, 200), 0);
    assert.equal(clampSeekTime(90, Infinity), 90);
    assert.equal(clampSeekTime(90, 0), 90);
  });

  it('converts scrub steps and times', () => {
    assert.equal(seekStepToTime(500, 200), 100);
    assert.equal(seekStepToTime(1000, 200), 200);
    assert.equal(seekStepToTime(2000, 200), 200);
    assert.equal(seekStepToTime(-5, 200), 0);
    assert.equal(seekStepToTime(500, Infinity), 0);
    assert.equal(timeToSeekStep(100, 200), 500);
    assert.equal(timeToSeekStep(999, 200), 1000);
    assert.equal(timeToSeekStep(10, 0), 0);
  });
});

describe('music transport view', () => {
  it('shows elapsed, total and remaining for a known length', () => {
    const view = getMusicTransportView({ currentTime: 65.4, duration: 200 });
    assert.equal(view.elapsed, '1:05');
    assert.equal(view.total, '3:20');
    assert.equal(view.remaining, '-2:15');
    assert.equal(view.canSeek, true);
    assert.equal(view.valueText, '1:05 of 3:20, 2:15 remaining');
  });

  it('never shows more elapsed than the length', () => {
    const view = getMusicTransportView({ currentTime: 250, duration: 200 });
    assert.equal(view.elapsed, '3:20');
    assert.equal(view.remaining, '-0:00');
  });

  it('shows elapsed time only when the length is unknown', () => {
    for (const duration of [0, NaN, Infinity]) {
      const view = getMusicTransportView({ currentTime: 42, duration });
      assert.equal(view.elapsed, '0:42');
      assert.equal(view.total, null);
      assert.equal(view.remaining, null);
      assert.equal(view.canSeek, false);
      assert.equal(view.valueText, '0:42 elapsed');
    }
  });
});

describe('which screen volume control shows', () => {
  const sound = { onProgram: true, hasAudio: true };
  const silent = { onProgram: true, hasAudio: false };

  it('shows a slider to the operator running the program when the share has sound', () => {
    assert.deepEqual(getScreenVolumeView({ isOperator: true, runsProgram: true, shares: [sound] }), { kind: 'slider' });
  });

  it('says plainly when the share has no sound', () => {
    assert.deepEqual(getScreenVolumeView({ isOperator: true, runsProgram: true, shares: [silent] }), { kind: 'no-sound' });
  });

  it('shows the slider if any share on the program has sound', () => {
    assert.deepEqual(getScreenVolumeView({ isOperator: true, runsProgram: true, shares: [silent, sound] }), { kind: 'slider' });
  });

  it('ignores shares that are not on the program', () => {
    assert.deepEqual(
      getScreenVolumeView({ isOperator: true, runsProgram: true, shares: [{ onProgram: false, hasAudio: true }] }),
      { kind: 'hidden' }
    );
    assert.deepEqual(getScreenVolumeView({ isOperator: true, runsProgram: true, shares: [] }), { kind: 'hidden' });
  });

  it('hides it from guests', () => {
    assert.deepEqual(getScreenVolumeView({ isOperator: false, runsProgram: false, shares: [sound] }), { kind: 'hidden' });
  });

  it('points a co-host who does not run the program to the one who does', () => {
    assert.deepEqual(
      getScreenVolumeView({ isOperator: true, runsProgram: false, shares: [sound] }),
      { kind: 'set-by-program-runner' }
    );
  });
});

describe('streamHasLiveAudio', () => {
  it('needs a live audio track', () => {
    assert.equal(streamHasLiveAudio(null), false);
    assert.equal(streamHasLiveAudio({ getAudioTracks: () => [] }), false);
    assert.equal(streamHasLiveAudio({ getAudioTracks: () => [{ readyState: 'ended' }] }), false);
    assert.equal(streamHasLiveAudio({ getAudioTracks: () => [{ readyState: 'live' }] }), true);
  });
});

describe('collectScreenSharesOnProgram', () => {
  const withAudio = { getAudioTracks: () => [{ readyState: 'live' }] };
  const noAudio = { getAudioTracks: () => [] };

  it('lists the local share when its tile is on the program', () => {
    assert.deepEqual(
      collectScreenSharesOnProgram({
        localScreenOnProgram: true,
        localScreenStream: withAudio,
        myParticipantId: 'me',
        participants: [],
        remoteScreenStreams: new Map(),
      }),
      [{ onProgram: true, hasAudio: true }]
    );
    assert.deepEqual(
      collectScreenSharesOnProgram({
        localScreenOnProgram: false,
        localScreenStream: withAudio,
        myParticipantId: 'me',
        participants: [],
        remoteScreenStreams: new Map(),
      }),
      []
    );
  });

  it('lists on-stage remote shares only, with or without sound', () => {
    const shares = collectScreenSharesOnProgram({
      localScreenOnProgram: false,
      localScreenStream: null,
      myParticipantId: 'me',
      participants: [
        ['a', { status: 'on-stage' }],
        ['b', { status: 'backstage' }],
        ['c', { status: 'on-stage' }],
        ['me', { status: 'on-stage' }],
      ],
      remoteScreenStreams: new Map([['a', withAudio], ['b', withAudio], ['c', noAudio], ['me', withAudio]]),
    });
    assert.deepEqual(shares, [
      { onProgram: true, hasAudio: true },
      { onProgram: true, hasAudio: false },
    ]);
  });
});
