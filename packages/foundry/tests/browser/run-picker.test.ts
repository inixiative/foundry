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
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// What a thread runs on (Aron 11-02): the header names worker · model · effort, effort always shown;
// clicking it picks the worker (those with a login), the model (that worker's) and the effort (that
// model's) for this thread; "+ New thread" offers the same choice before the first message.

type Route = {
  request(): { method(): string; postDataJSON(): Record<string, unknown> };
  fulfill(r: object): unknown;
  continue(): unknown;
};

const WORKERS = [
  {
    id: 'claude-code',
    label: 'Claude Code (CLI subscription)',
    default: true,
    defaultModel: 'claude-opus-5-5',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Opus 5.5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      {
        id: 'haiku',
        label: 'Haiku 5.5',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
    ],
  },
  {
    id: 'muse',
    label: 'Muse Code (Meta subscription)',
    default: false,
    defaultModel: 'muse-wonder-1.0',
    models: [
      {
        id: 'muse-wonder-1.0',
        label: 'Muse Wonder 1.0',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      {
        id: 'muse-spark-1.2',
        label: 'Muse Spark 1.2',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      },
    ],
  },
];
const UNAVAILABLE = [
  {
    id: 'codex',
    label: 'Codex CLI (OpenAI subscription)',
    reason: 'no Codex login on this machine',
  },
];

const launchOf = (threadId: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  provider: 'claude-code',
  worker: 'claude-code',
  model: 'claude-opus-5-5',
  modelOverride: null,
  effort: null,
  effortDefault: 'high',
  workerLock: null,
  permissionMode: null,
  options: {
    models: WORKERS[0]!.models,
    efforts: WORKERS[0]!.models[0]!.efforts,
    workers: WORKERS,
    unavailableWorkers: UNAVAILABLE,
  },
  ...extra,
});

async function open(width = 1280) {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-run-picker-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  const projects = new ProjectRegistry();
  const project = projects.register({
    id: 'shop',
    label: 'acme-shop',
    path: join(dir, 'shop'),
    tags: [],
    runtime: 'claude-code',
  });
  for (const id of ['shop-1', 'shop-2'])
    project.addThread(new Thread(id, new ContextStack(), { description: id, projectId: 'shop' }));
  const configStore = new ConfigStore(dir);
  const config = starterConfig('controlled', 'controlled');
  config.agents = defaultAgents();
  config.setupComplete = true;
  config.projects.shop = { id: 'shop', path: join(dir, 'shop'), label: 'acme-shop', tags: [] };
  await configStore.save(config);
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    tokenTracker: new TokenTracker(),
    configStore,
    configDir: dir,
    projectRegistry: projects,
    actionQueue: new ActionQueue(),
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
  const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  return { cleanup, page, errors, origin: `http://127.0.0.1:${server.port}` };
}

