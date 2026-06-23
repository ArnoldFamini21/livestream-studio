import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LowerThirdData } from '../src/components/LowerThird.tsx';
import {
  addLowerThird,
  selectAutoSpeakerLowerThirdCandidate,
  normalizeLowerThirdAccentColor,
  normalizeLowerThirdDurationSeconds,
  toggleLowerThirdVisibility,
  upsertAutoSpeakerLowerThird,
} from '../src/utils/lowerThirds.ts';

const existing: LowerThirdData[] = [
  { id: 'lt-1', name: 'Host', title: 'Host', style: 'bold', visible: true },
  { id: 'lt-2', name: 'Guest', title: 'Guest', style: 'minimal', visible: false },
];

describe('lower third visibility utilities', () => {
  it('keeps hidden lower thirds from changing the active overlay', () => {
    const next = addLowerThird(existing, {
      name: 'Producer',
      title: 'Backstage',
      style: 'glass',
    }, 'lt-3');

    assert.deepEqual(
      next.map((item) => [item.id, item.visible]),
      [
        ['lt-1', true],
        ['lt-2', false],
        ['lt-3', false],
      ],
    );
  });

  it('makes a newly visible lower third the only active overlay', () => {
    const next = addLowerThird(existing, {
      name: 'Guest',
      title: 'Guest',
      style: 'bold',
      durationSeconds: 10,
      accentColor: '#0891b2',
      visible: true,
    }, 'lt-3');

    assert.deepEqual(
      next.map((item) => [item.id, item.visible]),
      [
        ['lt-1', false],
        ['lt-2', false],
        ['lt-3', true],
      ],
    );
    assert.equal(next[2].durationSeconds, 10);
    assert.equal(next[2].accentColor, '#0891b2');
  });

  it('toggles one lower third on while hiding the previous one', () => {
    const next = toggleLowerThirdVisibility(existing, 'lt-2');

    assert.deepEqual(
      next.map((item) => [item.id, item.visible]),
      [
        ['lt-1', false],
        ['lt-2', true],
      ],
    );
  });

  it('toggles the active lower third off without changing inactive entries', () => {
    const next = toggleLowerThirdVisibility(existing, 'lt-1');

    assert.deepEqual(
      next.map((item) => [item.id, item.visible]),
      [
        ['lt-1', false],
        ['lt-2', false],
      ],
    );
  });

  it('normalizes timed lower third durations for auto-hide timers', () => {
    assert.equal(normalizeLowerThirdDurationSeconds(undefined), null);
    assert.equal(normalizeLowerThirdDurationSeconds(0), null);
    assert.equal(normalizeLowerThirdDurationSeconds('10'), 10);
    assert.equal(normalizeLowerThirdDurationSeconds(10.4), 10);
    assert.equal(normalizeLowerThirdDurationSeconds(10.5), 11);
    assert.equal(normalizeLowerThirdDurationSeconds(-5), null);
    assert.equal(normalizeLowerThirdDurationSeconds(9999), 3600);
  });

  it('normalizes lower third accent colors to plain six-digit hex values', () => {
    assert.equal(normalizeLowerThirdAccentColor('#0891b2'), '#0891b2');
    assert.equal(normalizeLowerThirdAccentColor(' #DB2777 '), '#db2777');
    assert.equal(normalizeLowerThirdAccentColor('#fff'), undefined);
    assert.equal(normalizeLowerThirdAccentColor('var(--accent)'), undefined);
    assert.equal(normalizeLowerThirdAccentColor('url(https://example.com)'), undefined);
    assert.equal(normalizeLowerThirdAccentColor(null), undefined);
  });

  it('selects the loudest eligible participant for auto speaker lower thirds', () => {
    const speaker = selectAutoSpeakerLowerThirdCandidate([
      { participantId: 'muted', name: 'Muted', title: 'Guest', audioLevel: 90, eligible: false },
      { participantId: 'quiet', name: 'Quiet', title: 'Guest', audioLevel: 8 },
      { participantId: 'host', name: 'Host', title: 'Host', audioLevel: 27 },
      { participantId: 'guest', name: 'Guest', title: 'Guest', audioLevel: 42 },
    ]);

    assert.equal(speaker?.participantId, 'guest');
  });

  it('returns no auto speaker candidate below the minimum level', () => {
    assert.equal(
      selectAutoSpeakerLowerThirdCandidate([
        { participantId: 'host', name: 'Host', title: 'Host', audioLevel: 11 },
      ]),
      null,
    );
  });

  it('upserts a transient auto speaker lower third while hiding existing entries', () => {
    const next = upsertAutoSpeakerLowerThird(existing, {
      participantId: 'guest',
      name: 'Guest',
      title: 'Guest',
    }, 'lt-auto');

    assert.deepEqual(
      next.map((item) => [item.id, item.visible]),
      [
        ['lt-1', false],
        ['lt-2', false],
        ['lt-auto', true],
      ],
    );
    assert.equal(next[2].source, 'auto-speaker');
    assert.equal(next[2].participantId, 'guest');
    assert.equal(next[2].durationSeconds, 5);
  });

  it('reuses the existing auto speaker lower third entry', () => {
    const current: LowerThirdData[] = [
      ...existing,
      { id: 'lt-auto', name: 'Host', title: 'Host', style: 'bold', source: 'auto-speaker', participantId: 'host', durationSeconds: 5, visible: false },
    ];
    const next = upsertAutoSpeakerLowerThird(current, {
      participantId: 'producer',
      name: 'Producer',
      title: 'Co-host',
    }, 'lt-new');

    assert.equal(next.length, 3);
    assert.equal(next[2].id, 'lt-auto');
    assert.equal(next[2].name, 'Producer');
    assert.equal(next[2].participantId, 'producer');
    assert.equal(next[2].visible, true);
  });
});
