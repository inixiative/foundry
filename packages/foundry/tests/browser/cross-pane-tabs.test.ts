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

test('cross-pane tab placement moves tabs between Left Rail and Right Panel with hotkeys, empty states, collapsed strip, command palette, and safe-ui bypass', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-cross-pane-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: join(dir, 'shop'),
      tags: [],
      runtime: 'claude-code',
    });
    const thread = new Thread('shop-1', new ContextStack(), {
      description: 'Checkout redesign',
      projectId: 'shop',
    });
    thread.meta.plan = {
      outcomes: [
        { text: 'Plan renders in Left Rail', status: 'done' },
        { text: 'Status renders in Right Panel', status: 'todo' },
      ],
      pains: [],
      strategy: [{ text: 'Let users arrange panels on either side' }],
      reasons: [],
      technical: [],
      updatedAt: Date.now(),
    };
    project.addThread(thread);

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.projects.shop = { id: 'shop', path: join(dir, 'shop'), label: 'acme-shop' };
    await configStore.save(config);

    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      localStore: null,
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const origin = `http://127.0.0.1:${server.port}`;

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1500, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    // 1. Move Plan (Right Panel -> Left Rail) and Status (Left Rail -> Right Panel) in Settings -> Appearance.
    await page.goto(`${origin}/settings/appearance`);
    await page.locator('h1.settings-title', { hasText: 'Appearance' }).waitFor();

    await page
      .locator('[data-slot-group="rightPanel.tabs"] [data-tab-row="plan"] [data-move-tab="plan"]')
      .click();
    const movedPlanBtn = page.locator(
      '[data-slot-group="leftRail.tabs"] [data-tab-row="plan"] [data-reset-tab="plan"]',
    );
    await movedPlanBtn.waitFor();
    expect(await movedPlanBtn.innerText()).toBe('Return to Right');

    await page
      .locator('[data-slot-group="leftRail.tabs"] [data-tab-row="status"] [data-move-tab="status"]')
      .click();
    const movedStatusBtn = page.locator(
      '[data-slot-group="rightPanel.tabs"] [data-tab-row="status"] [data-reset-tab="status"]',
    );
    await movedStatusBtn.waitFor();
    expect(await movedStatusBtn.innerText()).toBe('Return to Left');

    // 2. Open workspace with active thread: Plan is in Left Rail (absent from Right Panel),
    // Status is in Right Panel (absent from Left Rail).
    await page.goto(`${origin}/#thread=shop-1&detail=1`);
    await page.locator('textarea.chat-input').waitFor();
    await page.locator('.rail-toggle-btn[data-rail-id="plan"]').waitFor();
    await page.locator('.rp-tab[data-rtab-id="status"]').waitFor();
    expect(await page.locator('.rp-tab[data-rtab-id="plan"]').count()).toBe(0);
    expect(await page.locator('.rail-toggle-btn[data-rail-id="status"]').count()).toBe(0);

    // Clicking Plan in Left Rail renders the thread's plan cleanly.
    await page.locator('.rail-toggle-btn[data-rail-id="plan"]').click();
    await page.locator('.nav-rail .plan', { hasText: 'Plan renders in Left Rail' }).waitFor();
    await page.locator('.nav-rail .rp-title', { hasText: 'Plan' }).waitFor();

    // Pressing Alt+2 (Plan's hotkey) activates Plan in Left Rail even after switching tabs or folding the rail.
    await page.locator('.rail-toggle-btn[data-rail-id="attention"]').click();
    await page.locator('.rail-toggle-btn.is-active[data-rail-id="attention"]').waitFor();
    await page.locator('.chat-input').focus();
    await page.keyboard.press('Alt+Digit2');
    await page.locator('.rail-toggle-btn.is-active[data-rail-id="plan"]').waitFor();
    await page.locator('.nav-rail .plan', { hasText: 'Plan renders in Left Rail' }).waitFor();

    // Folding Left Rail to strip and pressing Alt+2 reopens Left Rail directly on Plan.
    await page.keyboard.press('Alt+BracketLeft');
    await page.locator('.panels--proj-closed').waitFor();
    await page.keyboard.press('Alt+Digit2');
    await page.locator('.rail-toggle-btn.is-active[data-rail-id="plan"]').waitFor();
    await page.locator('.nav-rail .plan', { hasText: 'Plan renders in Left Rail' }).waitFor();

    // Step Left Rail with Alt+Comma / Alt+Period cycles into moved Plan tab.
    await page.keyboard.press('Alt+Period');
    await page.locator('.rail-toggle-btn.is-active[data-rail-id="attention"]').waitFor();
    await page.keyboard.press('Alt+Comma');
    await page.locator('.rail-toggle-btn.is-active[data-rail-id="plan"]').waitFor();

    // 3. Status moved to Right Panel renders in expanded view + collapsed 44px strip with icon.
    await page.locator('.rp-tab[data-rtab-id="status"]').click();
    await page.locator('.right-panel .rp-title', { hasText: 'Status' }).waitFor();
    await page
      .locator('.right-panel .rp-info', { hasText: 'This machine, daemon health, and resources' })
      .waitFor();
    await page.locator('.right-panel .machine-status').waitFor();

    await page.locator('body').click({ position: { x: 800, y: 300 } });
    await page.keyboard.press('Alt+BracketRight');
    const stripStatus = page.locator(
      '.right-panel--collapsed .rp-strip-tab[data-rtab-id="status"]',
    );
    await stripStatus.waitFor();
    await stripStatus.locator('svg.tab-icon').waitFor();
    await stripStatus.click();
    await page.locator('.right-panel .machine-status').waitFor();

    // 4. With NO thread open (empty thread list snapshot), moved Plan in Left Rail shows a clean
    // empty-state prompt instead of crashing, while moved Status in Right Panel remains usable.
    const noThreadPage = await (
      await browser.newContext({ viewport: { width: 1500, height: 900 } })
    ).newPage();
    noThreadPage.setDefaultTimeout(15_000);
    noThreadPage.on('pageerror', (e: Error) => errors.push(e.message));
    await noThreadPage.routeWebSocket(
      /\/ws/,
      (ws: {
        connectToServer: () => { onMessage: (fn: (msg: string | Buffer) => void) => void };
        send: (msg: string | Buffer) => void;
      }) => {
        const upstream = ws.connectToServer();
        upstream.onMessage((msg) => {
          if (typeof msg === 'string') {
            try {
              const frame = JSON.parse(msg) as {
                type?: string;
                stream?: string;
                action?: string;
                payload?: { threads?: unknown[] };
              };
              if (
                frame.type === 'data' &&
                typeof frame.stream === 'string' &&
                frame.stream.startsWith('threads') &&
                frame.action === 'snapshot' &&
                frame.payload
              ) {
                frame.payload.threads = [];
                ws.send(JSON.stringify(frame));
                return;
              }
            } catch {
              // Pass through non-JSON frames untouched.
            }
          }
          ws.send(msg);
        });
      },
    );
    await noThreadPage.goto(`${origin}/#rail=plan&rtab=status&detail=1`);
    await noThreadPage
      .locator('.nav-rail .rail-empty', { hasText: 'Select a thread to view Plan' })
      .waitFor();
    await noThreadPage.locator('.right-panel .machine-status').waitFor();
    await noThreadPage.close();

    // 5. Command Palette moves the active right tab to Left Rail and normalizes the old side's active tab.
    await page.locator('.rp-tab[data-rtab-id="context"]').click();
    await page.locator('.right-panel .rp-title', { hasText: 'Context' }).waitFor();
    await page.locator('body').click({ position: { x: 800, y: 300 } });
    await page.keyboard.press('Control+k');
    await page.locator('.command-input').fill('Move active right tab');
    await page
      .locator('.command-item', { hasText: 'Move active right tab (Context) to Left Rail' })
      .click();
    await page.locator('.rail-toggle-btn.is-active[data-rail-id="context"]').waitFor();
    expect(await page.locator('.rp-tab[data-rtab-id="context"]').count()).toBe(0);
    // Right Panel normalized to a valid remaining tab (not stuck on dead 'context').
    expect(await page.locator('.rp-tab.is-active').count()).toBe(1);

    // 6. ?safe-ui=1 ignores panelPlacement and restores Plan (Right) and Status (Left) to defaults.
    await page.goto(`${origin}/?safe-ui=1#thread=shop-1&detail=1`);
    await page.locator('textarea.chat-input').waitFor();
    await page.locator('.rp-tab[data-rtab-id="plan"]').waitFor();
    await page.locator('.rail-toggle-btn[data-rail-id="status"]').waitFor();
    expect(await page.locator('.rail-toggle-btn[data-rail-id="plan"]').count()).toBe(0);
    expect(await page.locator('.rp-tab[data-rtab-id="status"]').count()).toBe(0);

    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);

