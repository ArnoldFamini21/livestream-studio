import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import {
  authRouter,
  configureAccountAuthStore,
} from '../dist/routes/auth.js';
import { InMemoryAccountAuthStore } from '../dist/services/accountAuth.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function accountBody(overrides = {}) {
  return {
    email: 'host@example.com',
    name: 'Arnold',
    password: 'CorrectPassword123',
    ...overrides,
  };
}

describe('account auth routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '16kb' }));
    app.use('/api/auth', authRouter);
    server = http.createServer(app);
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    configureAccountAuthStore(new InMemoryAccountAuthStore());
  });

  after(async () => {
    configureAccountAuthStore(null);
    if (server) await close(server);
  });

  it('registers accounts and restores sessions with bearer tokens', async () => {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountBody({ email: 'Host@Example.COM' })),
    });
    const registered = await registerResponse.json();

    assert.equal(registerResponse.status, 201);
    assert.equal(registered.user.email, 'host@example.com');
    assert.ok(registered.session.token);
    assert.match(registerResponse.headers.get('set-cookie') || '', /studio_account_session=/);

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${registered.session.token}` },
    });
    const session = await sessionResponse.json();

    assert.equal(sessionResponse.status, 200);
    assert.equal(session.user.id, registered.user.id);
    assert.equal(session.session.expiresAt, registered.session.expiresAt);
  });

  it('logs in and logs out account sessions', async () => {
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountBody()),
    });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'host@example.com',
        password: 'CorrectPassword123',
      }),
    });
    const loggedIn = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.ok(loggedIn.session.token);

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loggedIn.session.token}` },
    });
    assert.equal(logoutResponse.status, 200);

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${loggedIn.session.token}` },
    });
    const session = await sessionResponse.json();
    assert.equal(session.user, null);
  });

  it('rejects duplicate registration and bad login credentials', async () => {
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountBody()),
    });

    const duplicateResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountBody({ name: 'Duplicate' })),
    });
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicate.code, 'ACCOUNT_EMAIL_EXISTS');

    const badLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'host@example.com',
        password: 'WrongPassword123',
      }),
    });
    const badLogin = await badLoginResponse.json();
    assert.equal(badLoginResponse.status, 401);
    assert.equal(badLogin.code, 'ACCOUNT_CREDENTIALS_INVALID');
  });
});
