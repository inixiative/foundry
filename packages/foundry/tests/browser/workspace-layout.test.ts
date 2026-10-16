import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
  TokenTracker,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../../src/agents/project';
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { liveWatchFixture, until } from '../helpers/live-watch-fixture';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('the left column is navigation: pinned scopes, a scrolling project list, and the selected scope’s threads', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-workspace-layout-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const main = new Thread('main', new ContextStack(), { description: 'Global work' });
    for (let i = 0; i < 30; i++) {
      const project = projects.register({
        id: `p${i}`,
        path: join(dir, `p${i}`),
        label: i === 0 ? 'Checkout service' : `Project ${i}`,
        tags: [],
        runtime: 'claude-code',
      });
      if (i === 0)
        for (const name of ['Fix the cart total', 'Refund webhook'])
          project.addThread(
            new Thread(`t-${name.length}`, new ContextStack(), {
              description: name,
              projectId: 'p0',
            }),
          );
    }
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(main),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#project=p0`);

    const column = page.locator('.panel-projects');
    // Pinned group first, then the projects, then the selected project's threads.
    const pinned = column.locator('.nav-pinned .proj-item');
    expect(await pinned.allInnerTexts()).toEqual([
      expect.stringContaining('Global'),
      expect.stringContaining('Forge Master'),
    ]);
    const threads = column.locator('.nav-threads .tree-label');
    await threads.first().waitFor();
    expect((await threads.allInnerTexts()).sort()).toEqual([
      'Fix the cart total',
      'Refund webhook',
    ]);
    const order = await page.evaluate(() =>
      ['.nav-pinned', '.nav-projects', '.nav-threads'].map(
        (sel) => document.querySelector(sel)!.getBoundingClientRect().top,
      ),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The project list scrolls on its own; the threads half stays in view below it.
    const scroll = await page.evaluate(() => {
      const list = document.querySelector('.proj-list')!;
      const threadsHalf = document.querySelector('.nav-threads')!.getBoundingClientRect();
      return {
        scrolls: list.scrollHeight > list.clientHeight,
        threadsVisible: threadsHalf.top < innerHeight && threadsHalf.height > 100,
      };
    });
    expect(scroll).toEqual({ scrolls: true, threadsVisible: true });
    // Threads get ~60% of the space below the pinned group, projects ~40%.
    const split = await page.evaluate(() => {
      const height = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().height;
      return height('.nav-threads') / (height('.nav-threads') + height('.nav-projects'));
    });
    expect(split).toBeGreaterThan(0.55);
    expect(split).toBeLessThan(0.65);
    expect(await column.locator('.proj-sidebar-count').innerText()).toBe('30');

    // Collapsing the project list keeps its count and hands the space to the threads.
    await column.getByRole('button', { name: /PROJECTS/ }).click();
    expect(await column.locator('.proj-list').count()).toBe(0);
    expect(await column.locator('.proj-sidebar-count').innerText()).toBe('30');
    await column.getByRole('button', { name: /PROJECTS/ }).click();

    // No runtime panels in the column: they live in Settings.
    expect(
      await column.locator('.layer-item, .agent-item, .live-event-row, .sidebar-mid').count(),
    ).toBe(0);
    expect(await column.innerText()).not.toMatch(/LAYERS|AGENTS|ACTIVITY/);
    expect(await page.locator('.panel-left').count()).toBe(0);

    // The header centers the selected project's name.
    const scope = page.locator('.header-scope');
    expect(await scope.locator('.header-scope-name').innerText()).toBe('Checkout service');
    expect(await scope.locator('.header-scope-kind').innerText()).toMatch(/project/i);
    const centered = await page.evaluate(() => {
      const header = document.querySelector('.header')!.getBoundingClientRect();
      const name = document.querySelector('.header-scope')!.getBoundingClientRect();
      return Math.abs(name.left + name.width / 2 - (header.left + header.width / 2));
    });
    expect(centered).toBeLessThan(2);

    // Forge Master: its one thread shows in the threads half, and the header names it.
    await pinned.filter({ hasText: 'Forge Master' }).click();
    await page.locator('.forge-master').waitFor();
    expect(await column.locator('.nav-threads .tree-node').allInnerTexts()).toEqual([
      'Forge Master',
    ]);
    expect(await page.locator('.header-scope-name').innerText()).toBe('Forge Master');

    // Global lists the unscoped threads.
    await pinned.filter({ hasText: 'Global' }).click();
    await column.locator('.nav-threads .tree-label', { hasText: 'Global work' }).waitFor();
    expect(await page.locator('.header-scope-name').innerText()).toBe('Global');

    // Layers, Agents and Activity are Settings sections now.
    for (const section of ['Layers', 'Agents', 'Activity']) {
      await page.goto(`http://127.0.0.1:${server.port}/settings/${section.toLowerCase()}`);
      await page.locator('h1.settings-title', { hasText: section }).waitFor();
    }
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);

test('a new thread is selected and takes the first send; one status line while it runs; the answer shows once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-workspace-turn-'));
  const f = await liveWatchFixture(dir);
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
    await page.goto(`http://127.0.0.1:${server.port}/#project=P`);
    const threads = page.locator('.nav-threads .tree-node');
    await threads.filter({ hasText: 'Watched work' }).waitFor();
    const before = await threads.count();

    // "+" creates the thread and selects it: an unnamed thread reads "New thread · HH:MM", its id in the tooltip.
    await page.getByTitle('New thread').click();
    await page.locator('.thread-add-form').getByRole('button', { name: 'create' }).click();
    const selected = page.locator('.nav-threads .tree-node.selected .tree-label');
    await selected.filter({ hasText: /^New thread · \d{1,2}:\d{2}/ }).waitFor();
    expect(await selected.getAttribute('class')).toContain('tree-label--unnamed');
    const created = (await selected.getAttribute('title'))!;
    expect(created).not.toBe(f.thread.id);
    expect(new URL(page.url()).hash).toContain(`thread=${encodeURIComponent(created)}`);
    expect(await page.locator('.context-bar-title').innerText()).toMatch(/^New thread · /);

    // The first send goes to that thread; no second thread appears.
    const sent = page.waitForRequest((r: any) => r.url().endsWith('/api/messages/send'));
    await page.locator('.chat-input').fill('Run the tests');
    await page.locator('.chat-send-btn').click();
    expect(JSON.parse((await sent).postData()!).threadId).toBe(created);
    await until(() => f.attempts.length === 1, 'turn dispatched');
    expect(await threads.count()).toBe(before + 1);

    // One status line for the actual stage; no separate "Processing" bubble.
    const agent = page.locator('.chat-agent').last();
    await agent.locator('.live-work-status', { hasText: 'Waiting for the model…' }).waitFor();
    expect(await page.locator('.live-work-status').count()).toBe(1);
    expect(await page.locator('.chat-thinking').count()).toBe(0);
    expect(await page.getByText(/Queued|Processing|native detail/).count()).toBe(0);

    const attempt = f.attempts[0];
    attempt.emit({ kind: 'text', itemId: 'narration', text: 'Running the suite first.' });
    attempt.emit({ kind: 'tool_use', callId: 'c1', toolName: 'Bash' });
    attempt.emit({ kind: 'tool_result', callId: 'c1' });
    attempt.emit({ kind: 'text', itemId: 'answer', text: 'All tests pass.' });
    await agent.locator('.live-work-status', { hasText: /^Running/ }).waitFor();
    expect(await agent.locator('.live-work-progress small').first().innerText()).toBe(
      'Live output',
    );
    expect(await agent.innerText()).not.toContain('phase unavailable');

    // Completed: the answer shows once, as the message; the work folds into a closed log.
    attempt.finish(false, 'All tests pass.');
    const log = agent.locator('details.live-work-log');
    await log.waitFor();
    expect(await log.getAttribute('open')).toBeNull();
    expect(await log.locator('summary').innerText()).toBe('Work log · Bash ×1');
    expect(await agent.locator('.chat-msg-content').innerText()).toBe('All tests pass.');
    const text = await agent.innerText();
    expect(text.split('All tests pass.').length - 1).toBe(1);
    expect(text).not.toMatch(/Observed native|RPC|Cleanup is separate|Completed/);
    await log.locator('summary').click();
    expect(await log.locator('.live-work-progress').allInnerTexts()).toEqual([
      'Live output\nRunning the suite first.',
    ]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    await f.close();
  }
}, 60_000);
