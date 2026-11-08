import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startHarness, eventually } from './harness.mjs';

test('production browser reports anonymous, release-tagged errors and server groups repeats', { timeout: 60_000 }, async () => {
  const fixture = await startHarness({
    artifactDir: path.join(process.env.E2E_ARTIFACT_DIR || path.resolve('output/e2e'), 'client-errors'),
  });
  const payloads = [];
  try {
    const context = await fixture.browser('error-reporting');
    const page = await context.newPage();
    page.on('request', request => {
      if (request.url() === `${fixture.apiUrl}/api/client-errors`) payloads.push(JSON.parse(request.postData()));
    });
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Create studio', exact: true }).waitFor();
    const bundle = await page.locator('script[type="module"]').getAttribute('src');
    assert.match(bundle, /\/assets\/index-[A-Za-z0-9_-]{8}\.js$/);
    const delivered = page.waitForResponse(response => response.url() === `${fixture.apiUrl}/api/client-errors` && response.status() === 204);
    await page.evaluate(({ bundle }) => {
      // The URL, message, function name and error header must all be omitted.
      history.replaceState(null, '', '/studio/private-room?email=private@example.test#invite=private-token');
      const error = new TypeError('Cannot read properties of undefined (reading "Private Person")');
      error.stack = `TypeError: Private Person\n at PrivatePerson (${location.origin}${bundle}:10:20)`;
      window.dispatchEvent(new ErrorEvent('error', { error }));
      window.dispatchEvent(new ErrorEvent('error', { error }));
      error.stack = `TypeError: Private Person\n at PrivatePerson (${location.origin}${bundle}:11:20)`;
      window.dispatchEvent(new ErrorEvent('error', { error }));
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    }, { bundle });
    await delivered;
    await eventually(() => payloads.length === 3);
    assert.deepEqual(payloads.map(payload => payload.count), [1, 1, 1]);
    assert.ok(payloads.every(payload => /^[a-f0-9]{40}$/.test(payload.release)), 'each browser report carries the build commit');
    assert.ok(payloads.every(payload => payload.page === '/studio/:roomId'));
    assert.ok(payloads.every(payload => payload.message === 'Cannot access an undefined or null value'));
    assert.notEqual(payloads[0].stack, payloads[1].stack);
    assert.equal(payloads[0].stack, payloads[2].stack);
    assert.doesNotMatch(JSON.stringify(payloads), /private|Private|localhost|email|invite|token|userAgent/);
    await eventually(async () => (await (await fetch(`${fixture.apiUrl}/metrics`)).text()).includes('livestream_studio_client_errors_total{kind="error"} 3'));
    for (const route of ['/api/client-errors', '/api/client-errors/', '/API/CLIENT-ERRORS']) {
      const malformed = await fetch(`${fixture.apiUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":Private Person private@example.test' });
      assert.equal(malformed.status, 400, `${route}: malformed JSON does not enter the generic body-parser error logger`);
      const oversized = await fetch(`${fixture.apiUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(17_000) }) });
      assert.equal(oversized.status, 413, `${route}: JSON and beacon bodies share the 16kb intake bound`);
    }
    const unsupported = await fetch(`${fixture.apiUrl}/api/client-errors`, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=PrivatePerson' }, body: '{}' });
    assert.equal(unsupported.status, 415);
    assert.doesNotMatch(await unsupported.text(), /PrivatePerson/);
    assert.equal(fixture.cspViolations.length, 0);
  } finally {
    // A graceful stop flushes the final server summary without a minute-long
    // test sleep, using the same shutdown hook as Render deployment.
    await fixture.close();
  }
  const logs = await eventually(async () => {
    const entries = (await readFile(path.join(fixture.artifactDir, 'server.log'), 'utf8')).split('\n')
      .filter(line => line.startsWith('{"event":"client_error"')).map(line => JSON.parse(line));
    return entries.length >= 3 ? entries : false;
  });
  assert.equal(logs.length, 3);
  assert.equal(new Set(logs.map(log => log.fingerprint)).size, 2);
  assert.equal(logs.reduce((sum, log) => sum + log.count, 0), 3);
  assert.ok(logs.some(log => log.total === 2));
  assert.ok(logs.every(log => log.release === payloads[0].release));
  assert.doesNotMatch(JSON.stringify(logs), /private|Private|localhost|email|invite|token|userAgent/);
  assert.doesNotMatch(await readFile(path.join(fixture.artifactDir, 'server.log'), 'utf8'), /Private ?Person|private@example\.test/);
});
