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
import { until } from '../helpers/live-watch-fixture';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// Prompt cards above the composer belong to the open thread only: another thread's approval waits
// on the Board and its row count, so Approve here can never act on a thread you aren't reading.
test('the composer shows only the open thread’s prompts; approving resolves that one', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-prompt-scope-'));
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
    for (const [id, name] of [
      ['shop-1', 'Checkout errors since 2:02'],
      ['shop-2', 'Retry limit for refunds'],
    ] as const)
      project.addThread(
        new Thread(id, new ContextStack(), { description: name, projectId: 'shop' }),
      );
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
    const other = queue.prompt({
      kind: 'approval',
      message: 'Allow git push origin fix/checkout?',
      agentId: 'worker',
      threadId: 'shop-1',
    });
    const mine = queue.prompt({
      kind: 'approval',
      message: 'Allow bun test packages/refunds?',
      agentId: 'worker',
      threadId: 'shop-2',
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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-2`);
    await page.locator('.context-bar-title', { hasText: 'Retry limit for refunds' }).waitFor();
    const cards = page.locator('.prompt-list .prompt-card');
    await cards.first().waitFor();
    expect(await cards.allInnerTexts()).toEqual([
      expect.stringContaining('Allow bun test packages/refunds?'),
    ]);

    await cards.first().getByRole('button', { name: 'Approve' }).click();
    expect((await mine).action).toBe('approve');
    await until(async () => (await cards.count()) === 0, 'the open thread has no prompt left');
    expect(queue.pendingCount('shop-1')).toBe(1);

    // The other thread's prompt is still there when that thread is opened.
    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    await page.locator('.context-bar-title', { hasText: 'Checkout errors since 2:02' }).waitFor();
    await cards.first().waitFor();
    expect(await cards.allInnerTexts()).toEqual([
      expect.stringContaining('Allow git push origin fix/checkout?'),
    ]);
    await cards.first().getByRole('button', { name: 'Reject' }).click();
    expect((await other).action).toBe('reject');
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
