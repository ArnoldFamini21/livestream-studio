import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  ACCOUNT_SESSION_STORAGE_KEY,
  clearAccountSessionToken,
  fetchAccountSession,
  isValidAccountSessionToken,
  loginAccount,
  logoutAccount,
  readAccountSessionToken,
  registerAccount,
} from '../src/utils/accountAuth.ts';

const TOKEN = 'AccountSessionToken_123456789012345678901234567890';

class LocalStorageMock {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) || null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('account auth client helpers', () => {
  const localStorageMock = new LocalStorageMock();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(() => {
    localStorageMock.clear();
    fetchCalls.length = 0;
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: async (url: string, init: RequestInit = {}) => {
        fetchCalls.push({ url, init });
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse({
            user: {
              id: 'account-1',
              email: 'host@example.com',
              name: 'Arnold',
              createdAt: '2026-07-03T10:00:00.000Z',
              updatedAt: '2026-07-03T10:00:00.000Z',
            },
            session: {
              expiresAt: '2026-08-02T10:00:00.000Z',
            },
          });
        }
        if (url.endsWith('/api/auth/logout')) {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({
          user: {
            id: 'account-1',
            email: 'host@example.com',
            name: 'Arnold',
            createdAt: '2026-07-03T10:00:00.000Z',
            updatedAt: '2026-07-03T10:00:00.000Z',
          },
          session: {
            token: TOKEN,
            expiresAt: '2026-08-02T10:00:00.000Z',
          },
        }, url.endsWith('/api/auth/register') ? 201 : 200);
      },
      configurable: true,
    });
  });

  it('validates and clears local account session tokens', () => {
    localStorage.setItem(ACCOUNT_SESSION_STORAGE_KEY, TOKEN);
    assert.equal(isValidAccountSessionToken(TOKEN), true);
    assert.equal(isValidAccountSessionToken('short'), false);
    assert.equal(readAccountSessionToken(), TOKEN);

    clearAccountSessionToken();
    assert.equal(readAccountSessionToken(), '');
  });

  it('stores account tokens after registration and login responses', async () => {
    const registered = await registerAccount({
      email: 'host@example.com',
      name: 'Arnold',
      password: 'CorrectPassword123',
    });
    assert.equal(registered.session.token, TOKEN);
    assert.equal(readAccountSessionToken(), TOKEN);
    assert.equal(fetchCalls[0].init.credentials, 'include');

    clearAccountSessionToken();
    await loginAccount({
      email: 'host@example.com',
      password: 'CorrectPassword123',
    });
    assert.equal(readAccountSessionToken(), TOKEN);
  });

  it('sends bearer tokens for session restore and logout', async () => {
    localStorage.setItem(ACCOUNT_SESSION_STORAGE_KEY, TOKEN);
    await fetchAccountSession();
    await logoutAccount();

    const sessionHeaders = fetchCalls[0].init.headers as Headers;
    const logoutHeaders = fetchCalls[1].init.headers as Headers;
    assert.equal(sessionHeaders.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(logoutHeaders.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(readAccountSessionToken(), '');
  });
});
