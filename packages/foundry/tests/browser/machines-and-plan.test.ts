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
const STUDIO = '22222222-2222-4222-8222-222222222222';

// A thread on another of your machines (meta.machine) carries a device badge in the list and on the
// board, joins the Board's Machine filter and shows as you on that machine in the Watchtower; the
// footer lists that machine, whose page leads to its threads; a thread whose agent recorded its plan
// (meta.plan) shows it in Plan.
test('threads on another machine are badged and filterable; a recorded plan fills Plan', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-machines-'));
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
    const local = new Thread('shop-1', new ContextStack(), {
      description: 'Cap checkout retries',
      projectId: 'shop',
    });
    local.meta.machine = { deviceId: HERE, deviceName: 'MacBook Pro' };
    local.meta.plan = {
      outcomes: [{ text: 'Checkout retries stop at three', status: 'doing' }],
      pains: [{ text: 'Retries hammer the payment API' }],
      strategy: [{ text: 'Cap in the retry wrapper' }],
      reasons: [{ text: 'One place, not every caller' }],
      technical: [
        {
          concern: 'retries',
          decision: 'reuse',
          system: 'withRetry',
          path: 'src/retry.ts',
          reason: 'already wraps payments',
        },
      ],
      updatedAt: Date.now(),
    };
    const remote = new Thread('shop-2', new ContextStack(), {
      description: 'Rebuild regions',
      projectId: 'shop',
    });
    remote.meta.machine = { deviceId: STUDIO, deviceName: 'studio Mac' };
    shop.addThread(local);
    shop.addThread(remote);

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.installationName = 'MacBook Pro';
    // Registered in settings too, so this machine's inventory lists it as a checkout.
    config.projects.shop = { id: 'shop', path: dir, label: 'acme-shop', tags: [] };
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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    // The list: only the thread on the other machine carries a badge.
    await page
      .locator('.tree-node', { hasText: 'Rebuild regions' })
      .locator('.device-badge', { hasText: 'studio Mac' })
      .waitFor();
    expect(
      await page
        .locator('.tree-node', { hasText: 'Cap checkout retries' })
        .locator('.device-badge')
        .count(),
    ).toBe(0);

    // Plan: the agent's recorded plan, section by section.
    await page.keyboard.press('2');
    const plan = page.locator('.plan');
    await plan.locator('.plan-items', { hasText: 'Checkout retries stop at three' }).waitFor();
    for (const text of [
      'Retries hammer the payment API',
      'Cap in the retry wrapper',
      'One place, not every caller',
    ])
      await plan.locator('.plan-items', { hasText: text }).waitFor();
    await plan.locator('.plan-tech-row', { hasText: 'withRetry' }).waitFor();
    await plan.locator('.plan-intro', { hasText: 'recorded by the agent' }).waitFor();

    // Board: the badge on the card, and Machine narrows to the studio Mac.
    await page.locator('.board-button').click();
    const board = page.locator('.board');
    // Both threads are idle: quiet, off the board until shown.
    await board.locator('.board-quiet-toggle').click();
    await board
      .locator('.board-card', { hasText: 'Rebuild regions' })
      .locator('.device-badge')
      .waitFor();
    await board
      .getByRole('toolbar', { name: 'Filters' })
      .getByRole('button', { name: /^Machine/ })
      .click();
    await page
      .getByRole('group', { name: 'Machine' })
      .getByRole('button', { name: /^studio Mac/ })
      .click();
    await board.locator('.board-card', { hasText: 'Rebuild regions' }).waitFor();
    expect(await board.locator('.board-card', { hasText: 'Cap checkout retries' }).count()).toBe(0);

    // Watchtower: you on the studio Mac, by device, and you on this machine.
    await page.locator('.watchtower-button').click();
    const tower = page.locator('.watchtower');
    await tower
      .locator('.wt-card', { hasText: 'Rebuild regions' })
      .locator('.actor', { hasText: 'You · studio Mac' })
      .waitFor();
    await tower
      .locator('.wt-card', { hasText: 'Cap checkout retries' })
      .locator('.actor', { hasText: 'You · this machine' })
      .waitFor();

    // Footer: your other machine with its open threads (no meter); its page lists its threads and
    // opens the Watchtower filtered to it, with a removable chip.
    await page.locator('.watchtower-button').click();
    await tower.waitFor({ state: 'detached' });
    const other = page.locator('.nav-footer-other', { hasText: 'studio Mac' });
    await other.locator('.nav-footer-count', { hasText: '1 open thread' }).waitFor();
    expect(await other.locator('.bar2').count()).toBe(0);
    await other.click();
    const devicePage = page.locator('.device-page');
    await devicePage.locator('h2', { hasText: 'studio Mac' }).waitFor();
    await devicePage.locator('.ph-row', { hasText: 'Rebuild regions' }).waitFor();
    expect(await devicePage.locator('.ph-row', { hasText: 'Cap checkout retries' }).count()).toBe(
      0,
    );
    await devicePage.locator('.coming-soon-note', { hasText: 'checked out' }).waitFor();
    await devicePage.getByRole('button', { name: 'Show in the Watchtower →' }).click();
    const chip = tower.locator('.filter-chip-active', { hasText: 'Machine: studio Mac' });
    await chip.waitFor();
    await tower.locator('.wt-card', { hasText: 'Rebuild regions' }).waitFor();
    expect(await tower.locator('.wt-card', { hasText: 'Cap checkout retries' }).count()).toBe(0);
    await chip.click();
    await tower.locator('.wt-card', { hasText: 'Cap checkout retries' }).waitFor();

    // This machine's page: its own threads and checkouts, read from this Foundry.
    await page.locator('.watchtower-button').click();
    await tower.waitFor({ state: 'detached' });
    await page.locator('button.nav-footer-device').click();
    await devicePage.locator('h2', { hasText: 'MacBook Pro' }).waitFor();
    await devicePage.locator('.ph-row', { hasText: 'Cap checkout retries' }).waitFor();
    await devicePage.locator('.ph-line', { hasText: 'acme-shop' }).waitFor();
    await devicePage.getByRole('button', { name: 'Its threads on the Board →' }).click();
    await board.locator('.filter-chip-active', { hasText: 'Machine: MacBook Pro' }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
