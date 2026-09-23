import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import pg from 'pg';
import {
  InMemoryAccountAuthStore,
  PostgresAccountAuthStore,
  changeAccountPassword,
  confirmPasswordReset,
  getAccountSession,
  getAccountSessionPublicId,
  hashAccountSessionToken,
  listAccountSessions,
  loginAccount,
  registerAccount,
  requestPasswordReset,
  revokeAccountSession,
  revokeOtherAccountSessions,
} from '../dist/services/accountAuth.js';
import {
  buildPasswordResetEmail,
  buildPasswordResetLink,
  createAccountMailerFromEnv,
  getPasswordResetUrlBase,
} from '../dist/services/accountMailer.js';
import { authRouter, configureAccountAuthStore, configureAccountMailer } from '../dist/routes/auth.js';

const PASSWORD = 'CorrectPassword123';
const NEW_PASSWORD = 'BrandNewPassword456';
const T0 = new Date('2026-09-23T08:00:00.000Z');
const later = (ms) => new Date(T0.getTime() + ms);

/** Runs the same lifecycle checks against any store implementation. */
function lifecycleSuite(name, makeStore) {
  describe(`account lifecycle (${name})`, () => {
    let store;
    beforeEach(async () => {
      store = await makeStore();
    });

    async function registerWithDevices() {
      const laptop = await registerAccount(store, { email: 'host@example.com', name: 'Host', password: PASSWORD }, T0, { userAgent: 'Laptop Chrome' });
      const phone = await loginAccount(store, { email: 'host@example.com', password: PASSWORD }, later(1000), { userAgent: 'Phone Safari' });
      return { laptop: laptop.session.token, phone: phone.session.token };
    }

    it('lists where the account is signed in without exposing tokens', async () => {
      const { laptop, phone } = await registerWithDevices();
      const sessions = await listAccountSessions(store, laptop, later(2000));
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].current, true);
      assert.equal(sessions[0].userAgent, 'Laptop Chrome');
      assert.equal(sessions[1].userAgent, 'Phone Safari');
      const serialized = JSON.stringify(sessions);
      for (const secret of [laptop, phone, hashAccountSessionToken(laptop), hashAccountSessionToken(phone)]) {
        assert.equal(serialized.includes(secret), false);
      }
      await assert.rejects(() => listAccountSessions(store, 'x'.repeat(43), later(2000)), /Sign in/);
    });

    it('refreshes last-seen at most every five minutes', async () => {
      const { laptop } = await registerWithDevices();
      await getAccountSession(store, laptop, later(60_000));
      let [current] = await listAccountSessions(store, laptop, later(60_000));
      assert.equal(current.lastSeenAt, T0.toISOString());
      await getAccountSession(store, laptop, later(6 * 60_000));
      [current] = await listAccountSessions(store, laptop, later(6 * 60_000));
      assert.equal(current.lastSeenAt, later(6 * 60_000).toISOString());
    });

    it('signs out one device, or every other device', async () => {
      const { laptop, phone } = await registerWithDevices();
      const phoneId = getAccountSessionPublicId(hashAccountSessionToken(phone));
      assert.deepEqual(await revokeAccountSession(store, laptop, phoneId, later(2000)), { revokedCurrent: false });
      assert.equal((await getAccountSession(store, phone, later(3000))).user, null);
      await assert.rejects(() => revokeAccountSession(store, laptop, phoneId, later(3000)), /already ended/);

      const tablet = (await loginAccount(store, { email: 'host@example.com', password: PASSWORD }, later(4000))).session.token;
      assert.deepEqual(await revokeOtherAccountSessions(store, laptop, later(5000)), { ok: true, revoked: 1 });
      assert.equal((await getAccountSession(store, tablet, later(6000))).user, null);
      assert.equal((await getAccountSession(store, laptop, later(6000))).user?.email, 'host@example.com');
    });

    it('cannot revoke another account\'s session', async () => {
      const { laptop } = await registerWithDevices();
      const other = await registerAccount(store, { email: 'other@example.com', name: 'Other', password: PASSWORD }, T0);
      const otherId = getAccountSessionPublicId(hashAccountSessionToken(other.session.token));
      await assert.rejects(() => revokeAccountSession(store, laptop, otherId, later(1000)), /already ended/);
      assert.equal((await getAccountSession(store, other.session.token, later(2000))).user?.email, 'other@example.com');
    });

    it('changes the password with the current one and signs out other devices', async () => {
      const { laptop, phone } = await registerWithDevices();
      await assert.rejects(
        () => changeAccountPassword(store, laptop, { currentPassword: 'WrongPassword123', newPassword: NEW_PASSWORD }, later(2000)),
        /Current password is incorrect/
      );
      await assert.rejects(
        () => changeAccountPassword(store, laptop, { currentPassword: PASSWORD, newPassword: 'short' }, later(2000)),
        /8-128 characters/
      );
      await assert.rejects(
        () => changeAccountPassword(store, laptop, { currentPassword: PASSWORD, newPassword: PASSWORD }, later(2000)),
        /different/
      );
      assert.deepEqual(
        await changeAccountPassword(store, laptop, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, later(2000)),
        { ok: true, signedOutSessions: 1 }
      );
      assert.equal((await getAccountSession(store, phone, later(3000))).user, null);
      assert.equal((await getAccountSession(store, laptop, later(3000))).user?.email, 'host@example.com');
      await assert.rejects(() => loginAccount(store, { email: 'host@example.com', password: PASSWORD }, later(4000)), /incorrect/);
      assert.ok(await loginAccount(store, { email: 'host@example.com', password: NEW_PASSWORD }, later(4000)));
    });

    it('resets a forgotten password once, signing out everywhere', async () => {
      const { laptop, phone } = await registerWithDevices();
      const deliveries = [];
      const deliver = async (delivery) => { deliveries.push(delivery); };

      assert.deepEqual(await requestPasswordReset(store, { email: 'nobody@example.com' }, deliver, later(1000)), { delivered: false });
      assert.equal(deliveries.length, 0);
      assert.deepEqual(await requestPasswordReset(store, { email: 'HOST@example.com' }, deliver, later(1000)), { delivered: true });
      const [{ token, email }] = deliveries;
      assert.equal(email, 'host@example.com');

      const result = await confirmPasswordReset(store, { token, newPassword: NEW_PASSWORD }, later(2000), { userAgent: 'Reset browser' });
      assert.equal(result.user.email, 'host@example.com');
      assert.equal((await getAccountSession(store, result.session.token, later(3000))).user?.email, 'host@example.com');
      for (const old of [laptop, phone]) {
        assert.equal((await getAccountSession(store, old, later(3000))).user, null);
      }
      await assert.rejects(() => confirmPasswordReset(store, { token, newPassword: 'AnotherPassword789' }, later(3000)), /invalid or has expired/);
      assert.ok(await loginAccount(store, { email: 'host@example.com', password: NEW_PASSWORD }, later(4000)));
    });

    it('rejects expired reset links and caps reset emails per hour', async () => {
      await registerWithDevices();
      const deliveries = [];
      const deliver = async (delivery) => { deliveries.push(delivery); };
      for (let i = 0; i < 4; i += 1) {
        await requestPasswordReset(store, { email: 'host@example.com' }, deliver, later(i * 1000));
      }
      assert.equal(deliveries.length, 3, 'the fourth request inside an hour sends nothing');
      await assert.rejects(
        () => confirmPasswordReset(store, { token: deliveries[0].token, newPassword: NEW_PASSWORD }, later(61 * 60_000)),
        /invalid or has expired/
      );
      await requestPasswordReset(store, { email: 'host@example.com' }, deliver, later(62 * 60_000));
      assert.equal(deliveries.length, 4, 'the limit resets after an hour');
    });

    it('cancels outstanding reset links when the password changes', async () => {
      const { laptop } = await registerWithDevices();
      const deliveries = [];
      await requestPasswordReset(store, { email: 'host@example.com' }, async (delivery) => { deliveries.push(delivery); }, later(1000));
      await changeAccountPassword(store, laptop, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, later(2000));
      await assert.rejects(
        () => confirmPasswordReset(store, { token: deliveries[0].token, newPassword: 'AnotherPassword789' }, later(3000)),
        /invalid or has expired/
      );
    });
  });
}

