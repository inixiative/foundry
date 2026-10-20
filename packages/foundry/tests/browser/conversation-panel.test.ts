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
import { until } from '../helpers/live-watch-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// The owner's side of a conversation in the viewer (CONVERSATIONS.md §4.7): the thread rises in the
// sessions list with an unread member post, the participants panel shows the member and its post,
// and a held send is released from its card. Real viewer, journal and wrapper; real browser.

test('an unread member post marks the thread; the panel shows the member and its post; a held send is released from its card', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/conversation-panel-'));
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
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 960 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);

    await page.locator('.conversation-unread-badge').waitFor();
    expect(await page.locator('.conversation-unread-badge').innerText()).toBe('1');
    const panel = page.locator('.conversation-panel');
    await panel.waitFor();
    expect(await panel.locator('.conversation-member-name').innerText()).toBe('JobCo');
    expect(
      await panel.locator('.conversation-post.is-unread .conversation-post-text').innerText(),
    ).toBe('The role you wanted opened.');

    conversations.send('main', 'JobCo', 'Aron is interested.');
    const card = page.locator('.conversation-held');
    await card.waitFor();
    expect(await card.locator('.conversation-held-text').innerText()).toBe('Aron is interested.');
    await card.getByRole('button', { name: 'Edit, then release' }).click();
    await card.getByLabel('Text to release').fill('Aron is interested; send details.');
    await card.getByRole('button', { name: 'Release edited' }).click();
    await card.waitFor({ state: 'detached' });
    await until(() => !queue.pending().length, 'released');
    const released = viewer.localStore!.phasesOf('main', 'outbound-resolution')[0]!.record;
    expect(released).toMatchObject({
      action: 'released',
      text: 'Aron is interested; send details.',
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    conversations.dispose();
    viewer.localStore?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
