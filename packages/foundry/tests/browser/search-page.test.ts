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
import { writeRegions } from '../helpers/regions';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const GRAPH = {
  conceptToFiles: { 'feature:checkout': ['src/checkout/retry.ts'] },
  usesConsumers: {},
  fileToConcepts: {
    'src/checkout/retry.ts': { kind: ['service'], partOf: ['feature:checkout'], uses: [] },
  },
  docToConcepts: {},
  thesaurus: { 'feature:checkout': { phrases: ['checkout'], doc: 'docs/CHECKOUT.md' } },
};

// Search is its own page: settings, docs, Atlas and Heralds come before threads; each group shows
// five until "Show all"; ↑↓ moves the preview and Enter opens; a setting opens in Settings
// highlighted; Esc returns to the thread as it was.
test('Search: its own page, settings and docs first, preview, open a setting, Esc back', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-search-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const repo = join(dir, 'shop');
    mkdirSync(join(repo, '.atlas'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'graph.json'), JSON.stringify(GRAPH));
    const bin = join(repo, 'node_modules', '.bin', 'atlas');
    writeFileSync(bin, `#!/bin/sh\ncat "${join(repo, 'graph.json')}"\n`);
    chmodSync(bin, 0o755);
    writeRegions(repo, [
      {
        id: 'checkout',
        knowledge: '# Checkout\n\n## Retries\n\nCap checkout retries at three with withRetry.\n',
      },
    ]);

    const projects = new ProjectRegistry();
    const shop = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: repo,
      tags: [],
      runtime: 'claude-code',
    });
    shop.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: 'Cap checkout retries',
        projectId: 'shop',
      }),
    );

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.installationName = 'Checkout Studio';
    config.projects.shop = { id: 'shop', path: repo, label: 'acme-shop' };
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
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');

    // Its own page: the top bar and Search, no rail, thread panel or composer.
    const search = page.locator('.search-page');
    const input = search.getByRole('searchbox', { name: 'Search everything' });
    await input.waitFor();
    expect(new URL(page.url()).pathname).toBe('/search');
    for (const panel of ['.panel-projects', '.panel-right', 'textarea.chat-input'])
      expect(await page.locator(panel).count()).toBe(0);

    // Settings, docs, Atlas and Heralds come first.
    await input.fill('checkout');
    const groups = search.locator('.search-group h4');
    await search
      .getByRole('region', { name: 'Docs' })
      .locator('.search-hit', { hasText: 'Retries' })
      .waitFor();
    const order = (await groups.allInnerTexts()).map((t: string) => t.split(' · ')[0]);
    expect(order).toEqual([
      'SETTINGS',
      'DOCS',
      'ATLAS',
      'HERALDS',
      'THREADS',
      'MESSAGES',
      'PRS AND TICKETS',
      'FEEDBACK',
      'PEOPLE',
    ]);
    await search
      .getByRole('region', { name: 'Atlas' })
      .locator('.search-hit', { hasText: 'feature:checkout' })
      .waitFor();
    await search
      .getByRole('region', { name: 'Threads' })
      .locator('.search-hit', { hasText: 'Cap checkout retries' })
      .waitFor();
    // The highlighted result previews beside the list: a doc section with its pointer.
    const docHit = search
      .getByRole('region', { name: 'Docs' })
      .locator('.search-hit', { hasText: 'Retries' });
    await docHit.hover();
    const preview = search.getByRole('complementary', { name: 'Preview' });
    await preview
      .locator('.sp-pointer', { hasText: '† .foundry/regions/checkout/knowledge.md §Retries' })
      .waitFor();
    await preview.locator('pre', { hasText: 'withRetry' }).waitFor();

    // A group shows five until Show all.
    await input.fill('a');
    const settings = search.getByRole('region', { name: 'Settings' });
    await settings.getByRole('button', { name: /^Show all \d+/ }).waitFor();
    expect(await settings.locator('.search-hit').count()).toBe(5);

    // ↑↓ moves the highlight; Enter on a setting opens its Settings section, the setting highlighted.
    await input.fill('installationName');
    const first = settings.locator('.search-hit').first();
    await first.waitFor();
    // Once: Foundry-wide settings aren't repeated under each project.
    expect(await settings.locator('.search-hit').count()).toBe(1);
    expect(await first.getAttribute('aria-selected')).toBe('true');
    await preview.locator('dd', { hasText: 'Checkout Studio' }).waitFor();
    await preview.locator('dd', { hasText: 'Set by you' }).waitFor();
    await input.press('Enter');
    await page.waitForURL(/\/settings\/profile$/);
    // The field itself is highlighted and scrolled to; no card is needed.
    await page.locator('[data-setting="installationName"].setting-searched').waitFor();
    expect(await page.locator('.settings-searched').count()).toBe(0);

    // By meaning, not just name: a described setting matches words from its description.
    await page.locator('.search-button').click();
    await input.fill('reasoning effort');
    await settings.locator('.search-hit', { hasText: 'defaults.codexEffort' }).waitFor();
    // A setting its section shows no field for opens with the card at the top instead.
    await input.fill('kingdomInferenceAssignments');
    await settings.locator('.search-hit').first().waitFor();
    await input.press('Enter');
    await page.waitForURL(/\/settings\/kingdom$/);
    await page.locator('.settings-searched', { hasText: 'kingdomInferenceAssignments' }).waitFor();

    // Esc from Search returns where you were: the thread, as it was.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    await page.locator('.search-button').click();
    await input.waitFor();
    await input.press('Escape');
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    expect(new URL(page.url()).hash).toContain('thread=shop-1');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
