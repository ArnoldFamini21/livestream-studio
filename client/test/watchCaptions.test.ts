import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWatchPlaybackTime, selectWatchCaption } from '../src/utils/watchCaptions.ts';

test('captions follow media program time instead of the viewer clock', () => {
  const time = 1_760_000_000_000;
  const hlsDate = new Date(time + 6500);
  const video = { readyState: 4, currentTime: 2, getStartDate: () => new Date(time) } as HTMLVideoElement;
  assert.equal(readWatchPlaybackTime(video, hlsDate), time + 6500);
  assert.equal(readWatchPlaybackTime(video, null), time + 2000);
  assert.equal(readWatchPlaybackTime({ readyState: 4, currentTime: 10 } as HTMLVideoElement, null), null);
  assert.equal(readWatchPlaybackTime({ readyState: 1 } as HTMLVideoElement, hlsDate), null);
  const a = { id: '1', text: 'Good evening', startMs: time + 6000, endMs: time + 8000 };
  const b = { id: '2', text: 'Welcome', startMs: time + 7000, endMs: time + 9000 };
  assert.equal(selectWatchCaption([a, b], time + 5000), null);
  assert.equal(selectWatchCaption([a, b], readWatchPlaybackTime(video, hlsDate)), a);
  assert.equal(selectWatchCaption([a, b], time + 7400), b);
  assert.equal(selectWatchCaption([a, b], time + 9000), null);
});
