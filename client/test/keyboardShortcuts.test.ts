import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STUDIO_SHORTCUTS,
  formatShortcutKey,
  getLayoutShortcutIndex,
  getShortcutsForRole,
  groupShortcutsByCategory,
  resolveShortcutId,
  shouldIgnoreShortcutTarget,
  withShortcutHint,
} from '../src/utils/keyboardShortcuts.ts';
import {
  getLayoutBarOrder,
  isLayoutBarOptionDisabled,
  MEDIA_SHARE_LAYOUT_ORDER,
  STUDIO_LAYOUT_PRESET_ORDER,
} from '../src/utils/layoutPresets.ts';

describe('resolveShortcutId', () => {
  it('maps number keys to layout bar slots', () => {
    assert.equal(resolveShortcutId({ key: '1' }), 'layout-1');
    assert.equal(resolveShortcutId({ key: '6' }), 'layout-6');
    assert.equal(resolveShortcutId({ key: '7' }), null);
  });

  it('maps letter keys case-insensitively', () => {
    assert.equal(resolveShortcutId({ key: 'm' }), 'toggle-mic');
    assert.equal(resolveShortcutId({ key: 'C' }), 'toggle-camera');
    assert.equal(resolveShortcutId({ key: 's' }), 'toggle-screen-share');
    assert.equal(resolveShortcutId({ key: 'p' }), 'open-people');
    assert.equal(resolveShortcutId({ key: 'i' }), 'open-invite');
  });

  it('needs Shift for actions that change the broadcast', () => {
    assert.equal(resolveShortcutId({ key: 'r' }), null);
    assert.equal(resolveShortcutId({ key: 'R', shiftKey: true }), 'toggle-recording');
    assert.equal(resolveShortcutId({ key: 'l' }), null);
    assert.equal(resolveShortcutId({ key: 'L', shiftKey: true }), 'open-go-live');
    assert.equal(resolveShortcutId({ key: 'A', shiftKey: true }), 'admit-all');
    assert.equal(resolveShortcutId({ key: 'a' }), 'toggle-auto-director');
  });

  it('does not fire a bare-letter shortcut when Shift is held', () => {
    assert.equal(resolveShortcutId({ key: 'M', shiftKey: true }), null);
  });

  it('maps ? (typed with Shift) to the shortcuts help', () => {
    assert.equal(resolveShortcutId({ key: '?', shiftKey: true }), 'show-shortcuts');
    assert.equal(resolveShortcutId({ key: '?' }), 'show-shortcuts');
  });

  it('ignores Ctrl, Cmd and Alt combos', () => {
    assert.equal(resolveShortcutId({ key: 'm', ctrlKey: true }), null);
    assert.equal(resolveShortcutId({ key: '1', metaKey: true }), null);
    assert.equal(resolveShortcutId({ key: 'a', altKey: true }), null);
  });

  it('leaves slide keys to the presentation listener', () => {
    assert.equal(resolveShortcutId({ key: 'ArrowRight' }), null);
    assert.equal(resolveShortcutId({ key: 'ArrowLeft' }), null);
  });

  it('returns null for unmapped or empty keys', () => {
    assert.equal(resolveShortcutId({ key: 'z' }), null);
    assert.equal(resolveShortcutId({ key: '' }), null);
    assert.equal(resolveShortcutId({ key: 'Enter' }), null);
  });

  it('gives guests only their own mic, camera and the help', () => {
    const guest = getShortcutsForRole(false);
    assert.equal(resolveShortcutId({ key: 'm' }, guest), 'toggle-mic');
    assert.equal(resolveShortcutId({ key: 'c' }, guest), 'toggle-camera');
    assert.equal(resolveShortcutId({ key: '?' }, guest), 'show-shortcuts');
    assert.equal(resolveShortcutId({ key: '1' }, guest), null);
    assert.equal(resolveShortcutId({ key: 'R', shiftKey: true }, guest), null);
    assert.equal(resolveShortcutId({ key: 'A', shiftKey: true }, guest), null);
  });
});

