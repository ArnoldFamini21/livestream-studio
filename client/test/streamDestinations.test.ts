import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StreamDestination } from '@studio/shared';
import {
  getPlatformOrientationWarning,
  getDefaultRtmpUrl,
  getEnabledDestinationPreflightIssue,
  getStreamPlatformGuide,
  getStreamDestinationIssue,
  isValidRtmpUrl,
  maskStreamKey,
  MAX_ENABLED_DESTINATIONS,
  STREAM_PLATFORM_GUIDES,
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

  it('keeps StreamYard-style platform setup guides in a stable order', () => {
    assert.deepEqual(
      STREAM_PLATFORM_GUIDES.map((guide) => guide.platform),
      ['youtube', 'facebook', 'twitch', 'kick', 'linkedin', 'x', 'tiktok', 'instagram', 'vimeo', 'custom'],
    );
    assert.equal(getStreamPlatformGuide('instagram').recommendedOrientation, 'portrait');
    assert.equal(getStreamPlatformGuide('tiktok').recommendedOrientation, 'portrait');
    assert.equal(getStreamPlatformGuide('custom').rtmpUrlEditable, true);
    assert.equal(getStreamPlatformGuide('youtube').rtmpUrlEditable, false);
    // Unknown platforms (an old saved entry) fall back to custom RTMP.
    assert.equal(getStreamPlatformGuide('nope' as StreamDestination['platform']).platform, 'custom');
  });

  it('gives every preset a valid server URL or an editable per-event URL, plus help text', () => {
    for (const guide of STREAM_PLATFORM_GUIDES) {
      assert.ok(guide.rtmpUrlTemplate.trim(), `${guide.platform} template`);
      assert.ok(guide.rtmpUrlHelp.trim(), `${guide.platform} URL help`);
      assert.ok(guide.setupSteps.length >= 2, `${guide.platform} steps`);
      if (guide.defaultRtmpUrl) {
        assert.equal(isValidRtmpUrl(guide.defaultRtmpUrl), true, `${guide.platform} default`);
      } else {
        // No default means the platform issues one per event, so the host must be able to paste it.
        assert.equal(guide.rtmpUrlEditable, true, `${guide.platform} must be editable`);
      }
      if (!guide.rtmpUrlEditable) assert.ok(guide.defaultRtmpUrl, `${guide.platform} fixed URL`);
    }
    // Per-event server URLs: nothing to prefill.
    assert.equal(getDefaultRtmpUrl('linkedin'), '');
    assert.equal(getDefaultRtmpUrl('tiktok'), '');
    assert.match(getDefaultRtmpUrl('kick'), /^rtmps:\/\/.+live-video\.net:443\/app\/$/);
    assert.match(getDefaultRtmpUrl('x'), /^rtmps:\/\/.+pscp\.tv:443\/x$/);
    assert.match(getDefaultRtmpUrl('vimeo'), /^rtmps:\/\/rtmp-global\.cloud\.vimeo\.com:443\/live$/);
    assert.ok(getStreamPlatformGuide('tiktok').requirement);
    assert.ok(getStreamPlatformGuide('vimeo').requirement);
  });

  it('warns when the selected platform orientation does not match the output', () => {
    assert.match(
      getPlatformOrientationWarning('instagram', 'landscape') || '',
      /portrait-first/,
    );
    assert.match(getPlatformOrientationWarning('tiktok', 'landscape') || '', /TikTok Live is portrait-first/);
    assert.equal(getPlatformOrientationWarning('tiktok', 'portrait'), null);
    assert.equal(getPlatformOrientationWarning('instagram', 'portrait'), null);
    assert.match(getPlatformOrientationWarning('kick', 'portrait') || '', /Kick is usually best in 16:9/);
    assert.match(
      getPlatformOrientationWarning('youtube', 'portrait') || '',
      /16:9 landscape/,
    );
    assert.equal(getPlatformOrientationWarning('custom', 'portrait'), null);
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

  it('enforces the eight enabled destination preflight limit', () => {
    assert.equal(MAX_ENABLED_DESTINATIONS, 8);
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
