import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { buildAgents, ThreadFactory } from '../../src/agents/thread-factory';
import { ConfigStore, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);
const repoRoot = resolve(import.meta.dir, '../../../..');
const OUTPUT =
  'Opened https://github.com/inixiative/foundry/pull/60 for https://linear.app/inixiative/issue/ENG-42/thread-names';

test('thread names: the agent name shows until a person names the thread; branch, PR and ticket chips link out', async () => {
  const out = resolve(
    repoRoot,
    '.foundry/qa',
    `thread-names-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'foundry-thread-names-'));
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'foundry-thread-names-git-')));
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', checkout, ...args], { stderr: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:inixiative/foundry.git');
  git('checkout', '-q', '-b', 'feat/thread-names-and-context');

  const provider: LLMProvider = {
    id: 'mock',
    complete: async () => ({ content: OUTPUT, model: 'mock' }),
    stream: async function* () {
      yield { type: 'text', text: OUTPUT };
    },
  };
  let decisions = 0;
  const namingProvider: LLMProvider = {
    id: 'decisions',
    complete: async () => {
      decisions++;
      return { model: 'mock', content: '{"title":"Ship self-maintained thread names"}' };
    },
  };
  const config = starterConfig('mock', 'mock');
  config.setupComplete = true;
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'mock',
      model: 'mock',
      prompt: 'Execute',
      temperature: 0,
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  const configStore = new ConfigStore(dir);
  await configStore.save(config);
  const stack = new ContextStack();
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }) });
  const thread = factory.create('main', { description: 'Main conversation thread', cwd: checkout });
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configStore,
    configDir: dir,
    threadFactory: factory,
    namingProvider,
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: viewer.fetch,
    websocket: viewer.websocket,
  });
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  const until = async (predicate: () => boolean, label: string) => {
    const end = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error(`timed out: ${label}`);
      await Bun.sleep(20);
    }
  };
  try {
    const sent = await viewer.app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Make threads name themselves', threadId: 'main' }),
    });
    expect(sent.status).toBe(200);
    await until(
      () => !!thread.meta.agentName && !!thread.meta.context?.references.length,
      'agent name and linked work',
    );
    expect(decisions).toBe(1);

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);

    const header = page.locator('.context-bar-head');
    const treeLabel = page.locator('.tree-label').first();
    await header
      .locator('.context-bar-title', { hasText: 'Ship self-maintained thread names' })
      .waitFor();
    expect(await header.locator('.context-bar-title').getAttribute('data-name-source')).toBe(
      'agent',
    );
    expect(await header.locator('.context-bar-name-source').innerText()).toBe('auto');
    expect(await treeLabel.innerText()).toBe('Ship self-maintained thread names');
    expect(await header.locator('.context-bar-chip--branch').innerText()).toBe(
      'feat/thread-names-and-context',
    );
    const pr = header.locator('a.thread-ref--github');
    expect(await pr.innerText()).toBe('#60');
    expect(await pr.getAttribute('href')).toBe('https://github.com/inixiative/foundry/pull/60');
    const ticket = header.locator('a.thread-ref--linear');
    expect(await ticket.innerText()).toBe('ENG-42');
    expect(await ticket.getAttribute('href')).toBe('https://linear.app/inixiative/issue/ENG-42');
    expect(await page.locator('.tree-node a.thread-ref--github').innerText()).toBe('#60');
    await page.screenshot({ path: join(out, '1-agent-name.png') });

    if (!(await page.locator('.thread-name-editor').count()))
      await page.locator('.panel-collapse-strip').click();
    const editor = page.locator('.thread-name-editor');
    expect(await editor.locator('.thread-name-source').innerText()).toBe('named by agent');
    await editor.locator('.thread-name-input').fill('Aron: names + context');
    await editor.getByRole('button', { name: 'Save' }).click();
    await header.locator('.context-bar-title', { hasText: 'Aron: names + context' }).waitFor();
    expect(await header.locator('.context-bar-title').getAttribute('data-name-source')).toBe(
      'human',
    );
    expect(await header.locator('.context-bar-name-source').count()).toBe(0);
    await page.locator('.tree-label', { hasText: 'Aron: names + context' }).waitFor();
    expect(await editor.locator('.thread-name-agent').innerText()).toBe(
      'Agent name: Ship self-maintained thread names',
    );
    expect(thread.meta.name?.text).toBe('Aron: names + context');
    await page.screenshot({ path: join(out, '2-human-name.png') });

    // The human name is a hard override: further turns never run a naming decision.
    await viewer.app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Keep going', threadId: 'main' }),
    });
    await Bun.sleep(50);
    expect(decisions).toBe(1);
    expect(await header.locator('.context-bar-title').innerText()).toBe('Aron: names + context');

    await editor.getByRole('button', { name: 'Use agent name' }).click();
    await header
      .locator('.context-bar-title', { hasText: 'Ship self-maintained thread names' })
      .waitFor();
    expect(await header.locator('.context-bar-title').getAttribute('data-name-source')).toBe(
      'agent',
    );
    expect(thread.meta.name).toBeUndefined();
    await page.screenshot({ path: join(out, '3-agent-name-restored.png') });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    viewer.localStore?.close();
    for (const t of viewer.directory.all()) t.dispose();
    rmSync(dir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
}, 60_000);
