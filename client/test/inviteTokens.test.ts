import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCoHostInviteUrl,
  buildSecureGuestInviteUrl,
  captureInviteTokens,
  clearPendingInviteTokens,
  readInviteTokensFromUrl,
  stripInviteTokensFromUrl,
  type InviteStorage,
} from '../src/utils/inviteTokens.ts';

function memoryStorage(): InviteStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

const TOKEN = 'cohost_invite_token_1234567890';

describe('invite tokens in the URL fragment', () => {
  it('puts the co-host token in the fragment and keeps the role in the query', () => {
    const url = new URL(buildCoHostInviteUrl('https://studio.example.com/join/abc?studio=Show', TOKEN));
    assert.equal(url.searchParams.get('role'), 'co-host');
    assert.equal(url.searchParams.get('studio'), 'Show');
    assert.equal(url.searchParams.has('invite'), false);
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('invite'), TOKEN);
  });

  it('builds a guest link with the token in the fragment', () => {
    const url = new URL(buildSecureGuestInviteUrl('https://studio.example.com/join/abc', TOKEN));
    assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('guestInvite'), TOKEN);
  });

  it('reads fragment tokens and still accepts the query form of older links', () => {
    assert.deepEqual(readInviteTokensFromUrl('?role=co-host', `#invite=${TOKEN}`), { coHost: TOKEN, guest: '' });
    assert.deepEqual(readInviteTokensFromUrl(`?role=co-host&invite=${TOKEN}`, ''), { coHost: TOKEN, guest: '' });
    assert.deepEqual(readInviteTokensFromUrl(`?role=co-host&token=${TOKEN}`, ''), { coHost: TOKEN, guest: '' });
    assert.deepEqual(readInviteTokensFromUrl(`?guestInvite=${TOKEN}`, ''), { coHost: '', guest: TOKEN });
    assert.deepEqual(readInviteTokensFromUrl('?invite=bad token!', ''), { coHost: '', guest: '' });
  });

  it('strips only the invite tokens, keeping the host token fragment and other params', () => {
    assert.equal(
      stripInviteTokensFromUrl({ pathname: '/join/abc', search: `?role=co-host&invite=${TOKEN}`, hash: '#hostToken=h' }),
      '/join/abc?role=co-host#hostToken=h'
    );
    assert.equal(stripInviteTokensFromUrl({ pathname: '/join/abc', search: '?role=co-host', hash: '' }), null);
  });

  it('captures once, removes the token from the address bar, and survives a reload before Join', () => {
    const storage = memoryStorage();
    const replaced: string[] = [];
    const first = captureInviteTokens('abc', { pathname: '/join/abc', search: '?role=co-host', hash: `#invite=${TOKEN}` }, storage, (url) => replaced.push(url));
    assert.deepEqual(first, { coHost: TOKEN, guest: '' });
    assert.deepEqual(replaced, ['/join/abc?role=co-host']);

    // After the reload the address bar no longer carries it; this tab still remembers it.
    const second = captureInviteTokens('abc', { pathname: '/join/abc', search: '?role=co-host', hash: '' }, storage, (url) => replaced.push(url));
    assert.deepEqual(second, { coHost: TOKEN, guest: '' });
    assert.equal(replaced.length, 1);

    // Another studio does not inherit it.
    assert.deepEqual(captureInviteTokens('other', { pathname: '/join/other', search: '', hash: '' }, storage, () => {}), { coHost: '', guest: '' });

    clearPendingInviteTokens('abc', storage);
    assert.equal(storage.data.size, 0);
  });
});
