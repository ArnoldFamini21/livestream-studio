import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage, ExternalChatStatusPayload } from '@studio/shared';
import {
  formatRelativeTime,
  getExternalChatPlatformMetrics,
} from '../src/utils/externalChatMetrics.ts';

const nowMs = Date.parse('2026-07-04T12:00:00.000Z');

const messages: ChatMessage[] = [
  {
    id: 'yt-public',
    senderId: 'yt-viewer-1',
    senderName: 'YouTube Viewer',
    content: 'Great show',
    timestamp: '2026-07-04T11:59:00.000Z',
    isBackstage: false,
    source: {
      platform: 'youtube',
      externalId: 'yt-1',
      publishedAt: '2026-07-04T11:58:30.000Z',
    },
  },
  {
    id: 'yt-direct-ignored',
    senderId: 'yt-viewer-2',
    senderName: 'Private YouTube Viewer',
    recipientId: 'host',
    recipientName: 'Host',
    content: 'This should not count',
    timestamp: '2026-07-04T11:59:30.000Z',
    isBackstage: false,
    source: {
      platform: 'youtube',
      externalId: 'yt-2',
      publishedAt: '2026-07-04T11:59:30.000Z',
    },
  },
  {
    id: 'fb-public',
    senderId: 'fb-viewer-1',
    senderName: 'Facebook Viewer',
    content: 'Amen',
    timestamp: '2026-07-04T11:57:00.000Z',
    isBackstage: false,
    source: {
      platform: 'facebook',
      externalId: 'fb-1',
      publishedAt: '2026-07-04T11:56:00.000Z',
    },
  },
  {
    id: 'fb-backstage-ignored',
    senderId: 'producer',
    senderName: 'Producer',
    content: 'Do not count backstage',
    timestamp: '2026-07-04T11:55:00.000Z',
    isBackstage: true,
    source: {
      platform: 'facebook',
      externalId: 'fb-2',
      publishedAt: '2026-07-04T11:55:00.000Z',
    },
  },
];

describe('external chat metrics', () => {
  it('formats relative times for operator status cards', () => {
    assert.equal(formatRelativeTime('2026-07-04T11:59:45.000Z', nowMs), 'just now');
    assert.equal(formatRelativeTime('2026-07-04T11:55:00.000Z', nowMs), '5 mins ago');
    assert.equal(formatRelativeTime('2026-07-04T14:00:00.000Z', nowMs), 'in 2 hrs');
    assert.equal(formatRelativeTime('not-a-date', nowMs), '');
  });

  it('counts only public imported comments for the selected platform', () => {
    const status: ExternalChatStatusPayload = {
      platform: 'youtube',
      status: 'connected',
      nextPollAt: '2026-07-04T12:00:20.000Z',
    };
    const metrics = getExternalChatPlatformMetrics(messages, 'youtube', status, nowMs);

    assert.equal(metrics.importedCount, 1);
    assert.equal(metrics.importedLabel, '1 imported');
    assert.equal(metrics.activityLabel, 'Last import 2 mins ago');
    assert.equal(metrics.nextPollLabel, 'Next poll just now');
    assert.equal(metrics.statusLabel, 'connected');
  });

  it('shows waiting and error states before comments arrive', () => {
    assert.deepEqual(
      getExternalChatPlatformMetrics([], 'facebook', { platform: 'facebook', status: 'connecting' }, nowMs),
      {
        platform: 'facebook',
        importedCount: 0,
        importedLabel: '0 imported',
        activityLabel: 'Waiting for first import',
        nextPollLabel: '',
        statusLabel: 'connecting',
      }
    );

    assert.equal(
      getExternalChatPlatformMetrics([], 'youtube', { platform: 'youtube', status: 'error' }, nowMs).activityLabel,
      'Needs attention'
    );
  });
});
