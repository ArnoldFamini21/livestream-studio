import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AiUsageGuard,
  authorizeAiRequest,
} from '../dist/services/aiAccess.js';

describe('AI access and usage budget guard', () => {
  it('enforces concurrent, per-actor, and global hourly request budgets', () => {
    const guard = new AiUsageGuard({
      globalHourlyBudget: 3,
      actorHourlyBudget: 2,
      maxConcurrent: 2,
      windowMs: 60_000,
    });

    const lease1 = guard.acquire('account:1', 1_000);
    assert.equal(lease1.ok, true);
    const lease2 = guard.acquire('account:1', 1_000);
    assert.equal(lease2.ok, true);

    // Concurrency ceiling reached (2 active).
    const concurrentBlocked = guard.acquire('account:2', 1_000);
    assert.equal(concurrentBlocked.ok, false);
    if (!concurrentBlocked.ok) {
      assert.equal(concurrentBlocked.code, 'AI_CONCURRENCY_LIMIT');
      assert.equal(concurrentBlocked.status, 429);
    }

    if (lease1.ok) lease1.release();
    if (lease2.ok) lease2.release();

    // Per-actor hourly limit reached for account:1 (2/2 used).
    const actorBlocked = guard.acquire('account:1', 1_500);
    assert.equal(actorBlocked.ok, false);
    if (!actorBlocked.ok) {
      assert.equal(actorBlocked.code, 'AI_ACTOR_BUDGET_EXCEEDED');
    }

    // Another actor can still use the remaining global slot (3rd of 3).
    const lease3 = guard.acquire('account:2', 1_500);
    assert.equal(lease3.ok, true);
    if (lease3.ok) lease3.release();

    // Global hourly budget reached (3/3 used).
    const globalBlocked = guard.acquire('account:3', 2_000);
    assert.equal(globalBlocked.ok, false);
    if (!globalBlocked.ok) {
      assert.equal(globalBlocked.code, 'AI_GLOBAL_BUDGET_EXCEEDED');
    }

    // Window resets after 60s.
    const afterReset = guard.acquire('account:1', 62_000);
    assert.equal(afterReset.ok, true);
    if (afterReset.ok) afterReset.release();
  });

  it('requires authenticated accounts or operator allowlist when configured', async () => {
    const anonymousReq = { headers: {}, ip: '203.0.113.5' };
    const defaultAuth = await authorizeAiRequest(anonymousReq, {
      env: {},
      resolveAccountUser: async () => null,
    });
    assert.deepEqual(defaultAuth, { ok: true, actorKey: 'ip:203.0.113.5' });

    const blockedAnonymous = await authorizeAiRequest(anonymousReq, {
      env: { OPENAI_REQUIRE_ACCOUNT_AUTH: 'true' },
      resolveAccountUser: async () => null,
    });
    assert.equal(blockedAnonymous.ok, false);
    if (!blockedAnonymous.ok) {
      assert.equal(blockedAnonymous.status, 401);
      assert.equal(blockedAnonymous.code, 'AI_ACCOUNT_REQUIRED');
    }

    const nonEntitledUser = await authorizeAiRequest(anonymousReq, {
      env: { OPENAI_ALLOWED_ACCOUNT_EMAILS: 'producer@example.com' },
      resolveAccountUser: async () => ({ id: 'user-2', email: 'guest@example.com' }),
    });
    assert.equal(nonEntitledUser.ok, false);
    if (!nonEntitledUser.ok) {
      assert.equal(nonEntitledUser.status, 403);
      assert.equal(nonEntitledUser.code, 'AI_ACCOUNT_NOT_ENTITLED');
    }

    const entitledUser = await authorizeAiRequest(anonymousReq, {
      env: { OPENAI_ALLOWED_ACCOUNT_EMAILS: 'producer@example.com' },
      resolveAccountUser: async () => ({ id: 'user-1', email: 'Producer@Example.com' }),
    });
    assert.deepEqual(entitledUser, { ok: true, actorKey: 'account:user-1' });

    const tokenAuth = await authorizeAiRequest(
      { headers: { 'x-studio-ai-token': 'secret-ai-token' }, ip: '203.0.113.5' },
      {
        env: { OPENAI_ACCESS_TOKEN: 'secret-ai-token' },
        resolveAccountUser: async () => null,
      }
    );
    assert.deepEqual(tokenAuth, { ok: true, actorKey: 'token:operator' });
  });
});