lifecycleSuite('memory', async () => new InMemoryAccountAuthStore());

// Runs against a real database when one is provided, e.g.
// STUDIO_TEST_DATABASE_URL=postgres://studio:studio@127.0.0.1/studio npm run -w server test
const testDatabaseUrl = process.env.STUDIO_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  after(async () => { await pool.end(); });
  lifecycleSuite('postgres', async () => {
    await pool.query('DROP TABLE IF EXISTS studio_account_password_resets, studio_account_sessions, studio_accounts CASCADE');
    // Start from the schema that predates session management, so the
    // migration path used by existing deployments is exercised too.
    await pool.query(`CREATE TABLE studio_accounts (id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
      password_hash text NOT NULL, password_salt text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`);
    await pool.query(`CREATE TABLE studio_account_sessions (token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES studio_accounts(id) ON DELETE CASCADE, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL)`);
    const store = new PostgresAccountAuthStore({ query: (sql, params) => pool.query(sql, params) });
    await store.init();
    await store.init();
    return store;
  });
} else {
  describe('account lifecycle (postgres)', () => {
    it('runs when STUDIO_TEST_DATABASE_URL is set', { skip: 'STUDIO_TEST_DATABASE_URL is not set' }, () => {});
  });
}

describe('account mailer', () => {
  it('builds reset links on the configured client, with the token in the fragment', () => {
    assert.equal(getPasswordResetUrlBase({ CLIENT_URL: 'https://studio.example.test/app' }), 'https://studio.example.test');
    assert.equal(getPasswordResetUrlBase({ ACCOUNT_RESET_URL_BASE: 'https://id.example.test', CLIENT_URL: 'https://x.test' }), 'https://id.example.test');
    assert.equal(getPasswordResetUrlBase({ NODE_ENV: 'production' }), 'https://studio.arnoldfamini.com');
    assert.equal(buildPasswordResetLink('https://studio.example.test/', 'abc_123'), 'https://studio.example.test/reset-password#token=abc_123');
  });

  it('escapes names in the HTML email', () => {
    const email = buildPasswordResetEmail({ email: 'a@b.test', name: '<script>', token: 't', expiresAt: '' }, 'https://x.test/reset-password#token=t');
    assert.ok(!email.html.includes('<script>'));
    assert.ok(email.text.includes('https://x.test/reset-password#token=t'));
  });

  it('picks a provider from the environment', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '' };
    };
    const resend = createAccountMailerFromEnv({ ACCOUNT_EMAIL_FROM: 'Studio <s@x.test>', RESEND_API_KEY: 're_1' }, fakeFetch);
    assert.equal(resend.provider, 'resend');
    await resend.send({ to: 'a@b.test', subject: 'S', text: 'T', html: 'H' });
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_1');
    assert.deepEqual(JSON.parse(calls[0].init.body).to, ['a@b.test']);

    const postmark = createAccountMailerFromEnv({ ACCOUNT_EMAIL_FROM: 's@x.test', POSTMARK_SERVER_TOKEN: 'pm' }, fakeFetch);
    assert.equal(postmark.provider, 'postmark');
    assert.equal(createAccountMailerFromEnv({}, fakeFetch, () => {}).provider, 'console');
    assert.equal(createAccountMailerFromEnv({ NODE_ENV: 'production' }, fakeFetch), null);

    const failing = createAccountMailerFromEnv(
      { ACCOUNT_EMAIL_FROM: 's@x.test', RESEND_API_KEY: 're_1' },
      async () => ({ ok: false, status: 422, text: async () => 'bad from' })
    );
    await assert.rejects(() => failing.send({ to: 'a@b.test', subject: 'S', text: 'T', html: 'H' }), /422: bad from/);
  });
});

