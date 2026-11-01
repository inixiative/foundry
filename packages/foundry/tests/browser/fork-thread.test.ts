import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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

// /fork in the Actions palette forks at the latest message: a new top-level thread opens, its header
// says where it came from ("forked from <source> · turn N"), and that link opens the source again.
test('/fork makes a top-level thread that names its source and turn', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-fork-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: dir,
      tags: [],
      runtime: 'claude-code',
    });
    const source = new Thread('shop-1', new ContextStack(), {
      description: 'Cap checkout retries',
      projectId: 'shop',
    });
    project.addThread(source);
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
    for (const [id, ask] of [
      ['turn-1', 'Find why checkout fails'],
      ['turn-2', 'Cap the retries at three'],
    ]) {
      store.beginTurn(source, id, ask);
      store.completeTurn(
        source,
        id,
        `Done: ${ask}`,
        {},
        {
          id: `trace-${id}`,
          messageId: id,
          startedAt: 1,
          root: {},
          summary: {},
          spans: [],
        },
      );
    }
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
    const title = page.locator('.context-bar-title');
    await title.filter({ hasText: 'Cap checkout retries' }).waitFor();
    await page.locator('.chat-msg', { hasText: 'Done: Cap the retries at three' }).waitFor();
    await page.locator('textarea.chat-input').click();
    await page.keyboard.type('/');
    await page.locator('.action-palette').waitFor();
    await page.keyboard.type('fork');
    await page.keyboard.press('Enter');

    // The fork opens: a new thread, top-level, naming its source and the turn it was cut at.
    await title.filter({ hasText: 'Fork of Cap checkout retries' }).waitFor();
    const link = page.locator('.fork-link');
    await link.filter({ hasText: 'turn 2' }).waitFor();
    expect((await link.textContent())?.replace(/\s+/g, ' ').trim()).toBe(
      'forked from Cap checkout retries · turn 2',
    );
    const forkId = await page.evaluate(() =>
      new URLSearchParams(location.hash.slice(1)).get('thread'),
    );
    expect(forkId).not.toBe('shop-1');
    const fork = viewer.directory.get(forkId!);
    expect(fork?.meta.forkedFrom?.threadId).toBe('shop-1');
    expect(fork?.meta.parentThreadId).toBeUndefined();

    // The link opens the source again.
    await link.click();
    await title.filter({ hasText: 'Cap checkout retries' }).waitFor();
    expect(await page.locator('.fork-link').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
