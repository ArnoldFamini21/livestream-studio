import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveParticipantRecording } from '../src/utils/participantRecordingSave.ts';

describe('participant recording save destinations', () => {
  it('finishes the progressive cloud copy even when the browser library is full', async () => {
    const quotaError = new DOMException('Storage full', 'QuotaExceededError');
    let finished = false;
    let fullUploads = 0;
    const result = await saveParticipantRecording({
      saveLocal: async () => { throw quotaError; },
      finishProgressive: async () => { finished = true; },
      uploadFull: async () => { fullUploads++; },
    });
    assert.equal(finished, true);
    assert.equal(fullUploads, 0);
    assert.deepEqual(result, { localSaved: false, cloudSaved: true, localError: quotaError });
  });

  it('falls back to a full upload when both local saving and progressive finalization fail', async () => {
    const attempts: string[] = [];
    const result = await saveParticipantRecording({
      saveLocal: async () => { attempts.push('local'); throw new Error('Quota exceeded'); },
      finishProgressive: async () => { attempts.push('progressive'); throw new Error('Partial upload expired'); },
      uploadFull: async () => { attempts.push('full'); },
    });
    assert.deepEqual(attempts, ['local', 'progressive', 'full']);
    assert.equal(result.localSaved, false);
    assert.equal(result.cloudSaved, true);
  });

  it('uploads the full recording after a local failure without a progressive session', async () => {
    let uploaded = false;
    const result = await saveParticipantRecording({
      saveLocal: async () => { throw new Error('IndexedDB unavailable'); },
      uploadFull: async () => { uploaded = true; },
    });
    assert.equal(uploaded, true);
    assert.equal(result.cloudSaved, true);
    assert.equal(result.localSaved, false);
  });

  it('retains successful local saving when the cloud is unavailable', async () => {
    const uploadError = new Error('Offline');
    const result = await saveParticipantRecording({
      saveLocal: async () => {},
      uploadFull: async () => { throw uploadError; },
    });
    assert.deepEqual(result, { localSaved: true, cloudSaved: false, cloudError: uploadError });
  });

  it('does not claim either copy was saved when every destination fails', async () => {
    const result = await saveParticipantRecording({
      saveLocal: async () => { throw new Error('Quota exceeded'); },
      finishProgressive: async () => { throw new Error('Offline'); },
      uploadFull: async () => { throw new Error('Offline'); },
    });
    assert.equal(result.localSaved, false);
    assert.equal(result.cloudSaved, false);
    assert.ok(result.localError);
    assert.ok(result.progressiveError);
    assert.ok(result.cloudError);
  });

  it('avoids uploading a duplicate when the progressive copy is complete', async () => {
    const result = await saveParticipantRecording({
      saveLocal: async () => {},
      finishProgressive: async () => {},
      uploadFull: async () => { throw new Error('Should not upload twice'); },
    });
    assert.deepEqual(result, { localSaved: true, cloudSaved: true });
  });
});
