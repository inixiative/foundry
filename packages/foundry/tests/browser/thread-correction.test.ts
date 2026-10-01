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
  type Signal,
  Thread,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../../src/agents/project';
import { ConfigStore, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// A correction submitted from a trace's span detail lands on the bus of the thread that owns the trace.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('the viewer correction form submits to the thread the trace belongs to, not main', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-thread-correction-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const main = new Thread('main', new ContextStack(), { description: 'Main', projectId: 'P' });
    const other = new Thread('other', new ContextStack(), { description: 'Other', projectId: 'P' });
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'P',
      path: dir,
      label: 'P',
      tags: [],
      runtime: 'claude-code',
    });
    project.addThread(main);
    project.addThread(other);
    const onMain: Signal[] = [],
      onOther: Signal[] = [];
    main.signals.on('correction', (s) => {
      onMain.push(s);
    });
    other.signals.on('correction', (s) => {
      onOther.push(s);
    });
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.setupComplete = true;
    await configStore.save(config);
    const interventions = new InterventionLog();
    const viewer = createViewer({
      harness: new Harness(main),
      eventStream: new EventStream(),
      interventions,
      configStore,
      configDir: dir,
      projectRegistry: projects,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    const store = viewer.localStore!;
    const turnId = 'turn-other',
      started = Date.now() - 60_000;
    store.beginTurn(other, turnId, 'Which agent should handle this?');
    const route = {
      id: 'span-route',
      parentId: 'span-ingress',
      name: 'route',
      kind: 'route',
      threadId: other.id,
      status: 'ok',
      input: 'q',
      output: { agentId: 'worker' },
      annotations: {},
      startedAt: started + 1,
      endedAt: started + 5,
      durationMs: 4,
      children: [],
    };
    const ingress = {
      id: 'span-ingress',
      name: 'ingress',
      kind: 'ingress',
      threadId: other.id,
      status: 'ok',
      input: 'q',
      annotations: {},
      startedAt: started,
      endedAt: started + 10,
      durationMs: 10,
    };
    store.completeTurn(
      other,
      turnId,
      'Routed to worker',
      { executionOutcome: 'completed', persistence: 'committed', turnStatus: 'completed' },
      {
        id: 'trace-other',
        messageId: turnId,
        startedAt: started,
        endedAt: started + 10,
        durationMs: 10,
        root: { ...ingress, children: [route] },
        summary: {
          traceId: 'trace-other',
          messageId: turnId,
          totalDurationMs: 10,
          spanCount: 2,
          stages: [],
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
    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=other`);
    const agent = page.locator('.chat-agent').filter({ hasText: 'Routed to worker' }).first();
    await agent.waitFor();
    await agent.locator('.chat-trace-btn').click();
    await page.getByRole('button', { name: 'Spans', exact: true }).click();
    await page.locator('.span-row').filter({ hasText: 'route' }).first().click();
    await page.locator('.detail-section-header').filter({ hasText: 'Correction' }).click();
    await page.locator('.override-input').fill('OTHER_THREAD_CORRECTION');
    const posted = page.waitForResponse(
      (r: any) => r.url().includes('/interventions') && r.request().method() === 'POST',
    );
    await page.locator('.override-submit').click();
    const response = await posted;
    expect(new URL(response.url()).pathname).toBe('/api/threads/other/interventions');
    expect(response.status()).toBe(201);
    expect(interventions.history[0]).toMatchObject({
      threadId: 'other',
      traceId: 'trace-other',
      spanId: 'span-route',
      correction: 'OTHER_THREAD_CORRECTION',
    });
    expect(onOther).toHaveLength(1);
    expect(onMain).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
