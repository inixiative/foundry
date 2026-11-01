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

// The thread header: the name alone on top, then pills grouping each concept (status, your agents,
// other parties; provider · model · effort, context fill, mode), with project and branch top right.
test('the thread header shows its name and grouped pills', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-header-'));
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
      new Thread('shop-1', new ContextStack(), {
        description: 'Checkout errors since 2:02',
        projectId: 'shop',
        branch: 'fix/checkout-retry',
      }),
    );
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
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.route('**/api/threads/shop-1/launch', (route: { fulfill: (r: object) => unknown }) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          threadId: 'shop-1',
          provider: 'claude-code',
          model: 'claude-opus-5-5',
          effort: 'high',
          permissionMode: null,
          options: { models: [], efforts: [] },
        }),
      }),
    );
    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    const band = page.locator('.thread-band--pills');
    await band.locator('.context-bar-title', { hasText: 'Checkout errors since 2:02' }).waitFor();
    // Row 1: the name alone on the left; project and branch on the right.
    const where = await band.locator('.band-row--top .band-pill').allInnerTexts();
    expect(where[0]).toBe('acme-shop');
    expect(where).toContain('fix/checkout-retry');
    // Row 2: status, your agents, other parties; then provider · model · effort, named from the registry.
    const bottom = band.locator('.band-row--bottom');
    expect(await bottom.locator('.band-status').count()).toBe(1);
    expect(await bottom.locator('.band-count').first().getAttribute('title')).toContain(
      'Claude Code · your agent',
    );
    await bottom.locator('.band-pill', { hasText: 'high' }).waitFor();
    expect(await bottom.innerText()).toMatch(/Opus 5\.5.*high/);
    // Nothing spills out of the band at 1280.
    const spill = await band.evaluate((el: Element) => el.scrollWidth - el.clientWidth);
    expect(spill).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
