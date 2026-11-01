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

// A long approval (a script, SQL) shows a 3-line preview in the waiting stack; the whole command opens
// in its own window, where it can be approved or rejected.
test('a long approval shows a preview and opens the whole command in its own window', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-bigapproval-'));
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
    const sql = [
      'BEGIN;',
      "UPDATE signet_grant SET view = 'thread'",
      " WHERE resource = 'threads' AND view = 'own';",
      'DELETE FROM thread_view_cache WHERE stale = true;',
      'COMMIT;',
    ].join('\n');
    queue.prompt({
      kind: 'approval',
      message: 'Run this SQL against the dev database?',
      capability: 'exec:shell',
      meta: { toolName: 'Bash', toolInput: { command: sql } },
      agentId: 'worker',
      threadId: 'docs-1',
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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=docs-1`);
    await page.locator('.prompt-card-preview').waitFor();
    expect(await page.locator('.prompt-card-preview').innerText()).toContain('BEGIN;');
    expect(await page.locator('.prompt-card-preview').innerText()).not.toContain('COMMIT;');
    await page.getByRole('button', { name: /View full command · 5 lines/ }).click();
    const modal = page.getByRole('dialog', { name: 'Approve a command' });
    await modal.waitFor();
    expect(await modal.locator('.command-modal-code').innerText()).toContain('COMMIT;');
    await modal.getByRole('button', { name: 'Approve' }).click();
    await until(
      async () => (await page.locator('.prompt-card-preview').count()) === 0,
      'approved and gone',
    );
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