describe('account lifecycle routes', () => {
  let server;
  let baseUrl;
  let sent;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    configureAccountMailer(undefined);
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    configureAccountAuthStore(new InMemoryAccountAuthStore());
    sent = [];
    configureAccountMailer({ provider: 'console', send: async (email) => { sent.push(email); } }, 'https://studio.example.test');
  });

  const request = async (method, path, { token, body, userAgent } = {}) => {
    const response = await fetch(`${baseUrl}/api/auth${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json(), headers: response.headers };
  };

  it('manages sessions and passwords over HTTP', async () => {
    const registered = await request('POST', '/register', { body: { email: 'host@example.com', name: 'Host', password: PASSWORD }, userAgent: 'Laptop' });
    const phone = await request('POST', '/login', { body: { email: 'host@example.com', password: PASSWORD }, userAgent: 'Phone' });
    const token = registered.json.session.token;

    const listed = await request('GET', '/sessions', { token });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.sessions.map((session) => [session.userAgent, session.current]), [['Laptop', true], ['Phone', false]]);
    assert.equal(listed.headers.get('cache-control'), 'no-store');

    const phoneId = listed.json.sessions[1].id;
    assert.deepEqual((await request('DELETE', `/sessions/${phoneId}`, { token })).json, { ok: true, revokedCurrent: false });
    assert.equal((await request('GET', '/session', { token: phone.json.session.token })).json.user, null);

    const wrong = await request('POST', '/password', { token, body: { currentPassword: 'nope-nope-nope', newPassword: NEW_PASSWORD } });
    assert.equal(wrong.status, 403);
    const changed = await request('POST', '/password', { token, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    assert.deepEqual(changed.json, { ok: true, signedOutSessions: 0 });

    assert.equal((await request('GET', '/sessions')).status, 401);
  });

  it('answers reset requests the same way for unknown emails and emails the link', async () => {
    await request('POST', '/register', { body: { email: 'host@example.com', name: 'Host', password: PASSWORD } });
    assert.deepEqual((await request('GET', '/capabilities')).json, { passwordReset: true });

    const unknown = await request('POST', '/password-reset/request', { body: { email: 'nobody@example.com' } });
    const known = await request('POST', '/password-reset/request', { body: { email: 'host@example.com' } });
    assert.deepEqual(unknown, { ...known, headers: unknown.headers });
    assert.deepEqual(known.json, { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 1);
    const link = sent[0].text.match(/https:\/\/studio\.example\.test\/reset-password#token=([A-Za-z0-9_-]+)/);
    assert.ok(link, 'the email carries a reset link on the configured client');

    const confirmed = await request('POST', '/password-reset/confirm', { body: { token: link[1], newPassword: NEW_PASSWORD } });
    assert.equal(confirmed.status, 200);
    assert.match(confirmed.headers.get('set-cookie') || '', /studio_account_session=/);
    const reused = await request('POST', '/password-reset/confirm', { body: { token: link[1], newPassword: NEW_PASSWORD } });
    assert.equal(reused.status, 400);
    assert.equal(reused.json.code, 'ACCOUNT_RESET_INVALID');
  });

  it('reports when reset email is not configured', async () => {
    configureAccountMailer(null);
    assert.deepEqual((await request('GET', '/capabilities')).json, { passwordReset: false });
    const response = await request('POST', '/password-reset/request', { body: { email: 'host@example.com' } });
    assert.equal(response.status, 503);
    assert.equal(response.json.code, 'ACCOUNT_RESET_UNAVAILABLE');
  });
});