describe('shouldIgnoreShortcutTarget', () => {
  it('ignores typing surfaces', () => {
    assert.equal(shouldIgnoreShortcutTarget({ tagName: 'INPUT' }), true);
    assert.equal(shouldIgnoreShortcutTarget({ tagName: 'textarea' }), true);
    assert.equal(shouldIgnoreShortcutTarget({ tagName: 'SELECT' }), true);
    assert.equal(shouldIgnoreShortcutTarget({ isContentEditable: true }), true);
  });

  it('allows shortcuts elsewhere', () => {
    assert.equal(shouldIgnoreShortcutTarget({ tagName: 'BUTTON' }), false);
    assert.equal(shouldIgnoreShortcutTarget({ tagName: 'DIV' }), false);
    assert.equal(shouldIgnoreShortcutTarget(null), false);
    assert.equal(shouldIgnoreShortcutTarget(undefined), false);
  });
});

describe('shortcut definitions', () => {
  it('uses unique ids and unique key + Shift combinations', () => {
    const ids = new Set(STUDIO_SHORTCUTS.map((s) => s.id));
    const combos = new Set(STUDIO_SHORTCUTS.map((s) => `${s.shift ? 'shift+' : ''}${s.key}`));
    assert.equal(ids.size, STUDIO_SHORTCUTS.length);
    assert.equal(combos.size, STUDIO_SHORTCUTS.length);
  });

  it('groups shortcuts by category in a stable order', () => {
    const groups = groupShortcutsByCategory();
    assert.deepEqual(groups.map((g) => g.category), ['You', 'Production', 'Layout', 'Slides', 'Panels']);
    assert.deepEqual(groupShortcutsByCategory(getShortcutsForRole(false)).map((g) => g.category), ['You', 'Panels']);
  });

  it('formats keys for the help and tooltips', () => {
    const find = (id: string) => STUDIO_SHORTCUTS.find((s) => s.id === id)!;
    assert.equal(formatShortcutKey(find('toggle-mic')), 'M');
    assert.equal(formatShortcutKey(find('toggle-recording')), 'Shift + R');
    assert.equal(formatShortcutKey(find('slide-next')), '→ / Space');
    assert.equal(withShortcutHint('Mute', 'toggle-mic'), 'Mute (M)');
    assert.equal(withShortcutHint('Nothing', 'missing'), 'Nothing');
  });

  it('reads the layout slot from a layout shortcut', () => {
    assert.equal(getLayoutShortcutIndex('layout-1'), 0);
    assert.equal(getLayoutShortcutIndex('layout-6'), 5);
    assert.equal(getLayoutShortcutIndex('toggle-mic'), null);
  });
});

describe('layout bar order', () => {
  it('follows the bar that is on screen', () => {
    assert.deepEqual(getLayoutBarOrder(false), STUDIO_LAYOUT_PRESET_ORDER);
    assert.deepEqual(getLayoutBarOrder(true), MEDIA_SHARE_LAYOUT_ORDER);
    assert.equal(MEDIA_SHARE_LAYOUT_ORDER[0], 'single');
  });

  it('disables the same layouts the bar disables', () => {
    assert.equal(isLayoutBarOptionDisabled('single', { isMediaActive: true, participantCount: 1, mediaParticipantCount: 0 }), false);
    assert.equal(isLayoutBarOptionDisabled('grid', { isMediaActive: true, participantCount: 1, mediaParticipantCount: 0 }), true);
    assert.equal(isLayoutBarOptionDisabled('grid', { isMediaActive: true, participantCount: 2, mediaParticipantCount: 1 }), false);
    assert.equal(isLayoutBarOptionDisabled('spotlight', { isMediaActive: false, participantCount: 1 }), true);
    assert.equal(isLayoutBarOptionDisabled('grid', { isMediaActive: false, participantCount: 1 }), false);
  });
});
