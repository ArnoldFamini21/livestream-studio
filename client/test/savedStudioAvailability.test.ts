import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NO_STUDIO_SYNC_ISSUES,
  describeStudioSyncIssues,
  getSavedStudioAvailability,
} from '../src/utils/savedStudioAvailability.ts';

const issues = (rejected: string[], failed: string[] = []) => ({
  rejectedStudioIds: new Set(rejected),
  failedStudioIds: new Set(failed),
});

describe('saved studio cards reflect the server', () => {
  it('marks a studio the server no longer knows as unavailable, not Ready', () => {
    const state = getSavedStudioAvailability({ id: 'a' }, issues(['a']));
    assert.equal(state.kind, 'unavailable');
    assert.equal(state.canEnter, false);
  });

  it('shows ended studios as ended', () => {
    assert.equal(getSavedStudioAvailability({ id: 'a', status: 'ended' }, NO_STUDIO_SYNC_ISSUES).label, 'Ended');
  });

  it('keeps Enter for studios that could not be checked', () => {
    const state = getSavedStudioAvailability({ id: 'a' }, issues([], ['a']));
    assert.equal(state.kind, 'unchecked');
    assert.equal(state.canEnter, true);
  });

  it('falls back to the schedule', () => {
    const now = Date.parse('2026-11-06T00:00:00Z');
    assert.equal(getSavedStudioAvailability({ id: 'a', scheduledFor: '2026-11-07T00:00:00Z' }, NO_STUDIO_SYNC_ISSUES, now).label, 'Upcoming');
    assert.equal(getSavedStudioAvailability({ id: 'a', scheduledFor: '2026-11-05T00:00:00Z' }, NO_STUDIO_SYNC_ISSUES, now).label, 'Ready');
    assert.equal(getSavedStudioAvailability({ id: 'a' }, NO_STUDIO_SYNC_ISSUES, now).label, 'Ready');
  });

  it('names the affected studios in the banner', () => {
    const studios = [{ id: 'a', name: 'QA Test Studio' }, { id: 'b', name: 'Pod' }, { id: 'c', name: 'Live' }];
    assert.match(describeStudioSyncIssues(studios, issues(['a']))!, /^"QA Test Studio" is no longer on the studio server/);
    assert.match(describeStudioSyncIssues(studios, issues(['a', 'b']))!, /"QA Test Studio" and "Pod" are no longer/);
    assert.match(describeStudioSyncIssues(studios, issues([], ['c']))!, /Couldn't check "Live"/);
    assert.equal(describeStudioSyncIssues(studios, NO_STUDIO_SYNC_ISSUES), null);
    const many = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, name: `S${n}` }));
    assert.match(describeStudioSyncIssues(many, issues(many.map((s) => s.id)))!, /"S1", "S2" and 3 more/);
  });
});
