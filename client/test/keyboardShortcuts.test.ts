import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STUDIO_SHORTCUTS,
  groupShortcutsByCategory,
  resolveShortcutId,
  shouldIgnoreShortcutTarget,
} from '../src/utils/keyboardShortcuts.ts';

describe('resolveShortcutId', () => {
  it('maps number keys to layout actions', () => {
    assert.equal(resolveShortcutId({ key: '1' }), 'layout-grid');
    assert.equal(resolveShortcutId({ key: '2' }), 'layout-spotlight');
    assert.equal(resolveShortcutId({ key: '5' }), 'layout-single');
  });

  it('maps letter keys case-insensitively to production actions', () => {
    assert.equal(resolveShortcutId({ key: 'm' }), 'toggle-mic');
    assert.equal(resolveShortcutId({ key: 'M' }), 'toggle-mic');
    assert.equal(resolveShortcutId({ key: 'A' }), 'toggle-auto-director');
    assert.equal(resolveShortcutId({ key: 'C' }), 'toggle-camera');
  });

  it('maps the ? key to the shortcuts help', () => {
    assert.equal(resolveShortcutId({ key: '?' }), 'show-shortcuts');
  });

  it('ignores keys with modifier combos', () => {
    assert.equal(resolveShortcutId({ key: 'm', ctrlKey: true }), null);
    assert.equal(resolveShortcutId({ key: '1', metaKey: true }), null);
    assert.equal(resolveShortcutId({ key: 'a', altKey: true }), null);
  });

  it('returns null for unmapped or empty keys', () => {
    assert.equal(resolveShortcutId({ key: 'z' }), null);
    assert.equal(resolveShortcutId({ key: '' }), null);
    assert.equal(resolveShortcutId({ key: 'Enter' }), null);
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
  it('uses unique ids and keys', () => {
    const ids = new Set(STUDIO_SHORTCUTS.map((s) => s.id));
    const keys = new Set(STUDIO_SHORTCUTS.map((s) => s.key));
    assert.equal(ids.size, STUDIO_SHORTCUTS.length);
    assert.equal(keys.size, STUDIO_SHORTCUTS.length);
  });

  it('groups shortcuts by category in a stable order', () => {
    const groups = groupShortcutsByCategory();
    assert.deepEqual(groups.map((g) => g.category), ['Layout', 'Production']);
    assert.ok(groups[0].shortcuts.every((s) => s.category === 'Layout'));
    assert.ok(groups[1].shortcuts.length >= 1);
  });
});
