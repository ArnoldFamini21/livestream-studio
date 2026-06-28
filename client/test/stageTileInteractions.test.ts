import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getStageTilePrimaryClickAction } from '../src/utils/stageTileInteractions.ts';

describe('stage tile interactions', () => {
  it('spotlights a focusable stage tile on primary click', () => {
    assert.equal(
      getStageTilePrimaryClickAction({
        canFocusTile: true,
        isFocusedTile: false,
        isPipSmallTile: false,
        isLeavingTile: false,
      }),
      'spotlight'
    );
  });

  it('clears spotlight when the focused stage tile is clicked again', () => {
    assert.equal(
      getStageTilePrimaryClickAction({
        canFocusTile: true,
        isFocusedTile: true,
        isPipSmallTile: false,
        isLeavingTile: false,
      }),
      'clear-spotlight'
    );
  });

  it('keeps PiP small tile clicks reserved for cycling PiP corner', () => {
    assert.equal(
      getStageTilePrimaryClickAction({
        canFocusTile: true,
        isFocusedTile: false,
        isPipSmallTile: true,
        isLeavingTile: false,
      }),
      'cycle-pip-corner'
    );
  });

  it('does nothing for leaving or non-focusable tiles', () => {
    assert.equal(
      getStageTilePrimaryClickAction({
        canFocusTile: true,
        isFocusedTile: false,
        isPipSmallTile: false,
        isLeavingTile: true,
      }),
      'none'
    );
    assert.equal(
      getStageTilePrimaryClickAction({
        canFocusTile: false,
        isFocusedTile: false,
        isPipSmallTile: false,
        isLeavingTile: false,
      }),
      'none'
    );
  });
});
