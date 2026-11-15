import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionQueue,
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
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// Attention keeps the thread you opened until you navigate, not until you open another thread (Aron,
// 2026-11-15: the last one never left). Answering one thread's approval leaves it listed while
// another still needs you; opening the board releases it. Answering the last one opens its
// project's page in the centre and leaves Attention empty.
test('Attention lets a handled thread go when you navigate, and the last one opens its project', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-attention-release-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: join(dir, 'shop'),
      tags: [],
      runtime: 'claude-code',
    });
    for (const [id, description] of [
      ['shop-1', 'Checkout errors since 2:02'],
      ['shop-2', 'Retry limit for refunds'],
    ] as const) {
      const thread = new Thread(id, new ContextStack(), { description, projectId: 'shop' });
      thread.meta.status = 'idle';
      project.addThread(thread);
    }
    const queue = new ActionQueue();
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      actionQueue: queue,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    for (const [threadId, message] of [
      ['shop-1', 'Allow git push origin fix/checkout?'],
      ['shop-2', 'Allow bun test packages/refunds?'],
    ] as const)
      void queue.prompt({
        kind: 'approval',
        message,
        agentId: 'worker',
        threadId,
        urgency: 'high',
      });
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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
    const rows = page.locator('.active-rail .tree-node');
    const row = (name: string) => rows.filter({ hasText: name });
    const cards = page.locator('.prompt-list .prompt-card');
    await row('Checkout errors since 2:02').waitFor();
    await row('Retry limit for refunds').waitFor();

    // Answered while another still needs you: it stays listed, the thread stays open.
    await row('Checkout errors since 2:02').click();
    await page.locator('.context-bar-title', { hasText: 'Checkout errors since 2:02' }).waitFor();
    await cards.first().getByRole('button', { name: 'Approve' }).click();
    await page.waitForFunction(() => !document.querySelector('.prompt-list .prompt-card'));
    expect(queue.pendingCount('shop-1')).toBe(0);
    expect(await row('Checkout errors since 2:02').count()).toBe(1);
    expect(await page.locator('.project-home').count()).toBe(0);

    // Navigating (the board and back) lets it go.
    await page.keyboard.press('Escape');
    await page.locator('.board-button').click();
    await page.locator('.board-button.is-active').waitFor();
    await page.locator('.board-button').click();
    await page.waitForFunction(() => !document.querySelector('.board-button.is-active'));
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.active-rail .tree-node')].some((n) =>
          n.textContent?.includes('Checkout errors since 2:02'),
        ),
    );
    await row('Retry limit for refunds').waitFor();

    // The last one: answering it opens its project's page and Attention is empty.
    await row('Retry limit for refunds').click();
    await page.locator('.context-bar-title', { hasText: 'Retry limit for refunds' }).waitFor();
    await cards.first().getByRole('button', { name: 'Approve' }).click();
    await page.locator('.project-home[aria-label="acme-shop home"]').waitFor();
    await page.waitForFunction(() => !document.querySelector('.active-rail .tree-node'));
    expect(await page.locator('.rail-toggle-btn.is-active').innerText()).toBe('Attention');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
