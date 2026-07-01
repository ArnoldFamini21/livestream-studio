import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StreamDestination } from '@studio/shared';
import { buildLivePreflightChecklist, type LivePreflightSessionHealth } from '../src/utils/livePreflight.ts';

const destination: StreamDestination = {
  id: 'dest-1',
  platform: 'custom',
  name: 'Primary RTMP',
  rtmpUrl: 'rtmps://example.test/live',
  streamKey: 'stream-key',
  enabled: true,
  status: 'idle',
};

const healthySession: LivePreflightSessionHealth = {
  checks: [
    { id: 'signaling', label: 'Studio connection', status: 'good', detail: 'Connected.' },
    { id: 'network', label: 'Network', status: 'good', detail: 'Online.' },
    { id: 'encoding', label: 'Browser encoder', status: 'good', detail: '1080p encoder ready.' },
    { id: 'audio', label: 'Microphone', status: 'good', detail: 'Microphone ready.' },
    { id: 'video', label: 'Camera', status: 'good', detail: 'Camera ready.' },
    { id: 'storage', label: 'Recording storage', status: 'good', detail: 'Storage ready.' },
  ],
};

describe('live preflight checklist', () => {
  it('marks a validated live setup ready', () => {
    const checklist = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'ready', message: 'Media relay is ready.' },
      sessionHealth: healthySession,
      sceneCount: 2,
      outputSummary: 'Landscape 1080p30 at 6 Mbps',
    });

    assert.equal(checklist.status, 'good');
    assert.equal(checklist.blockingIssue, null);
    assert.equal(checklist.warningCount, 0);
    assert.equal(checklist.items.find((item) => item.id === 'encoding')?.status, 'good');
  });

  it('blocks live when no destination is enabled', () => {
    const checklist = buildLivePreflightChecklist({
      destinations: [{ ...destination, enabled: false }],
      relayReadiness: { status: 'ready', message: 'Media relay is ready.' },
      sessionHealth: healthySession,
      sceneCount: 1,
      outputSummary: 'Landscape 720p30',
    });

    assert.equal(checklist.status, 'bad');
    assert.match(checklist.blockingIssue || '', /Enable at least one destination/);
  });

  it('blocks live while the media relay is unavailable or still checking', () => {
    const checking = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'checking', message: 'Checking relay.' },
      sessionHealth: healthySession,
      sceneCount: 1,
      outputSummary: 'Landscape 720p30',
    });
    const unavailable = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'unavailable', message: 'Relay is unavailable.' },
      sessionHealth: healthySession,
      sceneCount: 1,
      outputSummary: 'Landscape 720p30',
    });

    assert.equal(checking.status, 'bad');
    assert.equal(checking.blockingIssue, 'Checking relay.');
    assert.equal(unavailable.status, 'bad');
    assert.equal(unavailable.blockingIssue, 'Relay is unavailable.');
  });

  it('blocks live when the studio connection is down', () => {
    const checklist = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'ready', message: 'Media relay is ready.' },
      sessionHealth: {
        checks: healthySession.checks.map((check) => check.id === 'signaling'
          ? { ...check, status: 'bad', detail: 'Disconnected.' }
          : check),
      },
      sceneCount: 1,
      outputSummary: 'Landscape 720p30',
    });

    assert.equal(checklist.status, 'bad');
    assert.equal(checklist.blockingIssue, 'Disconnected.');
  });

  it('keeps missing scenes and media as review warnings instead of blockers', () => {
    const checklist = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'ready', message: 'Media relay is ready.' },
      sessionHealth: {
        checks: healthySession.checks.map((check) => (
          check.id === 'audio' || check.id === 'video'
            ? { ...check, status: 'bad', detail: 'Missing.' }
            : check
        )),
      },
      sceneCount: 0,
      outputSummary: 'Portrait 1080p30',
    });

    assert.equal(checklist.status, 'warning');
    assert.equal(checklist.blockingIssue, null);
    assert.equal(checklist.items.find((item) => item.id === 'media')?.status, 'warning');
    assert.equal(checklist.items.find((item) => item.id === 'scenes')?.status, 'warning');
  });

  it('warns without blocking when browser encoding readiness is limited', () => {
    const checklist = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'ready', message: 'Media relay is ready.' },
      sessionHealth: {
        checks: healthySession.checks.map((check) => check.id === 'encoding'
          ? {
              ...check,
              status: 'warning',
              detail: 'Use 720p for the most reliable recording and live relay on this browser.',
            }
          : check),
      },
      sceneCount: 1,
      outputSummary: 'Landscape 720p30',
    });

    assert.equal(checklist.status, 'warning');
    assert.equal(checklist.blockingIssue, null);
    assert.equal(checklist.items.find((item) => item.id === 'encoding')?.status, 'warning');
  });

  it('blocks live when browser encoding is unsupported', () => {
    const checklist = buildLivePreflightChecklist({
      destinations: [destination],
      relayReadiness: { status: 'ready', message: 'Media relay is ready.' },
      sessionHealth: {
        checks: healthySession.checks.map((check) => check.id === 'encoding'
          ? {
              ...check,
              status: 'bad',
              detail: 'This browser cannot record or relay WebM chunks.',
            }
          : check),
      },
      sceneCount: 1,
      outputSummary: 'Landscape 720p30',
    });

    assert.equal(checklist.status, 'bad');
    assert.equal(checklist.blockingIssue, 'This browser cannot record or relay WebM chunks.');
    assert.equal(checklist.items.find((item) => item.id === 'encoding')?.blocksStart, true);
  });
});
