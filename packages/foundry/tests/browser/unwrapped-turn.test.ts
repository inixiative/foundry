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
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../../src/agents/project';
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// A fresh install's turn: the message went straight to the executor. The trace is ingress and execute
// only, with no plan and no layers, and the conversation shows the executor and nothing before it.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('an unwrapped turn renders without a pre bar, decision badges or unavailable placeholders', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-unwrapped-turn-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const main = new Thread('main', new ContextStack(), { description: 'Main', projectId: 'P' });
    const projects = new ProjectRegistry();
    projects
      .register({ id: 'P', path: dir, label: 'P', tags: [], runtime: 'claude-code' })
      .addThread(main);
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(main),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    const store = viewer.localStore!;
    const turnId = 'turn-unwrapped',
      started = Date.now() - 60_000;
    store.beginTurn(main, turnId, 'Add a login endpoint');
    const span = (id: string, name: string, kind: string, durationMs: number) => ({
      id,
      name,
      kind,
      threadId: main.id,
      status: 'ok',
      input: 'Add a login endpoint',
      annotations: {},
      startedAt: started,
      endedAt: started + durationMs,
      durationMs,
    });
    const execute = {
      ...span('span-execute', 'execute:executor', 'execute', 90),
      agentId: 'executor',
      parentId: 'span-ingress',
      children: [],
    };
    store.completeTurn(
      main,
      turnId,
      'UNWRAPPED_ANSWER',
      { executionOutcome: 'completed', persistence: 'committed', turnStatus: 'completed' },
      {
        id: 'trace-unwrapped',
        messageId: turnId,
        startedAt: started,
        endedAt: started + 100,
        durationMs: 100,
        root: { ...span('span-ingress', 'ingress', 'ingress', 100), children: [execute] },
        summary: {
          traceId: 'trace-unwrapped',
          messageId: turnId,
          totalDurationMs: 100,
          spanCount: 2,
          stages: [
            { name: 'ingress', kind: 'ingress', status: 'ok', durationMs: 100, depth: 0 },
            {
              name: 'execute:executor',
              kind: 'execute',
              status: 'ok',
              durationMs: 90,
              agentId: 'executor',
              depth: 1,
            },
          ],
        },
        spans: [],
      } as any,
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
      await browser.newContext({ viewport: { width: 1440, height: 960 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=main`);
    const agent = page.locator('.chat-agent').filter({ hasText: 'UNWRAPPED_ANSWER' }).first();
    await agent.waitFor();
    expect(await agent.locator('.pipeline-pre').count()).toBe(0);
    expect(await agent.locator('.chat-badge.classify, .chat-badge.route').count()).toBe(0);
    expect(await agent.locator('.chat-badge.exec').innerText()).toContain('executor');
    expect(await agent.locator('.chat-layers').count()).toBe(0);
    expect((await agent.innerText()).toLowerCase()).not.toContain('unavailable');
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
