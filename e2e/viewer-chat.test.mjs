import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createStudio, eventually, screenshot, startHarness, openStudioTool } from './harness.mjs';

test('watch-page engagement reaches the studio and follows host moderation', { timeout: 150_000 }, async () => {
  const fixture = await startHarness({
    artifactDir: path.join(process.env.E2E_ARTIFACT_DIR || path.resolve('output/e2e'), 'viewer-chat'),
  });
  const pages = new Map();
  try {
    const hostContext = await fixture.browser('host');
    const { page: host } = await createStudio(hostContext, { url: fixture.url });
    pages.set('host', host);
    await openStudioTool(host, 'Invite guests');
    const watchUrl = new URL(await host.getByLabel('Public watch page link', { exact: true }).inputValue());
    await host.getByRole('button', { name: 'Close invite panel', exact: true }).click();
    const watchHref = new URL(watchUrl.pathname, fixture.url).href;
    const liveUrl = new URL(`/api${watchUrl.pathname}/live`, fixture.apiUrl).href;

    const openViewer = async (name, viewport) => {
      const page = await (await fixture.browser(name, { viewport })).newPage();
      pages.set(name, page);
      const firstPoll = page.waitForResponse(response => response.url() === liveUrl && response.ok());
      await page.goto(watchHref);
      const state = await (await firstPoll).json();
      assert.deepEqual(state.switches, { chat: false, reactions: false, questions: false });
      assert.equal(await page.getByRole('region', { name: 'Chat, reactions and questions' }).count(), 0);
      return page;
    };
    const viewer = await openViewer('viewer', { width: 390, height: 844 });
    const observer = await openViewer('observer', { width: 1000, height: 625 });
    const topic = 'Can we pray for the sick?';
    const hello = 'Hello <b>everyone</b>';
    const stage = host.getByRole('region', { name: 'Broadcast canvas' });

    await openStudioTool(host, /^Chat/);
    await host.getByLabel('Chat channel').selectOption('public');
    const studioMessage = (text) => host.locator('.chat-message-item', { hasText: text });
    const watchMessage = (page, text) => page.getByRole('log', { name: 'Chat messages' }).getByRole('article').filter({ hasText: text });
    const sendStudioMessage = async (channel, input, text) => {
      await host.getByLabel('Chat channel').selectOption(channel);
      await host.getByLabel(input).fill(text);
      await host.getByRole('button', { name: 'Send message', exact: true }).click();
      await studioMessage(text).waitFor();
    };
    const sendViewerMessage = async (text) => {
      await viewer.getByLabel('Your message').fill(text);
      await viewer.getByRole('button', { name: 'Send', exact: true }).click();
    };

    await sendStudioMessage('public', 'Public message', 'Earlier rehearsal note');
    const settings = host.getByRole('button', { name: 'Watch page viewer settings' });
    await settings.click();
    const setSwitch = async (name, enabled) => {
      const toggle = host.getByRole('switch', { name, exact: true });
      await toggle.click();
      await eventually(async () => await toggle.getAttribute('aria-checked') === String(enabled), { message: `${name} did not update` });
    };
    await setSwitch('Viewers can chat', true);
    await setSwitch('Viewers can react', true);
    await setSwitch('Viewers can ask questions', true);
    await settings.click();
    for (const page of [viewer, observer]) {
      await page.getByLabel('Your message').waitFor({ timeout: 30_000 });
      assert.equal(await watchMessage(page, 'Earlier rehearsal note').count(), 0);
    }

    await viewer.getByLabel('Your name', { exact: true }).fill('Test Host');
    await sendViewerMessage(hello);
    await watchMessage(viewer, hello).waitFor();
    const observed = watchMessage(observer, hello);
    await observed.getByText('Viewer', { exact: true }).waitFor();
    assert.equal(await observed.locator('b').count(), 0, 'viewer text is displayed literally');
    await host.getByLabel('Chat channel').selectOption('social');
    const studioLine = studioMessage(hello);
    await studioLine.getByText('Viewer', { exact: true }).waitFor();

    await host.getByRole('button', { name: /^Chat on screen: Off/ }).click();
    const onScreen = stage.locator('[data-chat-overlay]').getByText(hello, { exact: false });
    await onScreen.waitFor();
    await host.getByRole('button', { name: 'Show only approved comments' }).click();
    await onScreen.waitFor({ state: 'detached' });

    await sendStudioMessage('backstage', 'Backstage message', 'Private crew cue');
    await sendStudioMessage('public', 'Public message', 'Welcome to the service');
    await watchMessage(observer, 'Welcome to the service').getByText('Studio', { exact: true }).waitFor();
    assert.equal(await watchMessage(observer, 'Private crew cue').count(), 0);

    await Promise.all([
      stage.getByText('❤️', { exact: true }).waitFor(),
      viewer.getByRole('button', { name: 'Love', exact: true }).click(),
    ]);
    await observer.getByRole('button', { name: 'Ask a question' }).click();
    await observer.getByLabel('Your question').fill(topic);
    await observer.getByRole('button', { name: 'Send question', exact: true }).click();
    await observer.getByText('Thank you. Your question was sent to the host.', { exact: true }).waitFor();
    await host.getByRole('button', { name: 'More tools', exact: true }).click();
    await host.getByRole('dialog', { name: 'Studio tools' }).getByRole('button', { name: /Q&A/ }).click();
    await host.getByText(topic, { exact: true }).waitFor();
    await host.getByText(/\(viewer\)/).first().waitFor();
    await screenshot(host, fixture.artifactDir, 'host-question-1440');
    await host.getByRole('button', { name: 'Close Q&A panel', exact: true }).click();
    await screenshot(viewer, fixture.artifactDir, 'viewer-chat-390');
    await screenshot(observer, fixture.artifactDir, 'viewer-chat-1000');

    await host.getByLabel('Chat channel').selectOption('social');
    await studioLine.locator('summary[aria-label^="Message actions"]').click();
    await studioLine.getByRole('button', { name: /Block viewer/ }).click();
    const block = host.getByRole('dialog', { name: 'Block this viewer?' });
    await block.getByRole('button', { name: /^Block this viewer only/ }).click();
    await studioLine.waitFor({ state: 'detached' });
    await observed.waitFor({ state: 'detached' });
    await sendViewerMessage('Still here?');
    await viewer.getByRole('status').getByText('You can no longer post in this broadcast.', { exact: true }).waitFor();

    await settings.click();
    await host.getByRole('button', { name: 'Unblock Test Host', exact: true }).click();
    await host.getByRole('button', { name: 'Unblock Test Host', exact: true }).waitFor({ state: 'detached' });
    await sendViewerMessage('Back again');
    await watchMessage(observer, 'Back again').waitFor();
    const overlayShow = host.getByRole('group', { name: 'Show', exact: true });
    if (await overlayShow.count() === 0) await host.getByRole('button', { name: 'Chat on screen settings' }).click();
    await overlayShow.getByRole('button', { name: 'All comments', exact: true }).click();
    const earlierLine = stage.locator('[data-chat-overlay]').getByText('Back again', { exact: true });
    await earlierLine.waitFor();
    await setSwitch('Viewers can chat', false);
    await earlierLine.waitFor({ state: 'detached' });
    await viewer.getByLabel('Your message').waitFor({ state: 'detached' });
    await viewer.getByRole('button', { name: 'Ask a question' }).waitFor();

    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    await Promise.allSettled(Array.from(pages, ([name, page]) => screenshot(page, fixture.artifactDir, `failure-${name}`)));
    throw error;
  } finally {
    await fixture.close();
  }
});
