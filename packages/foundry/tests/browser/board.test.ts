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

// The attention board: every open thread on a column of its status colour. A pending approval sits
// under Needs you and is answered from its card; a project filter narrows the columns; Back returns
// to the thread.
test('the board: a pending approval is answered from its card, filters narrow it, b and Back toggle it', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-board-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    for (const [id, label, threads] of [
      ['shop', 'acme-shop', ['Checkout errors since 2:02']],
      ['docs', 'Docs', ['Rewrite the setup guide']],
    ] as const) {
      const project = projects.register({
        id,
        label,
        path: join(dir, id),
        tags: [],
        runtime: 'claude-code',
      });
      for (const name of threads) {
        const thread = new Thread(`${id}-1`, new ContextStack(), {
          description: name,
          projectId: id,
        });
        if (id === 'docs') thread.meta.status = 'active';
        project.addThread(thread);
      }
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
    const answered = queue.prompt({
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

    // A request to join sits apart from the columns, as Incoming: not accepted, decided in Kingdom.
    await page.route('**/api/kingdom/incoming', (route: { fulfill: (r: object) => unknown }) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          requests: [
            {
              id: 'req-1',
              kingdomUrl: 'https://kingdom.example',
              requester: "Sam's agent",
              requesterModel: 'Integration',
              createdAt: '2026-11-01T10:00:00.000Z',
              expiresAt: null,
              name: 'Review the checkout thread',
              lifecycle: 'task',
              maxRequests: 50,
              until: null,
              operations: ['thread.read'],
              reviewUrl: 'https://kingdom.example/dashboard?integration=i&signetRequest=req-1',
            },
          ],
        }),
      }),
    );
    await page.goto(`http://127.0.0.1:${server.port}/#thread=docs-1`);
    await page.locator('.context-bar-title', { hasText: 'Rewrite the setup guide' }).waitFor();
    await page.locator('.incoming-indicator', { hasText: '1' }).waitFor();
    await page.keyboard.press('b');
    const incomingCard = page.locator('.board-incoming .incoming-card');
    await incomingCard.waitFor();
    expect(await incomingCard.innerText()).toContain("Sam's agent asks to join your threads");
    expect(await incomingCard.innerText()).toContain(
      'Nothing runs until you accept it in Kingdom.',
    );
    expect(
      await incomingCard.locator('a', { hasText: 'Review in Kingdom' }).getAttribute('href'),
    ).toBe('https://kingdom.example/dashboard?integration=i&signetRequest=req-1');
    const needs = page.locator('.board-column--attention');
    const working = page.locator('.board-column--working');
    await needs.locator('.board-card', { hasText: 'Checkout errors since 2:02' }).waitFor();
    expect(await needs.locator('.board-card-ask').innerText()).toBe(
      'Allow git push origin fix/checkout?',
    );
    await working.locator('.board-card', { hasText: 'Rewrite the setup guide' }).waitFor();
    expect(await page.locator('.board-button-count').innerText()).toBe('1');

    // A project filter narrows every column.
    await page.locator('.board-filter', { hasText: 'Docs' }).click();
    await until(async () => (await needs.locator('.board-card').count()) === 0, 'Docs only');
    expect(await working.locator('.board-card').count()).toBe(1);
    await page.locator('.board-filter', { hasText: 'Everything' }).click();

    // One tap answers the prompt; the card leaves Needs you.
    await needs.locator('.board-card button', { hasText: 'Approve' }).click();
    expect((await answered).action).toBe('approve');
    await until(async () => (await needs.locator('.board-card').count()) === 0, 'card left');

    // Back returns to the thread.
    await page.locator('.board .rp-back').click();
    await page.locator('.context-bar-title', { hasText: 'Rewrite the setup guide' }).waitFor();

    // The board is a workspace view: Settings and Analytics have no Board button, `b` does nothing
    // there, and leaving the workspace with the board open leaves the board. No Gloss button until a
    // Gloss viewer exists.
    expect(await page.locator('.gloss-launch').count()).toBe(0);
    await page.keyboard.press('b');
    await page.locator('.board').waitFor();
    for (const name of ['Settings', 'Analytics']) {
      await page.locator('.page-nav a', { hasText: name }).click();
      await until(async () => (await page.locator('.board').count()) === 0, `${name}: no board`);
      expect(await page.locator('.board-button').count()).toBe(0);
      await page.keyboard.press('b');
      expect(await page.locator('.board').count()).toBe(0);
    }
    await page.locator('.page-nav a', { hasText: 'Workspace' }).click();
    await page.locator('.board-button').waitFor();
    expect(await page.locator('.board').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