test('Projects moved to Right Panel filters threads per selected scope while threads:all streams and stays expanded when Left Rail folds', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-cross-pane-projects-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const shop = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: join(dir, 'shop'),
      tags: [],
      runtime: 'claude-code',
    });
    shop.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: 'Checkout redesign',
        projectId: 'shop',
      }),
    );
    const billing = projects.register({
      id: 'billing',
      label: 'acme-billing',
      path: join(dir, 'billing'),
      tags: [],
      runtime: 'claude-code',
    });
    billing.addThread(
      new Thread('bill-1', new ContextStack(), {
        description: 'Invoice webhooks',
        projectId: 'billing',
      }),
    );

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.projects.shop = { id: 'shop', path: join(dir, 'shop'), label: 'acme-shop' };
    config.projects.billing = { id: 'billing', path: join(dir, 'billing'), label: 'acme-billing' };
    config.ui = { panelPlacement: { projects: 'right' } };
    await configStore.save(config);

    const viewer = createViewer({
      harness: new Harness(
        new Thread('main', new ContextStack(), { description: 'Global scratch' }),
      ),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      localStore: null,
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const origin = `http://127.0.0.1:${server.port}`;

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1500, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    // Open with Left Rail on Attention (cross-project) and Right Panel on moved Projects tab.
    await page.goto(`${origin}/#thread=shop-1&detail=1&rtab=projects`);
    await page.locator('.right-panel .proj-sidebar').waitFor();
    await page.locator('.right-panel .nav-projects').waitFor();
    const rightThreads = page.locator('.right-panel .thread-list .tree-node');

    // Selecting acme-shop filters Right Panel ThreadList to only shop's threads.
    await page.locator('.right-panel .nav-projects').getByText('acme-shop').click();
    await rightThreads.filter({ hasText: 'Checkout redesign' }).waitFor();
    expect(await rightThreads.filter({ hasText: 'Invoice webhooks' }).count()).toBe(0);
    expect(await rightThreads.filter({ hasText: 'Global scratch' }).count()).toBe(0);

    // Selecting acme-billing filters Right Panel ThreadList to only billing's threads (not overwritten by shop-1).
    await page.locator('.right-panel .nav-projects').getByText('acme-billing').click();
    await rightThreads.filter({ hasText: 'Invoice webhooks' }).waitFor();
    expect(await rightThreads.filter({ hasText: 'Checkout redesign' }).count()).toBe(0);
    expect(await rightThreads.filter({ hasText: 'Global scratch' }).count()).toBe(0);

    // Selecting Global filters Right Panel ThreadList to only global threads.
    await page.locator('.right-panel .nav-projects').getByText('Global').click();
    await rightThreads.filter({ hasText: 'Global scratch' }).waitFor();
    expect(await rightThreads.filter({ hasText: 'Checkout redesign' }).count()).toBe(0);
    expect(await rightThreads.filter({ hasText: 'Invoice webhooks' }).count()).toBe(0);

    // Folding Left Rail must NOT collapse Projects rendered inside the open Right Panel!
    await page.locator('body').click({ position: { x: 800, y: 300 } });
    await page.keyboard.press('Alt+BracketLeft');
    await page.locator('.panels--proj-closed').waitFor();
    await page.locator('.right-panel .proj-sidebar').waitFor({ state: 'visible' });
    await page.locator('.right-panel .nav-projects').waitFor({ state: 'visible' });
    await page.locator('.right-panel .thread-list').waitFor({ state: 'visible' });
    expect(await page.locator('.right-panel .collapsed-strip').count()).toBe(0);

    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);
