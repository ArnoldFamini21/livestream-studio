import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createStudio, eventually, screenshot, startHarness } from './harness.mjs';

test('an invited viewer can register and request to join a private event', { timeout: 110_000 }, async () => {
  const fixture = await startHarness({
    artifactDir: path.join(process.env.E2E_ARTIFACT_DIR || path.resolve('output/e2e'), 'watch-events'),
  });
  const pages = new Map();
  try {
    const hostContext = await fixture.browser('host');
    const { page: host } = await createStudio(hostContext, { url: fixture.url, privateWatch: true, name: 'Private event rehearsal' });
    pages.set('host', host);
    await host.getByRole('button', { name: 'Open invite panel', exact: true }).click();
    await host.getByRole('checkbox', { name: /Allow audience call-ins/ }).click();
    await eventually(() => host.getByRole('checkbox', { name: /Allow audience call-ins/ }).isChecked());
    await host.getByRole('button', { name: 'Create private viewing link', exact: true }).click();
    const field = host.getByLabel('Private viewing link', { exact: true });
    await field.waitFor();
    const invite = new URL(await field.inputValue());
    assert.ok(invite.hash.includes('watchInvite='));
    const viewer = await (await fixture.browser('viewer', { viewport: { width: 390, height: 844 } })).newPage();
    pages.set('viewer', viewer);
    await viewer.goto(new URL(invite.pathname, fixture.url).href);
    await viewer.getByText('Ask the host for a private viewing link for this event.').waitFor();
    await viewer.goto(new URL(invite.pathname + invite.hash, fixture.url).href);
    await viewer.getByLabel('Your name', { exact: true }).fill('Riley');
    await viewer.getByLabel('Email', { exact: true }).fill('riley@watch.example');
    await viewer.getByRole('button', { name: 'Register and watch', exact: true }).click();
    await viewer.getByRole('button', { name: 'Request to join', exact: true }).click();
    assert.equal(new URL(viewer.url()).hash, '', 'the invite does not remain in the address');
    await viewer.getByLabel('Note for the studio team (optional)', { exact: true }).fill('I can read the passage.');
    await viewer.getByRole('button', { name: 'Send request', exact: true }).click();
    await viewer.getByText(/Your request is with the studio team/).waitFor();
    await host.getByRole('button', { name: 'Approve call-in from Riley', exact: true }).click();
    const continueLink = viewer.getByRole('link', { name: 'Continue to device check', exact: true });
    await continueLink.waitFor();
    await continueLink.click();
    await viewer.locator('#join-name').fill('Riley');
    const email = viewer.locator('input[type=email]');
    await email.fill('riley@watch.example');
    await viewer.getByRole('button', { name: /Join Studio|Register.*Join/ }).first().click();
    await viewer.getByRole('button', { name: 'Leave studio', exact: true }).waitFor();
    await host.getByRole('button', { name: 'Close invite panel', exact: true }).click();
    await host.getByRole('button', { name: 'Move Riley backstage', exact: true }).waitFor();
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } finally {
    for (const [label, page] of pages) {
      if (!page.isClosed()) await screenshot(page, fixture.artifactDir, label).catch(() => {});
    }
    await fixture.close();
  }
});
