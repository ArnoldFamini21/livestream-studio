import assert from 'node:assert/strict';
import { it } from 'node:test';
import { shouldRunCompositor } from '../src/utils/compositorDemand.ts';

it('renders video during offline mixed and local recordings, not only live broadcasts', () => {
  assert.equal(shouldRunCompositor({ live: false, mixRecording: true, localRecording: false }), true);
  assert.equal(shouldRunCompositor({ live: false, mixRecording: false, localRecording: true }), true);
  assert.equal(shouldRunCompositor({ live: true, mixRecording: false, localRecording: false }), true);
  assert.equal(shouldRunCompositor({ live: false, mixRecording: false, localRecording: false }), false);
  assert.equal(shouldRunCompositor({ live: false, mixRecording: false, localRecording: false, programReturn: true }), true);
  assert.equal(shouldRunCompositor({ live: false, mixRecording: false, localRecording: false, programReturn: false }), false);
});

it('warms the program canvas during the recording countdown', () => {
  const idle = { live: false, mixRecording: false, localRecording: false };
  assert.equal(shouldRunCompositor({ ...idle, preparingMixRecording: true }), true);
  assert.equal(shouldRunCompositor({ ...idle, preparingMixRecording: false }), false);
  assert.equal(shouldRunCompositor({ ...idle, preparingMixRecording: false, mixRecording: true }), true);
});
