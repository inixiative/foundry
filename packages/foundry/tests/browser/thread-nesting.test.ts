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

// The rail lists threads flat; only a subagent (it carries `meta.spawn`) nests under its parent.
// A thread a person started from another keeps its parent link for Plan but sits at the top level.
test('the rail nests subagents only; a user-started child thread lists flat', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-nesting-'));
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
    project.addThread(
      new Thread('main', new ContextStack(), {
        description: 'Fix the cart total',
        projectId: 'shop',
      }),
    );
    const sub = new Thread('sub', new ContextStack(), {
      description: 'Explore the cart module',
      projectId: 'shop',
      parentThreadId: 'main',
    });
    sub.meta.spawn = { via: 'native-claude', observed: true };
    sub.meta.depth = 1;
    sub.meta.status = 'active';
    project.addThread(sub);
    const finished = new Thread('sub-done', new ContextStack(), {
      description: 'Read the tax rules',
      projectId: 'shop',
      parentThreadId: 'main',
    });
    finished.meta.spawn = { via: 'native-claude', observed: true };
    finished.meta.depth = 1;
    project.addThread(finished);
    project.addThread(
      new Thread('follow-up', new ContextStack(), {
        description: 'Follow-up: refund rounding',
        projectId: 'shop',
        parentThreadId: 'main',
      }),
    );
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('global', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      actionQueue: new ActionQueue(),
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
    await page.goto(`http://127.0.0.1:${server.port}/#project=shop`);
    const indent = async (name: string) => {
      const row = page.locator('.nav-threads .tree-node', { hasText: name }).first();
      await row.waitFor();
      return row.evaluate((el: Element) =>
        Number.parseFloat(getComputedStyle(el.parentElement!).paddingLeft),
      );
    };
    const top = await indent('Fix the cart total');
    expect(await indent('Explore the cart module')).toBeGreaterThan(top);
    expect(await indent('Follow-up: refund rounding')).toBe(top);

    // A running subagent shows under its parent; a finished one folds into a thin
    // "completed runs" toggle, and expanding it lists the run to open.
    const doneRow = page.locator('.nav-threads .tree-node', { hasText: 'Read the tax rules' });
    expect(await doneRow.count()).toBe(0);
    await page
      .locator('.nav-threads .inactive-fold-header', { hasText: '1 completed run' })
      .click();
    await doneRow.first().click();
    await page.locator('.subagent-record').waitFor();

    // An observed subagent takes no turns: its thread shows a record notice, not a composer,
    // and the notice opens the parent thread.
    await page
      .locator('.nav-threads .tree-node', { hasText: 'Explore the cart module' })
      .first()
      .click();
    const notice = page.locator('.subagent-record');
    await notice.waitFor();
    expect(await page.locator('.chat-input textarea, .conversation textarea').count()).toBe(0);
    await notice.locator('.subagent-record-parent', { hasText: 'Fix the cart total' }).click();
    await page.locator('.conversation textarea').first().waitFor();
    expect(await notice.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
