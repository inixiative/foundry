import { expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { liveWatchFixture, until } from '../helpers/live-watch-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);
/** Let the column transition (0.15s) finish before a screenshot. */
const settled = (page: { waitForTimeout(ms: number): Promise<void> }) => page.waitForTimeout(300);
/** Where to keep screenshots of the three scopes (inbox, project strip, thread), when set. */
const SHOTS = process.env.FOUNDRY_QA_SCREENSHOTS;

// Feedback is explicit: `/feedback <text>` in the composer records an item on the thread's last turn and
// sends nothing; the same items show in the pinned inbox, the project's strip and the thread.
test('/feedback in the composer, the project strip, the thread marker and the pinned inbox', async () => {
  await mkdir(resolve('.foundry/qa'), { recursive: true });
  const dir = await mkdtemp(resolve('.foundry/qa/feedback-inbox-'));
  const f = await liveWatchFixture(dir);
  // One finished turn to give feedback on.
  const sent = f.viewer.app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'turn-1',
      threadId: f.thread.id,
      message: 'Draft the release notes.',
    }),
  });
  await until(() => f.attempts.length === 1, 'dispatched');
  f.attempts[0].finish(false, 'Here are the release notes, in five sections.');
  expect((await sent).status).toBe(200);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: f.viewer.fetch,
    websocket: f.viewer.websocket,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=${f.thread.id}`);

    const column = page.locator('.panel-projects');
    const pinned = column.locator('.nav-pinned .proj-item');
    expect(await pinned.allInnerTexts()).toEqual([
      expect.stringContaining('Global'),
      expect.stringContaining('Forge Master'),
      expect.stringContaining('Feedback'),
    ]);
    // The strip sits at the top of the project's threads.
    const strip = column.locator('.nav-threads .feedback-strip');
    await strip.waitFor();
    expect(await strip.innerText()).toContain('0 open');
    await page.locator('.chat-agent[data-turn-id="turn-1"]').waitFor();

    // `/feedback <text>`: recorded on the last turn; no turn is sent and the composer clears.
    const composer = page.locator('.chat-input');
    await composer.fill('/feedback Too long: keep release notes to one paragraph.');
    await composer.press('Enter');
    await page.locator('.turn-feedback[data-turn-feedback="turn-1"]').waitFor();
    expect(await composer.inputValue()).toBe('');
    await until(async () => (await strip.innerText()).includes('1 open'), 'strip counts it');
    expect(f.attempts).toHaveLength(1);
    expect(await page.locator('.chat-user').count()).toBe(1);
    // The detail panel lists the thread's feedback.
    const threadList = page.locator('.thread-feedback');
    await threadList.waitFor();
    expect(await threadList.innerText()).toContain('one paragraph');

    // A message's ⋯ → feedback aims it at that turn.
    const reply = page.locator('.chat-agent[data-turn-id="turn-1"]');
    await reply.hover();
    await reply.locator('.msg-action-trigger').click();
    await reply.getByRole('button', { name: 'feedback' }).click();
    await reply
      .getByLabel('Feedback on this turn')
      .fill('The sections were right; only cut words.');
    await reply.getByRole('button', { name: 'Give feedback' }).click();
    await until(async () => (await strip.innerText()).includes('2 open'), 'second item');
    await page.locator('.turn-feedback summary', { hasText: '2 feedback' }).waitFor();
    await page.locator('.turn-feedback summary').click();
    if (SHOTS) await settled(page).then(() => page.screenshot({ path: join(SHOTS, 'thread.png') }));

    // Feedback on another thread of the project, given over the API (as ACP does).
    await f.viewer.app.request(`/api/threads/${f.other.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Name branches after the ticket.', surface: 'acp:Paseo' }),
    });
    await until(async () => (await strip.innerText()).includes('3 open'), 'third item');
    // The strip opens the project's list.
    await strip.click();
    await page.locator('.feedback-inbox[data-scope="P"] .feedback-item').nth(2).waitFor();
    if (SHOTS)
      await settled(page).then(() => page.screenshot({ path: join(SHOTS, 'project-strip.png') }));

    // The pinned inbox: everything, newest first, each linking back to its thread.
    await pinned.filter({ hasText: 'Feedback' }).click();
    expect(await page.locator('.header-scope-name').innerText()).toBe('Feedback');
    const inbox = page.locator('.feedback-inbox[data-scope="all"]');
    const rows = inbox.locator('.feedback-item');
    await rows.nth(2).waitFor();
    expect(await rows.locator('.feedback-statement').allInnerTexts()).toEqual([
      'Name branches after the ticket.',
      'The sections were right; only cut words.',
      'Too long: keep release notes to one paragraph.',
    ]);
    expect(await rows.first().innerText()).toContain('acp:Paseo');
    if (SHOTS) await settled(page).then(() => page.screenshot({ path: join(SHOTS, 'inbox.png') }));

    // Archive one, then the rest in bulk; the archived filter has them; unarchive one.
    await rows.first().getByRole('button', { name: 'Archive' }).click();
    await until(async () => (await rows.count()) === 2, 'archived one');
    await inbox.getByLabel('Select all').check();
    await inbox.getByRole('button', { name: 'Archive selected (2)' }).click();
    await inbox.locator('.graph-empty').waitFor();
    expect(await inbox.getByRole('tab', { name: /Open/ }).innerText()).toBe('Open (0)');
    await inbox.getByRole('tab', { name: /Archived/ }).click();
    await until(async () => (await rows.count()) === 3, 'archived list');
    await rows.last().getByRole('button', { name: 'Unarchive' }).click();
    await until(async () => (await rows.count()) === 2, 'unarchived one');
    const { items } = (await (await f.viewer.app.request('/api/feedback?status=open')).json()) as {
      items: Array<{ statement: string }>;
    };
    expect(items.map((item) => item.statement)).toEqual([
      'Too long: keep release notes to one paragraph.',
    ]);

    // Provenance: the item's thread link returns to the project and thread.
    await inbox.getByRole('tab', { name: /Open/ }).click();
    await rows.first().locator('.feedback-source').click();
    await page.locator('.chat-agent[data-turn-id="turn-1"]').waitFor();
    expect(await page.locator('.header-scope-name').innerText()).not.toBe('Feedback');
    expect(page.url()).toContain(`thread=${f.thread.id}`);

    // Automatic detection is opt-in: Settings → Advanced → Feedback turns it on.
    await page.goto(`http://127.0.0.1:${server.port}/settings/feedback`);
    const detect = page.getByRole('switch', { name: 'Detect corrections automatically' });
    expect(await detect.isChecked()).toBe(false);
    await detect.click({ force: true });
    await until(
      async () =>
        (
          (await (await f.viewer.app.request('/api/settings')).json()) as {
            feedback?: { capture?: boolean };
          }
        ).feedback?.capture === true,
      'capture on',
    );
    await until(() => detect.isChecked(), 'switch shows it');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    await f.close();
  }
}, 60_000);