test('the header names worker · model · effort; its picker switches this thread to Muse', async () => {
  const { cleanup, page, errors, origin } = await open();
  try {
    let launch = launchOf('shop-1');
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    await page.route('**/api/threads/shop-1/launch', (route: Route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        sent.push({ path: 'launch', body });
        launch = { ...launch, ...body, modelOverride: body.model as null };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(launch) });
    });
    await page.route('**/api/threads/shop-1', (route: Route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const body = route.request().postDataJSON();
      sent.push({ path: 'thread', body });
      launch = { ...launch, worker: 'muse', provider: 'muse', model: 'muse-wonder-1.0' };
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ threadId: 'shop-1', meta: { projectId: 'shop', worker: 'muse' } }),
      });
    });
    await page.goto(`${origin}/#thread=shop-1`);
    // No effort chosen: the pill still names the one the thread runs at.
    const pill = page.locator('.band-runs .band-pills .band-run');
    await pill.waitFor();
    expect((await pill.textContent())?.replace(/\s+/g, ' ')).toMatch(
      /Claude Code · Opus 5\.5 · high/,
    );
    // The worker is the part that drops when the group is tight, never the model or effort.
    expect(await pill.locator('.band-drop').innerText()).toContain('Claude Code');

    await pill.click();
    const modal = page.locator('.run-modal');
    await modal.waitFor();
    // Only workers with a login are offered; the rest say why.
    expect(await modal.locator('[data-run="worker"] option').allInnerTexts()).toEqual([
      'Claude Code (default)',
      'Muse',
    ]);
    expect(await modal.locator('[data-note="unavailable"]').innerText()).toContain(
      "Codex isn't available: no Codex login on this machine",
    );
    expect(await modal.locator('[data-run="effort"] option').first().innerText()).toBe(
      'high (default)',
    );
    // Muse: its own models, the personal line, and a fresh session (nothing has run yet).
    await modal.locator('[data-run="worker"]').selectOption('muse');
    expect(await modal.locator('[data-run="model"] option').allInnerTexts()).toEqual([
      'Muse Wonder 1.0 (default)',
      'Muse Spark 1.2',
    ]);
    expect(await modal.locator('[data-note="muse-personal"]').innerText()).toContain(
      'personal Archive',
    );
    expect(await modal.innerText()).toContain('fresh session');
    await modal.locator('[data-run="model"]').selectOption('muse-spark-1.2');
    // That model's levels only: no max.
    expect(await modal.locator('[data-run="effort"] option').allInnerTexts()).toEqual([
      'high (default)',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    await modal.locator('[data-run="effort"]').selectOption('medium');
    await modal.locator('[data-run="apply"]').click();
    await modal.waitFor({ state: 'detached' });
    // The worker first (rebuilt before its first turn), then the model and effort.
    expect(sent).toEqual([
      { path: 'thread', body: { worker: 'muse' } },
      { path: 'launch', body: { model: 'muse-spark-1.2', effort: 'medium' } },
    ]);
    await page.locator('.band-run', { hasText: 'Muse Spark 1.2 · medium' }).first().waitFor();
    expect(await pill.locator('.band-drop').innerText()).toContain('Muse');
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);

test('a started thread switches worker mid-conversation: what carries over, Muse goes personal, and the transcript marks it', async () => {
  const { cleanup, page, errors, origin } = await open();
  try {
    let launch: Record<string, unknown> = launchOf('shop-2', {
      effort: 'xhigh',
      started: true,
      switches: [],
      projectId: 'shop',
      projectLabel: 'acme-shop',
    });
    const sent: Array<Record<string, unknown>> = [];
    await page.route('**/api/threads/shop-2/launch', (route: Route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(launch) }),
    );
    await page.route('**/api/threads/shop-2', (route: Route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      sent.push(route.request().postDataJSON());
      launch = {
        ...launch,
        worker: 'muse',
        provider: 'muse',
        model: 'muse-wonder-1.0',
        effort: null,
        switches: [
          {
            at: Date.now(),
            from: 'claude-code',
            to: 'muse',
            fromLabel: 'Claude Code',
            toLabel: 'Muse',
          },
        ],
      };
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ threadId: 'shop-2', meta: { projectId: 'shop', worker: 'muse' } }),
      });
    });
    await page.goto(`${origin}/#thread=shop-2`);
    const pill = page.locator('.band-runs .band-pills .band-run');
    await pill.waitFor();
    await pill.click();
    const modal = page.locator('.run-modal');
    await modal.waitFor();
    // After the first turn the worker still changes; one line says what carries over.
    expect(await modal.locator('[data-run="worker"]').isDisabled()).toBe(false);
    expect(await modal.locator('[data-note="worker-lock"]').count()).toBe(0);
    await modal.locator('[data-run="worker"]').selectOption('muse');
    expect(await modal.locator('[data-note="carry-over"]').innerText()).toBe(
      "Continues on a fresh Muse session that carries the conversation and plan, not the old session's files read or tool state.",
    );
    expect(await modal.locator('[data-note="muse-personal"]').innerText()).toBe(
      "Muse is personal: from here this thread goes to your personal Archive, not acme-shop's.",
    );
    await modal.locator('[data-run="apply"]').click();
    await modal.waitFor({ state: 'detached' });
    expect(sent).toEqual([{ worker: 'muse' }]);
    await page.locator('.toast', { hasText: 'Continued on Muse from here' }).first().waitFor();
    // The transcript marks where it moved.
    const marker = page.locator('.worker-switch-marker');
    await marker.waitFor();
    expect(await marker.innerText()).toContain('Continued on Muse from here');
    // Moving off Muse later: the thread stays personal.
    await pill.click();
    await modal.waitFor();
    await modal.locator('[data-run="worker"]').selectOption('claude-code');
    expect(await modal.locator('[data-note="muse-personal"]').innerText()).toContain(
      'This thread stays personal: it ran on Muse',
    );
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);

