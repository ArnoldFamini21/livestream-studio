import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createStudio, screenshot, stageGuest, startHarness } from './harness.mjs';

const artifactDir = path.join(process.env.E2E_ARTIFACT_DIR || path.resolve('output/e2e'), 'production-rundown');

async function openScenes(page) {
  await page.getByRole('navigation', { name: 'Studio panels' })
    .getByRole('button', { name: 'Scenes', exact: true }).click();
}

async function createScene(page, name) {
  await openScenes(page);
  await page.getByRole('button', { name: 'Add scene', exact: true }).click();
  await page.getByRole('button', { name: /Browse templates/ }).click();
  await page.locator('#scene-templates').getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: `Switch to ${name}`, exact: true }).waitFor();
}

async function openRundown(page) {
  await page.getByRole('button', { name: 'More tools', exact: true }).click();
  await page.getByRole('dialog', { name: 'Studio tools' })
    .getByRole('button', { name: 'Producer', exact: true }).click();
  await page.getByRole('button', { name: /^Rundown(?: · Cue ready)?$/ }).click();
  return page.getByRole('region', { name: 'Production rundown', exact: true });
}

test('takes a portable scene from a co-host in a browser without that saved scene', { timeout: 90_000 }, async () => {
  const fixture = await startHarness({ artifactDir, distDir: process.env.E2E_DIST_DIR });
  const pages = new Map();
  try {
    const hostContext = await fixture.browser('rundown-host');
    const { page: host } = await createStudio(hostContext, { url: fixture.url, name: 'Rundown handoff' });
    pages.set('host', host);
    await createScene(host, 'Starting Soon');
    const hostBanner = host.locator('.studio-stage').getByRole('status', { name: '', exact: true }).filter({ hasText: /^Starting Soon$/ });
    await hostBanner.waitFor();
    await host.getByRole('button', { name: 'Switch to Starting Soon', exact: true }).waitFor();
    assert.equal(await host.getByRole('button', { name: 'Switch to Presentation', exact: true }).count(), 0);

    await host.getByRole('button', { name: 'Open invite panel', exact: true }).click();
    await host.getByText('Co-host Link', { exact: true }).locator('xpath=../..')
      .getByRole('button', { name: 'Create', exact: true }).click();
    const coHostLink = new URL(await host.getByLabel('Co-host invite link', { exact: true }).inputValue());
    await host.getByRole('button', { name: 'Close invite panel', exact: true }).click();

    const producer = await (await fixture.browser('rundown-producer')).newPage();
    pages.set('producer', producer);
    await producer.goto(new URL(coHostLink.pathname + coHostLink.search + coHostLink.hash, fixture.url).href);
    await producer.locator('#join-name').fill('Crew Operator');
    await producer.getByRole('button', { name: 'Join as Co-host', exact: true }).click();
    await producer.getByRole('button', { name: 'More tools', exact: true }).waitFor();
    await stageGuest(host, 'Crew Operator');
    await createScene(producer, 'Presentation');

    const producerRundown = await openRundown(producer);
    await producerRundown.getByRole('button', { name: 'Add rundown item', exact: true }).click();
    await producerRundown.getByLabel('Title', { exact: true }).fill('Show the deck');
    await producerRundown.getByLabel('Scene name', { exact: true }).fill('Presentation');
    await producerRundown.getByLabel('Private notes', { exact: true }).fill('Wait for the host cue.');
    await producerRundown.getByRole('button', { name: 'Share saved layout', exact: true }).click();
    await producerRundown.getByRole('button', { name: 'Save item', exact: true }).click();
    const layoutSwitcher = host.getByRole('radiogroup', { name: 'Layout switcher', exact: true });
    const selectedLayout = layoutSwitcher.getByRole('radio', { checked: true });
    const pip = layoutSwitcher.getByRole('radio', { name: /^PiP layout/ });
    const layoutBeforeCue = await selectedLayout.getAttribute('aria-label');
    assert.equal(await pip.getAttribute('aria-checked'), 'false');

    await producerRundown.getByRole('button', { name: 'Cue Show the deck', exact: true }).click();
    await producerRundown.getByText('Up next · Show the deck', { exact: true }).waitFor();
    assert.equal(await producerRundown.getByRole('button', { name: 'Take scene', exact: true }).count(), 0);

    assert.equal(await selectedLayout.getAttribute('aria-label'), layoutBeforeCue);

    const hostRundown = await openRundown(host);
    await hostRundown.getByText('Up next · Show the deck', { exact: true }).waitFor();
    await hostRundown.getByRole('button', { name: 'Take scene', exact: true }).click();
    await hostRundown.getByText('Last taken', { exact: true }).waitFor();
    await producerRundown.getByText('Last taken', { exact: true }).waitFor();
    await host.getByRole('button', { name: 'Exit', exact: true }).click();

    await layoutSwitcher.getByRole('radio', { name: /^PiP layout/, checked: true }).waitFor();
    await hostBanner.waitFor();
    await host.getByRole('button', { name: 'Switch to Starting Soon', exact: true }).waitFor();
    assert.equal(await host.getByRole('button', { name: 'Switch to Presentation', exact: true }).count(), 0);
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    await Promise.allSettled([...pages].map(([name, page]) => screenshot(page, fixture.artifactDir, 'failure-' + name)));
    throw error;
  } finally {
    await fixture.close();
  }
});
