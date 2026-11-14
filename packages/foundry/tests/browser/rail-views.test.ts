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

// The left rail opens on Attention: only the threads that need you (a pending approval), not the one
// working or the idle one, and not one whose subagents are blocked or asking (a subagent's state goes
// back to the agent that spawned it; Aron, 11-14); Open lists them all. ⌥⇧← ⌥⇧→ step Attention · Open · Projects · Scheduled · Status, wrapping,
// from inside the message box, and the hash keeps the view.
test('the rail opens on Attention, lists only threads that need you, and ⌥⇧← ⌥⇧→ step the five views', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-rail-views-'));
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
    for (const [id, description, status] of [
      ['shop-1', 'Checkout errors since 2:02', 'idle'],
      ['shop-2', 'Rewrite the setup guide', 'active'],
      ['shop-3', 'Tidy the changelog', 'idle'],
    ] as const) {
      const thread = new Thread(id, new ContextStack(), { description, projectId: 'shop' });
      thread.meta.status = status;
      // The setup guide runs a loop: Scheduled lists it.
      if (id === 'shop-2')
        thread.meta.loop = {
          goal: 'Guide passes review',
          steps: [],
          until: 'Review passes',
          rounds: [],
          state: 'running',
          startedAt: 0,
          updatedAt: 0,
        };
      project.addThread(thread);
    }
    // The changelog thread's subagents: one blocked, one asking. Neither puts it in Attention.
    for (const [id, state] of [
      ['shop-3-a', 'blocked'],
      ['shop-3-b', 'needs-you'],
    ] as const) {
      const sub = new Thread(id, new ContextStack(), {
        description: `Subagent ${state}`,
        projectId: 'shop',
        parentThreadId: 'shop-3',
      });
      sub.meta.spawn = { via: 'native-claude', observed: true };
      sub.meta.status = 'idle';
      sub.meta.agentStatus = { state, text: `Subagent ${state}`, at: 0 };
      project.addThread(sub);
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
    void queue.prompt({
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

    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
    const active = page.locator('.rail-toggle-btn.is-active');
    expect(await active.innerText()).toBe('Attention');
    const rows = page.locator('.active-rail .tree-node');
    await rows.filter({ hasText: 'Checkout errors since 2:02' }).waitFor();
    expect(await rows.filter({ hasText: 'Rewrite the setup guide' }).count()).toBe(0);
    expect(await rows.filter({ hasText: 'Tidy the changelog' }).count()).toBe(0);
    expect(new URL(page.url()).hash).not.toContain('rail=');

    // The shortcut works while typing: focus stays in the message box.
    await page.locator('.chat-input').focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Open' }).waitFor();
    await rows.filter({ hasText: 'Rewrite the setup guide' }).waitFor();
    await rows.filter({ hasText: 'Tidy the changelog' }).waitFor();
    await page.waitForFunction(() => location.hash.includes('rail=open'));
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Projects' }).waitFor();
    // Projects and the selected scope's threads sit side by side, not stacked (Aron, 11-14).
    const box = (sel: string) =>
      page.locator(sel).evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right };
      });
    const [list, threads] = [
      await box('.nav-rail .nav-projects'),
      await box('.nav-rail .nav-threads'),
    ];
    expect(threads.top).toBe(list.top);
    expect(threads.left).toBeGreaterThanOrEqual(list.right - 1);
    // The tabs sit in two rows: Attention · Open · Projects, then Scheduled · Status.
    expect(
      await page
        .locator('.rail-toggle-row')
        .evaluateAll((rows: Element[]) =>
          rows.map((r) => (r as HTMLElement).innerText.split(/\s+/)),
        ),
    ).toEqual([
      ['Attention', 'Open', 'Projects'],
      ['Scheduled', 'Status'],
    ]);
    // Scheduled: schedules and triggers (none yet), then threads running a loop.
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Scheduled' }).waitFor();
    await page.locator('.rail-pane[aria-label="Schedules & triggers"] .rail-empty').waitFor();
    const loops = page.locator('.rail-pane[aria-label="Loops"] .tree-node');
    await loops.filter({ hasText: 'Rewrite the setup guide' }).waitFor();
    expect(await loops.count()).toBe(1);
    await page.waitForFunction(() => location.hash.includes('rail=scheduled'));
    // Status is this machine's resources, a view of its own: no thread rows, nothing else under it.
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Status' }).waitFor();
    await page.locator('.nav-rail .machine-status').waitFor();
    expect(await page.locator('.nav-rail .tree-node').count()).toBe(0);
    await page.waitForFunction(() => location.hash.includes('rail=status'));
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await active.filter({ hasText: 'Attention' }).waitFor();
    expect(await page.locator('.machine-status').count()).toBe(0);
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await active.filter({ hasText: 'Status' }).waitFor();
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await active.filter({ hasText: 'Scheduled' }).waitFor();
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('chat-input')),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
