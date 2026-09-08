import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createPasswordVerifier,
  getAccountSession,
  getPostgresAccountAuthConfig,
  hashAccountSessionToken,
  InMemoryAccountAuthStore,
  loginAccount,
  logoutAccount,
  PostgresAccountAuthStore,
  registerAccount,
  verifyAccountPassword,
} from '../dist/services/accountAuth.js';

class FakeDb {
  users = new Map();
  sessions = new Map();
  queries = [];
  closed = false;

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalizedSql = sql.trim().replace(/\s+/g, ' ').toUpperCase();

    if (normalizedSql.startsWith('INSERT INTO STUDIO_ACCOUNTS')) {
      const [id, email, name, passwordHash, passwordSalt, createdAt, updatedAt] = params;
      if (Array.from(this.users.values()).some((user) => user.email === email)) {
        const err = new Error('duplicate email');
        err.code = '23505';
        throw err;
      }
      this.users.set(id, {
        id,
        email,
        name,
        password_hash: passwordHash,
        password_salt: passwordSalt,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }

    if (normalizedSql.startsWith('SELECT * FROM STUDIO_ACCOUNTS WHERE EMAIL')) {
      return {
        rows: Array.from(this.users.values()).filter((user) => user.email === params[0]).slice(0, 1),
      };
    }

    if (normalizedSql.startsWith('SELECT * FROM STUDIO_ACCOUNTS WHERE ID')) {
      return {
        rows: this.users.has(params[0]) ? [this.users.get(params[0])] : [],
      };
    }

    if (normalizedSql.startsWith('INSERT INTO STUDIO_ACCOUNT_SESSIONS')) {
      const [tokenHash, userId, createdAt, expiresAt] = params;
      this.sessions.set(tokenHash, {
        token_hash: tokenHash,
        user_id: userId,
        created_at: createdAt,
        expires_at: expiresAt,
      });
    }

    if (normalizedSql.startsWith('SELECT * FROM STUDIO_ACCOUNT_SESSIONS')) {
      return {
        rows: this.sessions.has(params[0]) ? [this.sessions.get(params[0])] : [],
      };
    }

    if (normalizedSql.startsWith('DELETE FROM STUDIO_ACCOUNT_SESSIONS')) {
      this.sessions.delete(params[0]);
    }

    return { rows: [] };
  }

  async end() {
    this.closed = true;
  }
}

describe('account auth configuration', () => {
  it('uses configured PostgreSQL URLs and can be disabled explicitly', () => {
    assert.equal(getPostgresAccountAuthConfig({}), null);
    assert.equal(
      getPostgresAccountAuthConfig({
        DATABASE_URL: 'postgres://example',
        ACCOUNT_AUTH_PERSISTENCE_DISABLED: 'yes',
      }),
      null
    );
    assert.deepEqual(
      getPostgresAccountAuthConfig({
        POSTGRES_URL: 'postgres://example',
        PGSSLMODE: 'require',
      }),
      {
        connectionString: 'postgres://example',
        ssl: { rejectUnauthorized: false },
      }
    );
  });
});

describe('account password verifier', () => {
  it('verifies matching passwords without storing the raw password', () => {
    const verifier = createPasswordVerifier('CorrectPassword123');
    const record = {
      id: 'account-1',
      email: 'host@example.com',
      name: 'Host',
      createdAt: '2026-07-03T10:00:00.000Z',
      updatedAt: '2026-07-03T10:00:00.000Z',
      ...verifier,
    };

    assert.notEqual(verifier.passwordHash, 'CorrectPassword123');
    assert.equal(verifyAccountPassword(record, 'CorrectPassword123'), true);
    assert.equal(verifyAccountPassword(record, 'WrongPassword123'), false);
  });
});

describe('InMemoryAccountAuthStore', () => {
  it('registers, logs in, reads sessions, and logs out accounts', async () => {
    const store = new InMemoryAccountAuthStore();
    const registered = await registerAccount(store, {
      email: 'Host@Example.COM',
      name: 'Arnold',
      password: 'CorrectPassword123',
    }, new Date('2026-07-03T10:00:00.000Z'));

    assert.equal(registered.user.email, 'host@example.com');
    assert.equal(registered.user.name, 'Arnold');
    assert.ok(registered.session.token.length >= 32);
    assert.equal((await getAccountSession(store, registered.session.token, new Date('2026-07-03T10:01:00.000Z'))).user?.id, registered.user.id);

    const loggedIn = await loginAccount(store, {
      email: 'host@example.com',
      password: 'CorrectPassword123',
    }, new Date('2026-07-03T11:00:00.000Z'));
    assert.equal(loggedIn.user.id, registered.user.id);
    assert.notEqual(loggedIn.session.token, registered.session.token);

    await logoutAccount(store, loggedIn.session.token);
    assert.equal((await getAccountSession(store, loggedIn.session.token, new Date('2026-07-03T11:01:00.000Z'))).user, null);
  });

  it('rejects duplicate accounts and invalid credentials', async () => {
    const store = new InMemoryAccountAuthStore();
    await registerAccount(store, {
      email: 'host@example.com',
      name: 'Arnold',
      password: 'CorrectPassword123',
    });

    await assert.rejects(
      () => registerAccount(store, {
        email: 'HOST@example.com',
        name: 'Duplicate',
        password: 'CorrectPassword123',
      }),
      /already exists/
    );

    await assert.rejects(
      () => loginAccount(store, {
        email: 'host@example.com',
        password: 'WrongPassword123',
      }),
      /incorrect/
    );
  });
});

describe('PostgresAccountAuthStore', () => {
  it('restores accounts and sessions from native PostgreSQL timestamps', async () => {
    const db = new FakeDb();
    const now = new Date('2026-09-08T03:00:00.123Z');
    const credentials = { email: 'host@example.com', name: 'Host', password: 'CorrectPassword123' };
    const registered = await registerAccount(new PostgresAccountAuthStore(db), credentials, now);
    // node-postgres parses timestamptz columns as Date objects on reads.
    const user = db.users.get(registered.user.id);
    user.created_at = new Date(user.created_at);
    user.updated_at = new Date(user.updated_at);
    const tokenHash = hashAccountSessionToken(registered.session.token);
    const session = db.sessions.get(tokenHash);
    session.created_at = new Date(session.created_at);
    session.expires_at = new Date(session.expires_at);

    const restored = new PostgresAccountAuthStore(db);
    const current = await getAccountSession(restored, registered.session.token, now);
    assert.deepEqual(current.user, registered.user);
    assert.equal(current.session.expiresAt, registered.session.expiresAt);
    assert.equal((await loginAccount(restored, credentials, now)).user.id, registered.user.id);
    await assert.rejects(() => loginAccount(restored, { ...credentials, password: 'WrongPassword123' }, now), /incorrect/);
    assert.equal((await getAccountSession(restored, registered.session.token, session.expires_at)).user, null);
    assert.equal(db.sessions.has(tokenHash), false);
  });

  it('rejects invalid database timestamps without throwing or authenticating', async () => {
    const db = new FakeDb();
    const now = new Date('2026-09-08T03:00:00.123Z');
    const store = new PostgresAccountAuthStore(db);
    const registered = await registerAccount(store, { email: 'host@example.com', name: 'Host', password: 'CorrectPassword123' }, now);
    const session = db.sessions.get(hashAccountSessionToken(registered.session.token));
    for (const invalid of [new Date(NaN), Infinity, null, {}]) {
      session.expires_at = invalid;
      assert.equal((await getAccountSession(store, registered.session.token, now)).user, null);
    }
    session.expires_at = new Date(registered.session.expiresAt);
    db.users.get(registered.user.id).created_at = new Date(NaN);
    assert.equal((await getAccountSession(store, registered.session.token, now)).user, null);
  });

  it('creates account/session schema and stores only hashed session tokens', async () => {
    const fakeDb = new FakeDb();
    const store = new PostgresAccountAuthStore(fakeDb);

    await store.init();
    const registered = await registerAccount(store, {
      email: 'host@example.com',
      name: 'Arnold',
      password: 'CorrectPassword123',
    }, new Date('2026-07-03T10:00:00.000Z'));

    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_accounts')));
    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_account_sessions')));

    const tokenHash = hashAccountSessionToken(registered.session.token);
    assert.equal(fakeDb.sessions.has(tokenHash), true);
    assert.equal(fakeDb.sessions.has(registered.session.token), false);

    const session = await getAccountSession(store, registered.session.token, new Date('2026-07-03T10:01:00.000Z'));
    assert.equal(session.user?.email, 'host@example.com');

    assert.equal((await getAccountSession(store, registered.session.token, new Date(registered.session.expiresAt))).user, null);
    await store.close();
    assert.equal(fakeDb.closed, true);
  });
});