test('while a turn runs the worker waits; the picker says why and still offers a new thread', async () => {
  const { cleanup, page, errors, origin } = await open();
  try {
    await page.route('**/api/threads/shop-2/launch', (route: Route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          launchOf('shop-2', {
            effort: 'xhigh',
            started: true,
            switches: [],
            workerLock: 'a turn is running or queued; switch once it ends',
          }),
        ),
      }),
    );
    await page.route('**/api/projects/shop/workers', (route: Route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ workers: WORKERS, unavailable: UNAVAILABLE }),
      }),
    );
    await page.goto(`${origin}/#thread=shop-2`);
    const pill = page.locator('.band-runs .band-pills .band-run');
    await pill.waitFor();
    expect((await pill.textContent())?.replace(/\s+/g, ' ')).toMatch(/Opus 5\.5 · xhigh/);
    await pill.click();
    const modal = page.locator('.run-modal');
    expect(await modal.locator('[data-run="worker"]').isDisabled()).toBe(true);
    expect(await modal.locator('[data-note="worker-lock"]').innerText()).toContain(
      "can't change right now: a turn is running",
    );
    await modal.locator('.run-picker-link', { hasText: 'New thread' }).click();
    await page.locator('.new-thread-modal [data-run="worker"]').waitFor();
    expect(await page.locator('.run-modal').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);

test('"+ New thread" picks worker, model and effort before the first message, from the defaults', async () => {
  const { cleanup, page, errors, origin } = await open();
  try {
    await page.route('**/api/threads/shop-1/launch', (route: Route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(launchOf('shop-1')) }),
    );
    await page.route('**/api/projects/shop/workers', (route: Route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ workers: WORKERS, unavailable: UNAVAILABLE }),
      }),
    );
    const created: Record<string, unknown>[] = [];
    await page.route('**/api/threads', (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      created.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          threadId: 'shop-muse',
          meta: { projectId: 'shop', worker: 'muse', tags: [] },
        }),
      });
    });
    await page.goto(`${origin}/#thread=shop-1`);
    await page.locator('.rail-new-thread').click();
    const modal = page.locator('.new-thread-modal');
    await modal.locator('[data-run="worker"]').waitFor();
    // The project's defaults come first: its worker, that worker's model, the model's effort.
    expect(await modal.locator('[data-run="worker"]').inputValue()).toBe('claude-code');
    expect(await modal.locator('[data-run="model"]').inputValue()).toBe('claude-opus-5-5');
    expect(await modal.locator('[data-run="effort"]').inputValue()).toBe('');
    await modal.locator('[data-run="worker"]').selectOption('muse');
    expect(await modal.locator('[data-run="model"]').inputValue()).toBe('muse-wonder-1.0');
    expect(await modal.locator('[data-note="muse-personal"]').count()).toBe(1);
    await modal.locator('[data-run="effort"]').selectOption('low');
    await modal.locator('[data-run="name"]').fill('  Checkout flow  ');
    await modal.locator('[data-run="start"]').click();
    await modal.waitFor({ state: 'detached' });
    // The default model is no choice (the thread follows its worker's default); the effort and a name are.
    expect(created).toEqual([
      { projectId: 'shop', name: 'Checkout flow', worker: 'muse', effort: 'low' },
    ]);
    // Defaults all round send nothing extra.
    await page.locator('.rail-new-thread').click();
    await modal.locator('[data-run="start"]:not([disabled])').click();
    await modal.waitFor({ state: 'detached' });
    expect(created[1]).toEqual({ projectId: 'shop' });
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);
