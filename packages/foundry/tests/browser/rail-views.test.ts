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

// The left rail opens on Attention: only the threads that need you (a pending approval), not the one
// working or the idle one; Open lists them all. ⌥⇧← ⌥⇧→ step Attention · Open · Projects, wrapping,
// from inside the message box, and the hash keeps the view.
test('the rail opens on Attention, lists only threads that need you, and ⌥⇧← ⌥⇧→ step the three views', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-rail-views-'));
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
    for (const [id, description, status] of [
      ['shop-1', 'Checkout errors since 2:02', 'idle'],
      ['shop-2', 'Rewrite the setup guide', 'active'],
      ['shop-3', 'Tidy the changelog', 'idle'],
    ] as const) {
      const thread = new Thread(id, new ContextStack(), { description, projectId: 'shop' });
      thread.meta.status = status;
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
    void queue.prompt({
      kind: 'approval',
      message: 'Allow git push origin fix/checkout?',
      agentId: 'worker',
      threadId: 'shop-1',
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
    const active = page.locator('.rail-toggle-btn.is-active');
    expect(await active.innerText()).toBe('Attention');
    const rows = page.locator('.active-rail .tree-node');
    await rows.filter({ hasText: 'Checkout errors since 2:02' }).waitFor();
    expect(await rows.filter({ hasText: 'Rewrite the setup guide' }).count()).toBe(0);
    expect(await rows.filter({ hasText: 'Tidy the changelog' }).count()).toBe(0);
    expect(new URL(page.url()).hash).not.toContain('rail=');

    // The shortcut works while typing: focus stays in the message box.
    await page.locator('.chat-input').focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Open' }).waitFor();
    await rows.filter({ hasText: 'Rewrite the setup guide' }).waitFor();
    await rows.filter({ hasText: 'Tidy the changelog' }).waitFor();
    await page.waitForFunction(() => location.hash.includes('rail=open'));
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Projects' }).waitFor();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Attention' }).waitFor();
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await active.filter({ hasText: 'Projects' }).waitFor();
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('chat-input')),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
