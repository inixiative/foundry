import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskLifecycle } from '@inixiative/agent-session';
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

type Emit = (threadId: string, task: TaskLifecycle, at: number, stop?: () => Promise<void>) => void;

// Running lists the background processes the thread's agent started (from the session's task
// lifecycle), with Stop when the session can stop one; a stopped one shows how it ended.
test('Running shows a background process with Stop, and the stop it reports', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-running-'));
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
    project.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: 'Watch the build',
        projectId: 'shop',
      }),
    );
    let emit: Emit = () => {};
    const stops: string[] = [];
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
      taskSources: [
        {
          observeTasks: (fn: Emit) => {
            emit = fn;
            return () => {};
          },
        },
      ],
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    const task: TaskLifecycle = {
      phase: 'started',
      taskId: 'bg-1',
      taskType: 'local_bash',
      description: 'bun run dev',
    };
    emit('shop-1', task, Date.now(), async () => {
      stops.push('bg-1');
      emit('shop-1', { ...task, phase: 'ended', status: 'stopped' }, Date.now());
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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    const running = page.locator('.running');
    const row = running.locator('.running-row', { hasText: 'bun run dev' });
    await row.waitFor();
    expect(await running.locator('.running-head').innerText()).toContain('1 live');
    await row.getByRole('button', { name: 'Stop' }).click();
    await row.locator('.running-state', { hasText: 'stopped' }).waitFor();
    expect(stops).toEqual(['bg-1']);
    expect(await running.locator('.running-head').innerText()).toContain('0 live');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
