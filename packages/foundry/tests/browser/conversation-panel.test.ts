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
import type { OperationRequestFrame } from '@inixiative/signet';
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
  const signetId = Bun.randomUUIDv7();
  const admitted = conversations.admit({
    type: 'operation.request',
    requestId: Bun.randomUUIDv7(),
    signetId,
    acceptedRevision: 1,
    member: { signetId, displayName: 'JobCo' },
    threadId: 'main',
    permissions: [],
    operation: 'thread.prompt',
    input: { postId: Bun.randomUUIDv7(), text: 'The role you wanted opened.' },
  } satisfies OperationRequestFrame<'thread.prompt'>);
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
    // The members live on the right panel's Participants tab.
    await page.locator('.rp-tab', { hasText: 'Participants' }).click();
    const panel = page.locator('.conversation-panel');
    await panel.waitFor();
    expect(await panel.locator('.conversation-member-name').innerText()).toBe('JobCo');
    // No snapshot lists the member's Signet yet, so it reads as holding no permission (§4.12).
    expect(await panel.locator('[data-term="posts"]').innerText()).toBe('posts as data');
    expect(await panel.locator('[data-term="act"]').innerText()).toBe('agent asks before acting');
    expect(await panel.locator('[data-term="agent"]').count()).toBe(0);
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
    // JobCo is not listed by any snapshot, so its sends are always reviewed: no control, a chip.
    expect(await panel.locator('[data-term="outbound"]').count()).toBe(0);
    expect(await panel.getByTitle('Sends to this member').innerText()).toBe('sends reviewed');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    conversations.dispose();
    viewer.localStore?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

// The agents in a thread (CONVERSATIONS.md §4.12): one by default, the host's; another open thread
// of the same scope joins from "+ Add agent" as a local member, and leaves from the same modal.
test("Runs on counts the thread's agents; + Add agent joins another thread and Remove lets it go", async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/thread-agents-'));
  const main = new Thread('main', new ContextStack());
  main.register(new Executor({ id: 'worker', stack: main.stack, handler: async () => 'answered' }));
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
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
    actionQueue: new ActionQueue(),
  });
  const created = await viewer.app.request('/api/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'codex', description: 'Second opinion' }),
  });
  expect(created.status).toBe(201);
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
    await page.locator('.rp-tab', { hasText: 'Context' }).click();
    const count = page.locator('[data-agents="count"]');
    await count.waitFor();
    expect(await count.innerText()).toBe('1 agent');

    await page.locator('[data-agents="add"]').click();
    const modal = page.locator('.thread-agents-modal');
    await modal.waitFor();
    expect(await modal.locator('[data-agent]').count()).toBe(1);
    await modal.locator('select').selectOption('codex');
    await modal.locator('[data-agents="join"]').click();
    await modal.locator('[data-agent="local"]').waitFor();
    expect(viewer.conversations!.view('main').members.map((m) => m.member)).toEqual([
      { kind: 'local', id: 'codex' },
    ]);
    // The thread already in is no longer offered.
    expect(await modal.locator('option[value="codex"]').count()).toBe(0);
    await until(async () => (await count.innerText()) === '2 agents', 'the count follows');
    // Each local agent says what it runs on, and Change opens the same picker as Runs on, named for it.
    const local = modal.locator('[data-agent="local"][data-member="codex"]');
    await until(async () => {
      const run = await local.locator('[data-run="local"]').innerText();
      return run !== 'reading…' && run !== '—' && run.trim() !== '';
    }, 'the local agent shows its run');
    const launchOf = async (id: string) =>
      (await (await viewer.app.request(`/api/threads/${id}/launch`)).json()) as {
        role: string | null;
        effectiveRole: string | null;
      };
    const mainBefore = await launchOf('main');
    await local.getByRole('button', { name: 'Change Second opinion' }).click();
    const picker = page.locator('.run-modal:not(.thread-agents-modal)');
    await picker.locator('[data-run="apply"]').waitFor();
    expect(await picker.locator('.modal-title').innerText()).toBe('Second opinion runs on');
    // Apply changes this agent's run, not the host's.
    await picker.locator('[data-run="role"]').selectOption('thread:assistant');
    await picker.locator('[data-run="apply"]').click();
    await picker.waitFor({ state: 'detached' });
    await until(
      async () => (await launchOf('codex')).role === 'thread:assistant',
      'the agent changed',
    );
    expect(await launchOf('main')).toMatchObject({
      role: mainBefore.role,
      effectiveRole: mainBefore.effectiveRole,
    });
    await until(
      async () => (await local.locator('[data-run="local"]').innerText()).includes('ssistant'),
      'its row shows the new run',
    );

    await local.getByRole('button', { name: 'Remove Second opinion' }).click();
    await local.waitFor({ state: 'detached' });
    await until(async () => (await count.innerText()) === '1 agent', 'back to one');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    viewer.conversations?.dispose();
    viewer.localStore?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

// A new agent from the band (Aron, 2026-11-14: "next to primary model should be some sort of add or
// + button which opens a modal"): "+" beside the run pill opens the agents modal, "New agent…" opens
// the New thread picker in join mode, and the thread it starts joins this one as a local member
// while this thread stays selected. Participants carries the same count and "+ Add agent".
test('the band\'s "+" starts a new agent that joins this thread; Participants shows the agents', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/thread-agents-new-'));
  const main = new Thread('main', new ContextStack());
  main.register(new Executor({ id: 'worker', stack: main.stack, handler: async () => 'answered' }));
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
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
    actionQueue: new ActionQueue(),
  });
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

    await page.locator('.rp-tab', { hasText: 'Participants' }).click();
    const line = page.locator('[data-agents="line"]');
    await line.waitFor();
    expect(await line.locator('[data-agents="count"]').innerText()).toBe('1 agent');

    await page.locator('[data-agents="add-band"]').click();
    const modal = page.locator('.thread-agents-modal');
    await modal.waitFor();
    await modal.locator('[data-agents="new"]').click();
    await modal.waitFor({ state: 'detached' });
    const picker = page.locator('.new-thread-modal');
    await picker.waitFor();
    expect(await picker.locator('.modal-title').innerText()).toBe('New agent in this thread');
    expect(await picker.locator('[data-note="joins"]').count()).toBe(1);
    await picker.locator('[data-run="name"]').fill('Reviewer');
    const start = picker.locator('[data-run="start"]');
    await until(async () => !(await start.isDisabled()), 'the workers are read');
    expect(await start.innerText()).toContain('Add agent');
    await start.click();
    await picker.waitFor({ state: 'detached' });

    await until(
      () => viewer.conversations!.view('main').members.some((m) => m.member.kind === 'local'),
      'the new thread joined',
    );
    const [member] = viewer.conversations!.view('main').members;
    expect(member).toMatchObject({ displayName: 'Reviewer', member: { kind: 'local' } });
    expect(member!.member.id).not.toBe('main');
    // This thread stays selected: the new agent is a member, not where the person goes.
    expect(new URL(page.url()).hash).toContain('thread=main');
    await until(
      async () => (await line.locator('[data-agents="count"]').innerText()) === '2 agents',
      'Participants counts it',
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    viewer.conversations?.dispose();
    viewer.localStore?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
