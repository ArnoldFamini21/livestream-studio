import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

it('shares watch request limits across IPv6 addresses and alternate poll paths', { timeout: 45_000 }, async (t) => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TMPDIR|TMP|TEMP|XDG_.*|SYSTEMROOT)$/.test(key)));
  Object.assign(env, {
    NODE_ENV: 'test', PORT: '0', ROOM_PERSISTENCE_DISABLED: 'true',
    ACCOUNT_AUTH_PERSISTENCE_DISABLED: 'true', RECORDING_CATALOG_PERSISTENCE_DISABLED: 'true',
    BRAND_KIT_CATALOG_PERSISTENCE_DISABLED: 'true', WORKSPACE_STUDIO_CATALOG_PERSISTENCE_DISABLED: 'true',
    WORKSPACE_TEAM_CATALOG_PERSISTENCE_DISABLED: 'true',
  });
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Signaling server did not start: ${output}`)), 10_000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Server running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });

  async function request(path, network, member, method) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, signal: t.signal,
      headers: { 'X-Forwarded-For': `2001:db8:1:${network}::${member.toString(16)}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    await response.arrayBuffer();
    return response;
  }

  const cases = [
    { path: '/api/watch/missing/live', network: 1, max: 2400, method: 'GET' },
    { path: '/api/watch/missing/chat', network: 2, max: 1500, method: 'POST' },
    { path: '/api/watch/missing/poll', network: 3, max: 1200, method: 'GET', alias: '/API/WATCH/missing/POLL-VOTES/' },
  ];
  for (const { path, network, max, method, alias } of cases) {
    for (let first = 1; first <= max; first += 25) {
      const responses = await Promise.all(Array.from({ length: Math.min(25, max - first + 1) }, (_, offset) => request(path, network, first + offset, method)));
      assert.ok(responses.every(response => response.status === 404), `${path} serves its full budget`);
    }
    const blocked = await request(alias ?? path, network, max + 1, alias ? 'POST' : method);
    assert.equal(blocked.status, 429, `${alias ?? path} shares the exhausted /64 budget`);
    assert.match(blocked.headers.get('Retry-After'), /^\d+$/);
    assert.equal((await request(path, network + 4, 1, method)).status, 404, 'another network still has a budget');
  }
});
