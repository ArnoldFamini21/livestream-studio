import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getRecordingMediaExportBlockMessage,
  getRecordingMediaExportStatusLabel,
} from '../src/components/RecordingPanel.tsx';

describe('recording media export readiness', () => {
  it('allows MP4 export when media-server health is ready or not yet known', () => {
    assert.equal(getRecordingMediaExportBlockMessage(null), '');
    assert.equal(getRecordingMediaExportBlockMessage({ status: 'ready', message: 'Ready' }), '');
    assert.equal(getRecordingMediaExportStatusLabel(null, true), 'Ready');
    assert.equal(getRecordingMediaExportStatusLabel({ status: 'ready' }, true), 'Ready');
  });

  it('reports checking and blocked states for MP4 export', () => {
    assert.match(
      getRecordingMediaExportBlockMessage({
        status: 'checking',
        message: 'Checking media-server readiness...',
      }),
      /Checking the media-server/
    );
    assert.equal(getRecordingMediaExportStatusLabel({ status: 'checking' }, true), 'Checking');

    assert.equal(
      getRecordingMediaExportBlockMessage({
        status: 'unavailable',
        message: 'Media server is not provisioned on Render.',
      }),
      'Media server is not provisioned on Render.'
    );
    assert.equal(getRecordingMediaExportStatusLabel({ status: 'unavailable' }, true), 'Blocked');
  });

  it('reports disabled when no media-server upload handler is available', () => {
    assert.equal(getRecordingMediaExportStatusLabel({ status: 'ready' }, false), 'Disabled');
  });
});
