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
  type NativeEvidence,
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

const use = (toolName: string, toolInput: Record<string, unknown>) =>
  ({
    schema: 1,
    nativeOutcome: 'unknown',
    kind: 'tool_use',
    toolName,
    toolInput,
  }) as NativeEvidence;

// The project's `atlas graph --json`, from a stub of the repo's own atlas bin.
const GRAPH = {
  conceptToFiles: {
    'feature:checkout': ['src/checkout/retry.ts', 'src/checkout/cart.ts'],
    'infrastructure:queue': ['src/queue.ts'],
    'feature:search': ['src/search.ts'],
  },
  usesConsumers: {},
  fileToConcepts: {},
  docToConcepts: {},
  thesaurus: { 'feature:checkout': { phrases: ['checkout'], doc: 'docs/CHECKOUT.md' } },
};

// Context lists the concepts the thread's files fall in (files, changed, the doc); Heralds lists the
// project's other threads sharing them; a project with no Atlas shows the set-up call instead.
test('Context shows what the thread touches by Atlas concept; Heralds shows threads sharing them', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-atlas-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.atlas'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'graph.json'), JSON.stringify(GRAPH));
    const bin = join(repo, 'node_modules', '.bin', 'atlas');
    writeFileSync(bin, `#!/bin/sh\ncat "${join(repo, 'graph.json')}"\n`);
    chmodSync(bin, 0o755);
    const bare = join(dir, 'bare');
    mkdirSync(bare);

    const projects = new ProjectRegistry();
    const shop = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: repo,
      tags: [],
      runtime: 'claude-code',
    });
    const plain = projects.register({
      id: 'plain',
      label: 'plain',
      path: bare,
      tags: [],
      runtime: 'claude-code',
    });
    const thread = (id: string, description: string, projectId: string) =>
      new Thread(id, new ContextStack(), { description, projectId });
    const main = thread('shop-1', 'Cap checkout retries', 'shop');
    const other = thread('shop-2', 'Cart totals drift', 'shop');
    const elsewhere = thread('shop-3', 'Search ranking', 'shop');
    const unmapped = thread('plain-1', 'No atlas here', 'plain');
    for (const t of [main, other, elsewhere]) shop.addThread(t);
    plain.addThread(unmapped);

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
    const store = viewer.localStore!;
    const turn = (t: Thread, id: string, history: NativeEvidence[]) => {
      store.beginTurn(t, id, 'work');
      store.completeTurn(
        t,
        id,
        'Done',
        { nativeHistory: history },
        {
          id: `trace-${id}`,
          messageId: id,
          startedAt: 1,
          root: {},
          summary: {},
          spans: [],
        },
      );
    };
    turn(main, 'turn-1', [
      use('Read', { file_path: join(repo, 'src/checkout/cart.ts') }),
      use('Edit', {
        file_path: join(repo, 'src/checkout/retry.ts'),
        old_string: '5',
        new_string: '3',
      }),
      use('Read', { file_path: join(repo, 'src/queue.ts') }),
    ]);
    turn(other, 'turn-2', [use('Read', { file_path: join(repo, 'src/checkout/cart.ts') })]);
    turn(elsewhere, 'turn-3', [use('Read', { file_path: join(repo, 'src/search.ts') })]);

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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    await page.locator('.rp-tab', { hasText: 'Context' }).click();
    const touches = page.locator('.rp-section', { hasText: 'Atlas · what this touches' });
    await touches.locator('.atlas-list li').first().waitFor();
    expect(await touches.locator('.atlas-list li').allInnerTexts()).toEqual([
      expect.stringContaining('feature:checkout'),
      expect.stringContaining('infrastructure:queue'),
    ]);
    const checkout = touches.locator('li', { hasText: 'feature:checkout' });
    expect(await checkout.locator('small').innerText()).toBe('retry.ts, cart.ts · 1 changed');
    expect(await checkout.locator('i').innerText()).toBe('2 files');
    expect(await checkout.locator('.atlas-doc').innerText()).toBe('† docs/CHECKOUT.md');

    await page.locator('.rp-tab', { hasText: 'Heralds' }).click();
    const shared = page.locator('.rp-section', { hasText: 'Shared Atlas concepts' });
    await shared.locator('.atlas-list li').first().waitFor();
    expect(await shared.locator('.atlas-list li').allInnerTexts()).toEqual([
      expect.stringMatching(/Cart totals drift[\s\S]*feature:checkout/),
    ]);
    await shared.getByRole('button', { name: 'Cart totals drift' }).click();
    await page.locator('.context-bar-title', { hasText: 'Cart totals drift' }).waitFor();

    // Work: the diff viewer is announced, not built.
    await page.locator('.rp-tab', { hasText: 'Work' }).click();
    await page
      .locator('.work .rp-section-title', { hasText: 'Diff viewer' })
      .locator('.coming-soon')
      .waitFor();

    // A project with no Atlas: the set-up call, marked not built.
    await page.goto(`http://127.0.0.1:${server.port}/#thread=plain-1`);
    await page.locator('.context-bar-title', { hasText: 'No atlas here' }).waitFor();
    await page.locator('.rp-tab', { hasText: 'Context' }).click();
    await page.locator('.atlas-cta b', { hasText: 'plain has no Atlas yet' }).waitFor();
    const cta = page.getByRole('button', { name: 'Set up Atlas · not built' });
    await cta.waitFor();
    expect(await cta.isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
