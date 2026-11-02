import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// A done thread (its branch merged) reads light blue with its text on the row, the header and the
// Board; Settings › Threads sets what a merge does, Foundry-wide and per project; the project's
// About names its Kingdom project; the Knowledge page shows this machine's region builds and the
// last detection test, and Build regions runs one after a confirm, with its log.
test('done threads, the merge setting, the Kingdom project link and the region pipeline', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-done-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  const saved = { data: process.env.WARDEN_REGIONS_DATA, oracle: process.env.ORACLE_CHECKOUT };
  cleanup.push([
    'env',
    () => {
      process.env.WARDEN_REGIONS_DATA = saved.data;
      process.env.ORACLE_CHECKOUT = saved.oracle;
      if (saved.data === undefined) delete process.env.WARDEN_REGIONS_DATA;
      if (saved.oracle === undefined) delete process.env.ORACLE_CHECKOUT;
    },
  ]);
  try {
    // The pipeline reads a temp machine: one build, one detection finding, and a build script that
    // only prints (no model calls).
    const data = join(dir, 'regions-data');
    const oracle = join(dir, 'oracle');
    mkdirSync(join(data, 'build-2026-11-01-abc1234'), { recursive: true });
    writeFileSync(
      join(data, 'build-2026-11-01-abc1234', 'BUILD.json'),
      JSON.stringify({
        templateCommit: 'abc1234def',
        builtAt: '2026-11-01T10:00:00Z',
        regions: ['a', 'b', 'c'],
        maxTokens: 24000,
        over20k: ['a'],
      }),
    );
    mkdirSync(join(oracle, 'docs', 'findings'), { recursive: true });
    writeFileSync(
      join(oracle, 'docs', 'findings', '2026-10-17-stage1-detect.json'),
      JSON.stringify({
        date: '2026-10-17',
        metrics: { reading: 'Recall holds the bar.', recall: 0.81, falseYes: 0.027 },
      }),
    );
    mkdirSync(join(oracle, 'pipelines', 'warden-regions'), { recursive: true });
    writeFileSync(
      join(oracle, 'pipelines', 'warden-regions', 'build_regions.py'),
      'import sys\nprint("splitting regions for", sys.argv[1])\n',
    );
    process.env.WARDEN_REGIONS_DATA = data;
    process.env.ORACLE_CHECKOUT = oracle;

    const projects = new ProjectRegistry();
    const shop = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: dir,
      tags: [],
      runtime: 'claude-code',
    });
    const merged = new Thread('shop-1', new ContextStack(), {
      description: 'Cap checkout retries',
      projectId: 'shop',
    });
    merged.meta.done = { kind: 'merged', text: 'Merged into main', at: Date.now() };
    shop.addThread(merged);

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    // A paired Kingdom for the project link to name (a dead loopback port: nothing is reached).
    config.kingdomIntegrations = [
      {
        url: 'http://127.0.0.1:9',
        owner: `OrganizationUser:${crypto.randomUUID()}:${crypto.randomUUID()}:`,
        integrationId: crypto.randomUUID(),
        signetId: crypto.randomUUID(),
      },
    ];
    config.projects.shop = {
      id: 'shop',
      path: dir,
      label: 'acme-shop',
      kingdomProject: {
        kingdom: 'http://127.0.0.1:9',
        projectId: '5b1c6a3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
      },
    };
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
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
    const origin = `http://127.0.0.1:${server.port}`;
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    // Done: the row, the header and the Board say "Merged into main".
    await page.goto(`${origin}/#thread=shop-1`);
    await page
      .locator('.band-status[data-state="done"]', { hasText: 'Merged into main' })
      .waitFor();
    await page
      .locator('.tree-node', { hasText: 'Cap checkout retries' })
      .locator('.row-done', { hasText: 'Merged into main' })
      .waitFor();
    await page.locator('.board-button').click();
    const board = page.locator('.board');
    await board
      .locator('.board-column--done .board-card', { hasText: 'Cap checkout retries' })
      .locator('.board-card-kind', { hasText: 'Merged into main' })
      .waitFor();

    // Settings › Threads: Foundry-wide, then a project's own over it.
    await page.goto(`${origin}/settings/threads`);
    const merge = page.locator('[data-setting="threadOnMerge"]');
    await merge.getByRole('radio', { name: /Archive it/ }).check();
    await page.waitForFunction(
      async (url: string) => (await (await fetch(url)).json()).threadOnMerge === 'auto-archive',
      `${origin}/api/settings`,
    );
    await page.goto(`${origin}/projects/shop/settings/threads`);
    await merge.locator('.settings-desc', { hasText: 'Following Foundry’s setting' }).waitFor();
    expect(await merge.getByRole('radio', { name: /Archive it/ }).isChecked()).toBe(true);
    await merge.getByRole('radio', { name: /Mark it done/ }).check();
    await merge.locator('.settings-desc', { hasText: 'Set for this project' }).waitFor();
    expect(
      JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).projects.shop.threadOnMerge,
    ).toBe('done');

    // About names the Kingdom project.
    await page.goto(`${origin}/#project=shop&home=1`);
    const about = page.locator('.ph-about');
    await about.locator('dd', { hasText: '5b1c6a3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e' }).waitFor();
    await about.locator('dd', { hasText: 'in http://127.0.0.1:9' }).waitFor();

    // Knowledge: the build and the last detection test; Build regions asks first, then runs.
    await page.getByRole('button', { name: 'Knowledge and chorus' }).click();
    const know = page.locator('.knowledge');
    await know.locator('.kbuilds tr', { hasText: 'abc1234def' }).waitFor();
    await know.locator('.kdetect', { hasText: 'Recall holds the bar.' }).waitFor();
    await know.locator('.kdetect td', { hasText: '0.027' }).waitFor();
    expect(
      await know.getByRole('button', { name: 'Run the detection test · not built' }).isDisabled(),
    ).toBe(true);
    await know.getByRole('button', { name: 'Build regions', exact: true }).click();
    const confirm = know.getByRole('group', { name: 'Confirm the region build' });
    await confirm.locator('b', { hasText: 'This spends model calls.' }).waitFor();
    expect(await confirm.locator('input').inputValue()).toBe('abc1234def');
    await confirm.getByRole('button', { name: 'Spend model calls and build' }).click();
    await know.locator('.krun-log', { hasText: 'splitting regions for abc1234def' }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
