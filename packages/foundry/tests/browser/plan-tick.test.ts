import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const HERE = '11111111-1111-4111-8111-111111111111';

// The person's Plan tab: grouped outcomes render under their group heads, and the person ticks
// one off there; the tick persists on the thread's plan and shows the thread done to no one.
test('grouped outcomes render under heads and a person tick persists', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-plan-tick-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const identity = join(dir, 'device.json');
    writeFileSync(identity, JSON.stringify({ version: 1, id: HERE, name: 'MacBook Pro' }));
    const projects = new ProjectRegistry();
    const shop = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: dir,
      tags: [],
      runtime: 'claude-code',
    });
    const thread = new Thread('shop-1', new ContextStack(), {
      description: 'Cap checkout retries',
      projectId: 'shop',
    });
    thread.meta.plan = {
      outcomes: [
        { text: 'Retries stop at three', status: 'todo', group: 'Checkout' },
        { text: 'Errors explain the cap', status: 'todo', group: 'Checkout' },
        { text: 'Release notes drafted', status: 'doing' },
      ],
      pains: [],
      strategy: [],
      reasons: [],
      technical: [],
      updatedAt: Date.now(),
    };
    shop.addThread(thread);
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
      deviceIdentityPath: identity,
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
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1&rail=open`);
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    await page.keyboard.press('Alt+Digit2');
    const plan = page.locator('.plan');
    await plan.locator('.plan-group-head', { hasText: 'Checkout' }).waitFor();
    await plan.locator('.plan-item', { hasText: 'Retries stop at three' }).waitFor();

    // Tick the first grouped outcome; the box becomes a reopen button and the plan persists it.
    await plan.getByRole('button', { name: 'Tick off "Retries stop at three"' }).click();
    await plan.getByRole('button', { name: 'Reopen "Retries stop at three"' }).waitFor();
    let savedStatus: string | undefined;
    for (let i = 0; i < 50 && savedStatus !== 'done'; i++) {
      const saved = (await (
        await fetch(`http://127.0.0.1:${server.port}/api/threads/shop-1`)
      ).json()) as { meta: { plan: { outcomes: Array<{ text: string; status: string }> } } };
      savedStatus = saved.meta.plan.outcomes[0]?.status;
      if (savedStatus !== 'done') await Bun.sleep(100);
    }
    expect(savedStatus).toBe('done');
    expect(thread.meta.done).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
});
