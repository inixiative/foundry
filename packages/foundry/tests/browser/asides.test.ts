import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  ActionQueue,
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import type { ThreadRequestOf } from '@inixiative/signet';
import { ConfigStore, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// Asides (CONVERSATIONS.md, "/aside and the three views"): a member's aside shows in the /aside view
// with the unread count on its segment and the "since your last post" note; the owner posts an aside
// from the composer's /aside destination; promoting the member's aside puts it in the thread once,
// and a second promote says why it can't.
test('asides: post from /aside, unread count, promote once and say why the second time', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/asides-'));
  const main = new Thread('main', new ContextStack());
  main.register(new Executor({ id: 'worker', stack: main.stack, handler: async () => 'answered' }));
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const queue = new ActionQueue();
  // A machine past setup: no wizard over the workspace.
  const configStore = new ConfigStore(dir);
  const config = starterConfig('controlled', 'controlled');
  config.setupComplete = true;
  await configStore.save(config);
  const viewer = createViewer({
    configStore,
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    actionQueue: queue,
  });
  const conversations = viewer.conversations!;
  const signetId = crypto.randomUUID();
  const admitted = conversations.admit({
    type: 'thread.request',
    requestId: crypto.randomUUID(),
    signetId,
    acceptedRevision: 1,
    member: { signetId, displayName: 'JobCo' },
    lens: {
      threads: { form: 'ids', ids: ['main'] },
      view: 'own',
      delivery: 'note',
      outbound: 'review',
    },
    operation: 'thread.prompt',
    input: { threadId: 'main', postId: crypto.randomUUID(), text: 'The role you wanted opened.' },
  } as ThreadRequestOf<'thread.prompt'>);
  expect(admitted.ok).toBe(true);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: viewer.fetch,
    websocket: viewer.websocket,
  });
  conversations.aside(
    'main',
    { member: { kind: 'signet', id: signetId }, displayName: 'JobCo' },
    'can we talk price later?',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 960 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);

    // The member's aside: counted on the /aside segment and in the note.
    const segment = page.locator('.thread-segment', { hasText: '/aside' });
    await segment.locator('.segment-unread', { hasText: '1' }).waitFor();
    await page.locator('.asides-since', { hasText: '1 aside since your last post' }).click();
    const asides = page.getByRole('region', { name: 'Asides' });
    await asides.locator('.aside-card', { hasText: 'can we talk price later?' }).waitFor();

    // The owner posts an aside from the composer: /aside switches the destination.
    const box = page.locator('textarea.chat-input');
    await box.click();
    // "/aside " at the start switches the destination and is dropped from the text. (Typing "/" into
    // an empty box opens the Actions palette, so the text is set in one go.)
    await box.fill('/aside Let me check the budget first.');
    await page.locator('.composer-note-hint', { hasText: 'never an agent' }).waitFor();
    expect(await box.inputValue()).toBe('Let me check the budget first.');
    await page.keyboard.press('Enter');
    await asides.locator('.aside-card', { hasText: 'Let me check the budget first.' }).waitFor();
    expect(await box.inputValue()).toBe('');
    expect(conversations.view('main').asides).toHaveLength(2);

    // Promote the member's aside: in the thread once; the card says so.
    const theirs = asides.locator('.aside-card', { hasText: 'can we talk price later?' });
    await theirs.getByRole('button', { name: 'Promote to the thread' }).click();
    await theirs.locator('.aside-card-promoted', { hasText: 'In the thread' }).waitFor();
    expect(
      conversations.view('main').asides.find((a) => a.text === 'can we talk price later?')
        ?.promoted,
    ).toBe(true);
    // Promoting again is refused, and the reason shows.
    const again = await fetch(
      `http://127.0.0.1:${server.port}/api/threads/main/conversation/asides/${conversations.view('main').asides[0]!.id}/promote`,
      { method: 'POST' },
    );
    expect(again.status).toBe(409);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    conversations.dispose();
    viewer.localStore?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
