import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_STREAM_SCREEN_CONFIG,
  MAX_STREAM_SCREEN_COUNTDOWN_SECONDS,
  MAX_STREAM_SCREEN_HEADLINE_LENGTH,
  MAX_STREAM_SCREEN_MESSAGE_LENGTH,
  buildActiveStreamScreen,
  normalizeStreamScreenConfig,
} from '../src/utils/streamScreens.ts';

describe('stream screens', () => {
  it('normalizes starting and ending screen copy and options', () => {
    const normalized = normalizeStreamScreenConfig({
      starting: {
        headline: ` ${'A'.repeat(MAX_STREAM_SCREEN_HEADLINE_LENGTH + 12)} `,
        message: ` ${'B'.repeat(MAX_STREAM_SCREEN_MESSAGE_LENGTH + 12)} `,
        backgroundMode: 'stage',
        showLogo: false,
        countdownSeconds: MAX_STREAM_SCREEN_COUNTDOWN_SECONDS + 100,
      },
      ending: {
        headline: '  Done  ',
        message: '  Replay available soon  ',
        backgroundMode: 'invalid',
        showLogo: false,
        countdownSeconds: 120,
      },
    });

    assert.equal(normalized.starting.headline.length, MAX_STREAM_SCREEN_HEADLINE_LENGTH);
    assert.equal(normalized.starting.message.length, MAX_STREAM_SCREEN_MESSAGE_LENGTH);
    assert.equal(normalized.starting.backgroundMode, 'stage');
    assert.equal(normalized.starting.showLogo, false);
    assert.equal(normalized.starting.countdownSeconds, MAX_STREAM_SCREEN_COUNTDOWN_SECONDS);
    assert.equal(normalized.ending.headline, 'Done');
    assert.equal(normalized.ending.message, 'Replay available soon');
    assert.equal(normalized.ending.backgroundMode, 'brand');
    assert.equal(normalized.ending.showLogo, false);
    assert.equal(normalized.ending.countdownSeconds, undefined);
  });

  it('falls back to defaults for invalid payloads', () => {
    assert.deepEqual(normalizeStreamScreenConfig(null), DEFAULT_STREAM_SCREEN_CONFIG);
    assert.deepEqual(normalizeStreamScreenConfig({}), DEFAULT_STREAM_SCREEN_CONFIG);
  });

  it('builds brand-backed active stream screens', () => {
    const screen = buildActiveStreamScreen(
      'starting',
      DEFAULT_STREAM_SCREEN_CONFIG,
      {
        brandColor: '#2563eb',
        logoUrl: 'https://example.test/logo.png',
        stageBackground: { type: 'none', value: '' },
      },
      1234
    );

    assert.equal(screen.kind, 'starting');
    assert.equal(screen.brandColor, '#2563eb');
    assert.equal(screen.logoUrl, 'https://example.test/logo.png');
    assert.equal(screen.background.type, 'gradient');
    assert.match(screen.background.value, /#2563eb/);
    assert.equal(screen.activatedAtMs, 1234);
  });

  it('uses safe stage backgrounds and strips transient logos', () => {
    const config = normalizeStreamScreenConfig({
      starting: {
        ...DEFAULT_STREAM_SCREEN_CONFIG.starting,
        backgroundMode: 'stage',
      },
    });

    const screen = buildActiveStreamScreen('starting', config, {
      brandColor: '#0ea5e9',
      logoUrl: 'blob:https://example.test/logo',
      stageBackground: { type: 'image', value: 'blob:https://example.test/background' },
    });

    assert.equal(screen.logoUrl, null);
    assert.equal(screen.background.type, 'gradient');

    const stageScreen = buildActiveStreamScreen('starting', config, {
      brandColor: '#0ea5e9',
      logoUrl: null,
      stageBackground: { type: 'color', value: '#111827' },
    });

    assert.deepEqual(stageScreen.background, { type: 'color', value: '#111827' });

    const videoStageScreen = buildActiveStreamScreen('starting', config, {
      brandColor: '#0ea5e9',
      logoUrl: null,
      stageBackground: { type: 'video', value: 'https://cdn.example.test/background.mp4' },
    });

    assert.equal(videoStageScreen.background.type, 'gradient');
  });
});
