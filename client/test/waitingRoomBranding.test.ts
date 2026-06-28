import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_WAITING_ROOM_BRANDING,
  MAX_WAITING_ROOM_HEADLINE_LENGTH,
  MAX_WAITING_ROOM_MESSAGE_LENGTH,
  buildStudioBrandingPayload,
  getPersistableWaitingRoomLogoUrl,
  getPersistableWaitingRoomStageBackground,
  normalizeWaitingRoomBranding,
} from '../src/utils/waitingRoomBranding.ts';

describe('waiting room branding', () => {
  it('normalizes copy and display options defensively', () => {
    const normalized = normalizeWaitingRoomBranding({
      headline: ` ${'A'.repeat(MAX_WAITING_ROOM_HEADLINE_LENGTH + 10)} `,
      message: ` ${'B'.repeat(MAX_WAITING_ROOM_MESSAGE_LENGTH + 10)} `,
      backgroundMode: 'studio',
      showLogo: false,
    });

    assert.equal(normalized.headline.length, MAX_WAITING_ROOM_HEADLINE_LENGTH);
    assert.equal(normalized.message.length, MAX_WAITING_ROOM_MESSAGE_LENGTH);
    assert.equal(normalized.backgroundMode, 'studio');
    assert.equal(normalized.showLogo, false);
    assert.deepEqual(normalizeWaitingRoomBranding(null), DEFAULT_WAITING_ROOM_BRANDING);
  });

  it('keeps only guest-safe logo and background sources', () => {
    assert.equal(getPersistableWaitingRoomLogoUrl('blob:https://example.test/logo'), null);
    assert.equal(getPersistableWaitingRoomLogoUrl('javascript:alert(1)'), null);
    assert.equal(
      getPersistableWaitingRoomLogoUrl('data:image/png;base64,abc123'),
      'data:image/png;base64,abc123'
    );
    assert.deepEqual(
      getPersistableWaitingRoomStageBackground({ type: 'image', value: 'blob:https://example.test/background' }),
      { type: 'none', value: '' }
    );
    assert.deepEqual(
      getPersistableWaitingRoomStageBackground({ type: 'gradient', value: 'linear-gradient(#111827, #2563eb)' }),
      { type: 'gradient', value: 'linear-gradient(#111827, #2563eb)' }
    );
  });

  it('builds bounded studio branding payloads for signaling', () => {
    const payload = buildStudioBrandingPayload({
      brandColor: '#2563eb',
      logoUrl: 'https://example.test/logo.png',
      stageBackground: { type: 'color', value: '#0f172a' },
      waitingRoom: {
        headline: 'Back soon',
        message: 'The host is setting up.',
        backgroundMode: 'brand',
        showLogo: true,
      },
      updatedBy: 'host-1',
    });

    assert.equal(payload.brandColor, '#2563eb');
    assert.equal(payload.logoUrl, 'https://example.test/logo.png');
    assert.deepEqual(payload.stageBackground, { type: 'color', value: '#0f172a' });
    assert.equal(payload.waitingRoom.headline, 'Back soon');
    assert.equal(payload.updatedBy, 'host-1');
    assert.ok(payload.updatedAt);
  });
});
