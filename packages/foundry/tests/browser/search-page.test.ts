import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const GRAPH = {
  conceptToFiles: { 'feature:checkout': ['src/checkout/retry.ts'], 'feature:search': ['src/s.ts'] },
  usesConsumers: {},
  fileToConcepts: {},
  docToConcepts: {},
  thesaurus: { 'feature:checkout': { phrases: ['checkout'], doc: 'docs/CHECKOUT.md' } },
};

// / opens Search; one input searches threads, linked PRs and tickets, and the projects' Atlas
// concepts, a scope chip narrows to one project, groups without a source say so, Esc goes back.
test('Search finds threads, linked PRs and Atlas concepts, narrows by project, and Esc goes back', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-search-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const shopPath = join(dir, 'shop');
    mkdirSync(join(shopPath, '.atlas'), { recursive: true });
    mkdirSync(join(shopPath, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(shopPath, 'graph.json'), JSON.stringify(GRAPH));
    const bin = join(shopPath, 'node_modules', '.bin', 'atlas');
    writeFileSync(bin, `#!/bin/sh\ncat "${join(shopPath, 'graph.json')}"\n`);
    chmodSync(bin, 0o755);
    const blogPath = join(dir, 'blog');
    mkdirSync(blogPath);

    const projects = new ProjectRegistry();
    const shop = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: shopPath,
      tags: [],
      runtime: 'claude-code',
    });
    const blog = projects.register({
      id: 'blog',
      label: 'blog',
      path: blogPath,
      tags: [],
      runtime: 'claude-code',
    });
    const retries = new Thread('shop-1', new ContextStack(), {
      description: 'Cap checkout retries',
      projectId: 'shop',
    });
    shop.addThread(retries);
    blog.addThread(
      new Thread('blog-1', new ContextStack(), {
        description: 'Checkout the new theme',
        projectId: 'blog',
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
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    // A turn that links the PR: capture records the thread's references from its Archive snapshot.
    const store = viewer.localStore!;
    store.beginTurn(retries, 'turn-1', 'Cap retries; see https://github.com/acme/shop/pull/57');
    store.completeTurn(
      retries,
      'turn-1',
      'Opened acme/shop#57.',
      {},
      {
        id: 'trace-turn-1',
        messageId: 'turn-1',
        startedAt: 1,
        root: {},
        summary: {},
        spans: [],
      },
    );
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

    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator('.search-button').waitFor();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    const search = page.locator('.search-page');
    const input = search.locator('input.search-input');
    await input.waitFor();
    await page.waitForFunction(() => location.hash.includes('view=search'));
    await input.fill('checkout');

    const group = (name: string) => search.getByRole('region', { name });
    await group('Threads').locator('.search-hit', { hasText: 'Cap checkout retries' }).waitFor();
    await group('Threads').locator('.search-hit', { hasText: 'Checkout the new theme' }).waitFor();
    await group('Docs and Atlas')
      .locator('.search-hit', { hasText: 'feature:checkout † docs/CHECKOUT.md' })
      .waitFor();
    expect(await group('Threads').locator('mark').first().innerText()).toBe('checkout');
    await group('People').locator('.search-empty', { hasText: 'Not indexed yet' }).waitFor();
    // Messages come from the local Archive (the test's fake), which holds the captured threads.
    await group('Messages').locator('.search-hit', { hasText: 'Cap checkout retries' }).waitFor();

    await input.fill('#57');
    await group('PRs and tickets')
      .locator('.search-hit', { hasText: 'acme/shop#57' })
      .waitFor({ timeout: 30_000 });

    // A project chip narrows every group to it.
    await input.fill('checkout');
    await search
      .getByRole('group', { name: 'Scope' })
      .getByRole('button', { name: 'blog', exact: true })
      .click();
    await group('Threads').locator('.search-hit', { hasText: 'Checkout the new theme' }).waitFor();
    expect(await group('Threads').locator('.search-hit').count()).toBe(1);
    await group('Docs and Atlas')
      .locator('.search-empty', { hasText: 'Not indexed yet' })
      .waitFor();

    // Esc goes back; a hit opens its thread.
    await input.press('Escape');
    await search.waitFor({ state: 'detached' });
    await page.locator('.search-button').click();
    await input.fill('retries');
    await group('Threads').locator('.search-hit', { hasText: 'Cap checkout retries' }).click();
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    expect(await search.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
