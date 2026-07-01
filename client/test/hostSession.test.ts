import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  buildHostEntryPath,
  buildHostEntryUrl,
  clearUrlHostToken,
  getHostSession,
  getValidHostToken,
  isLegacyHostlessCreateResponse,
  persistLegacyHostSession,
  persistHostSession,
  readHostTokenFromHash,
  upsertSavedHostStudio,
} from '../src/utils/hostSession.ts';

const ROOM_ID = 'room-123';
const URL_TOKEN = 'urlHostToken_1234567890';
const SESSION_TOKEN = 'sessionHostToken_12345';
const SAVED_TOKEN = 'savedHostToken_123456';

class MemoryStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key) || '' : null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
});

describe('host session links', () => {
  it('builds host entry links with the token in the fragment', () => {
    assert.equal(
      buildHostEntryPath(ROOM_ID, URL_TOKEN),
      `/join/${ROOM_ID}?role=host#hostToken=${encodeURIComponent(URL_TOKEN)}`
    );
    assert.equal(
      buildHostEntryUrl('https://studio.example.com/', ROOM_ID, URL_TOKEN),
      `https://studio.example.com/join/${ROOM_ID}?role=host#hostToken=${encodeURIComponent(URL_TOKEN)}`
    );
  });

  it('reads only valid host tokens from URL fragments', () => {
    assert.equal(readHostTokenFromHash(`#hostToken=${encodeURIComponent(URL_TOKEN)}`), URL_TOKEN);
    assert.equal(readHostTokenFromHash('#hostToken=short'), '');
    assert.equal(readHostTokenFromHash('#other=value'), '');
  });

  it('normalizes host tokens before trusting create-room responses', () => {
    assert.equal(getValidHostToken(URL_TOKEN), URL_TOKEN);
    assert.equal(getValidHostToken(` ${URL_TOKEN} `), URL_TOKEN);
    assert.equal(getValidHostToken(''), '');
    assert.equal(getValidHostToken('short'), '');
    assert.equal(getValidHostToken(undefined), '');
  });

  it('detects legacy create responses that omit host tokens', () => {
    assert.equal(isLegacyHostlessCreateResponse({
      hostToken: undefined,
      hostId: '',
      coHostIds: [],
    }), true);
    assert.equal(isLegacyHostlessCreateResponse({
      id: 'legacy-room',
      name: 'Legacy room',
      hostToken: undefined,
    }), true);
    assert.equal(isLegacyHostlessCreateResponse({
      hostToken: URL_TOKEN,
      id: 'token-room',
      name: 'Token room',
      hostId: '',
      coHostIds: [],
    }), false);
    assert.equal(isLegacyHostlessCreateResponse({
      hostToken: undefined,
    }), false);
  });

  it('uses URL host access ahead of stale session or saved tokens', () => {
    persistHostSession({ roomId: ROOM_ID, hostName: 'Session Host', hostToken: SESSION_TOKEN });
    upsertSavedHostStudio({ id: ROOM_ID, hostName: 'Saved Host', hostToken: SAVED_TOKEN });

    const hostSession = getHostSession(ROOM_ID, URL_TOKEN);

    assert.equal(hostSession?.source, 'url');
    assert.equal(hostSession?.hostToken, URL_TOKEN);
    assert.equal(hostSession?.hostName, 'Saved Host');
  });

  it('ignores obsolete no-token host markers from older browser sessions', () => {
    sessionStorage.setItem('userRole', 'host');
    sessionStorage.setItem('userName', 'Legacy Host');
    sessionStorage.setItem(`legacyHost:${ROOM_ID}`, '1');

    assert.equal(getHostSession(ROOM_ID), null);

    persistHostSession({ roomId: ROOM_ID, hostName: 'Real Host', hostToken: SESSION_TOKEN });

    assert.equal(sessionStorage.getItem(`legacyHost:${ROOM_ID}`), null);
    assert.equal(getHostSession(ROOM_ID)?.hostToken, SESSION_TOKEN);
  });

  it('allows fresh same-tab legacy host sessions for older signaling servers', () => {
    persistLegacyHostSession({ roomId: ROOM_ID, hostName: 'Legacy Host' });

    const hostSession = getHostSession(ROOM_ID);

    assert.equal(hostSession?.source, 'legacy');
    assert.equal(hostSession?.hostName, 'Legacy Host');
    assert.equal(hostSession?.hostToken, '');
  });

  it('strips a restored host token from the visible URL', () => {
    let replacedUrl = '';
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: {
          hash: `#hostToken=${encodeURIComponent(URL_TOKEN)}`,
          pathname: `/join/${ROOM_ID}`,
          search: '?role=host',
        },
        history: {
          replaceState: (_state: unknown, _title: string, url: string) => {
            replacedUrl = url;
          },
        },
      },
      configurable: true,
    });

    clearUrlHostToken();

    assert.equal(replacedUrl, `/join/${ROOM_ID}?role=host`);
  });
});
