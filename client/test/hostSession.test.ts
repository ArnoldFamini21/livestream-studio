import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  buildHostEntryPath,
  buildHostEntryUrl,
  clearUrlHostToken,
  getLegacyHostSession,
  getHostSession,
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

  it('uses URL host access ahead of stale session or saved tokens', () => {
    persistHostSession({ roomId: ROOM_ID, hostName: 'Session Host', hostToken: SESSION_TOKEN });
    upsertSavedHostStudio({ id: ROOM_ID, hostName: 'Saved Host', hostToken: SAVED_TOKEN });

    const hostSession = getHostSession(ROOM_ID, URL_TOKEN);

    assert.equal(hostSession?.source, 'url');
    assert.equal(hostSession?.hostToken, URL_TOKEN);
    assert.equal(hostSession?.hostName, 'Saved Host');
  });

  it('keeps legacy no-token host access scoped to the current browser session', () => {
    persistLegacyHostSession({ roomId: ROOM_ID, hostName: 'Legacy Host' });

    const legacyHostSession = getLegacyHostSession(ROOM_ID);

    assert.equal(legacyHostSession?.roomId, ROOM_ID);
    assert.equal(legacyHostSession?.hostName, 'Legacy Host');
    assert.equal(getHostSession(ROOM_ID), null);
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
