import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StreamDestination } from '@studio/shared';
import {
  getDefaultRtmpUrl,
  getEnabledDestinationPreflightIssue,
  getStreamDestinationIssue,
  isValidRtmpUrl,
  maskStreamKey,
  MAX_ENABLED_DESTINATIONS,
} from '../src/utils/streamDestinations.ts';

function destination(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1',
    platform: 'custom',
    name: 'Custom RTMP',
    rtmpUrl: 'rtmps://live.example.com/app',
    streamKey: 'secret-stream-key',
    enabled: true,
    status: 'idle',
    ...overrides,
  };
}

describe('stream destination utilities', () => {
  it('returns platform RTMP defaults without storing stream keys', () => {
    assert.equal(getDefaultRtmpUrl('youtube'), 'rtmp://a.rtmp.youtube.com/live2');
    assert.equal(getDefaultRtmpUrl('facebook'), 'rtmps://live-api-s.facebook.com:443/rtmp/');
    assert.equal(getDefaultRtmpUrl('custom'), '');
  });

  it('accepts only RTMP and RTMPS server URLs', () => {
    assert.equal(isValidRtmpUrl('rtmp://live.example.com/app'), true);
    assert.equal(isValidRtmpUrl('rtmps://live.example.com/app'), true);
    assert.equal(isValidRtmpUrl('https://live.example.com/app'), false);
    assert.equal(isValidRtmpUrl('not a url'), false);
  });

  it('validates required custom RTMP fields', () => {
    assert.equal(getStreamDestinationIssue(destination()), null);
    assert.equal(getStreamDestinationIssue(destination({ rtmpUrl: '' })), 'Missing RTMP server URL');
    assert.equal(
      getStreamDestinationIssue(destination({ rtmpUrl: 'https://live.example.com/app' })),
      'RTMP URL must start with rtmp:// or rtmps://',
    );
    assert.equal(getStreamDestinationIssue(destination({ streamKey: '' })), 'Missing stream key');
  });

  it('enforces the three enabled destination preflight limit', () => {
    const enabledDestinations = Array.from({ length: MAX_ENABLED_DESTINATIONS + 1 }, (_, index) => (
      destination({ id: `dest-${index + 1}`, name: `Destination ${index + 1}` })
    ));

    assert.match(
      getEnabledDestinationPreflightIssue(enabledDestinations) || '',
      /Disable 1 destination/,
    );
    assert.equal(getEnabledDestinationPreflightIssue(enabledDestinations.slice(0, MAX_ENABLED_DESTINATIONS)), null);
  });

  it('reports the first enabled destination issue before relay readiness', () => {
    assert.equal(
      getEnabledDestinationPreflightIssue([
        destination({ id: 'dest-1', name: 'YouTube', streamKey: '' }),
        destination({ id: 'dest-2', name: 'Backup' }),
      ], 'Media relay is unavailable.'),
      'YouTube: Missing stream key',
    );
  });

  it('keeps disabled destination issues out of Go Live preflight', () => {
    assert.equal(
      getEnabledDestinationPreflightIssue([
        destination({ id: 'dest-1', name: 'Disabled', streamKey: '', enabled: false }),
        destination({ id: 'dest-2', name: 'Enabled' }),
      ]),
      null,
    );
  });

  it('masks stream keys without exposing full secrets', () => {
    assert.equal(maskStreamKey('abcd'), '••••');
    assert.equal(maskStreamKey('secret-stream-key'), '••••••••••••-key');
  });
});
