import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHAT_REACTION_TYPES } from '@studio/shared';
import {
  createFloatingReaction,
  REACTION_OVERLAY_DURATION_MS,
  REACTION_OVERLAY_LANES,
} from '../src/components/ReactionOverlay.tsx';

describe('reaction overlay helpers', () => {
  it('creates bounded floating reactions for supported chat reactions', () => {
    const createdAt = 1_800_000_000_000;

    CHAT_REACTION_TYPES.forEach((reaction, index) => {
      const item = createFloatingReaction(reaction, index, createdAt);
      assert.equal(item.reaction, reaction);
      assert.equal(item.createdAt, createdAt);
      assert.ok(REACTION_OVERLAY_LANES.includes(item.lane));
      assert.ok(item.size >= 34);
      assert.ok(item.size <= 46);
      assert.ok(item.delayMs >= 0);
      assert.ok(item.delayMs < REACTION_OVERLAY_DURATION_MS);
      assert.match(item.id, /^reaction-1800000000000-\d+$/);
    });
  });
});
