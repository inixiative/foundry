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

// The thread header: the name alone on top, then pills grouping each concept (status, your agents,
// other parties; provider · model · effort, context fill, mode), with project and branch top right.
test('the thread header shows its name and grouped pills', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-header-'));
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
    project.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: 'Checkout errors since 2:02',
        projectId: 'shop',
        branch: 'fix/checkout-retry',
      }),
    );
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
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.route('**/api/threads/shop-1/launch', (route: { fulfill: (r: object) => unknown }) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          threadId: 'shop-1',
          provider: 'claude-code',
          model: 'claude-opus-5-5',
          effort: 'high',
          permissionMode: null,
          options: { models: [], efforts: [] },
        }),
      }),
    );
    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    const band = page.locator('.thread-band--pills');
    await band.locator('.context-bar-title', { hasText: 'Checkout errors since 2:02' }).waitFor();
    // Row 1: the name alone on the left; project and branch on the right.
    const where = await band.locator('.band-where .band-pills .band-pill').allInnerTexts();
    expect(where[0]).toBe('acme-shop');
    expect(where).toContain('fix/checkout-retry');
    // Row 2: status, your agents, other parties; then provider · model · effort, named from the registry.
    const bottom = band.locator('.band-who');
    expect(await bottom.locator('.band-status').count()).toBe(1);
    // Agents: a list of sessions, the primary first; people: you first.
    await bottom.locator('.band-count').first().hover();
    const agentsPop = bottom.locator('.band-count').first().locator('.band-popover');
    expect(await agentsPop.innerText()).toMatch(/AGENT SESSIONS · 1[\s\S]*Opus 5\.5[\s\S]*primary/);
    await bottom.locator('.band-count').nth(1).hover();
    expect(await bottom.locator('.band-count').nth(1).locator('.band-popover').innerText()).toMatch(
      /PEOPLE · 1[\s\S]*You[\s\S]*acting as[\s\S]*trusted[\s\S]*Untrusted: everyone else/,
    );
    // Either pill opens the right panel on Participants.
    await bottom.locator('.band-count').nth(1).click();
    await page.locator('.rp-tab.is-active', { hasText: 'Participants' }).waitFor();
    const runs = band.locator('.band-runs .band-pills');
    await runs.locator('.band-pill', { hasText: 'high' }).first().waitFor();
    expect(await runs.innerText()).toMatch(/Opus 5\.5.*high/);
    // Nothing spills out of the band at 1280.
    const spill = await band.evaluate((el: Element) => el.scrollWidth - el.clientWidth);
    expect(spill).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);

// Aron's rule: the header is always two rows. The right-hand pill groups take the room they need up
// to 70% and the title keeps at least 30% (11-02); a group never wraps, and what doesn't fit scrolls
// sideways, is hidden whole (never clipped mid-word) and is listed under "…"; the title truncates
// with its full text in a tooltip; the provider goes before the model.
test('the thread header stays two rows from 1024 to 1920 wide', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-header-rows-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  const name =
    'Checkout errors since 2:02 when the retry limit and the payment provider disagree about refunds';
  try {
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop-storefront',
      path: join(dir, 'shop'),
      tags: ['acme'],
      runtime: 'claude-code',
    });
    project.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: name,
        projectId: 'shop',
        branch: 'fix/checkout-retry-limit-and-refund-reconciliation',
      }),
    );
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.projects.shop = {
      id: 'shop',
      path: join(dir, 'shop'),
      label: 'acme-shop-storefront',
      tags: ['acme'],
    };
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
    const page = await (
      await browser.newContext({ viewport: { width: 1920, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.route('**/api/threads/shop-1/launch', (route: { fulfill: (r: object) => unknown }) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          threadId: 'shop-1',
          provider: 'claude-code',
          model: 'claude-opus-5-5',
          effort: 'high',
          permissionMode: null,
          options: { models: [], efforts: [] },
        }),
      }),
    );
    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    const grid = page.locator('.thread-band--pills .band-grid');
    await grid.locator('.band-run', { hasText: 'high' }).waitFor();
    const title = grid.locator('.context-bar-title');
    // With no Kingdom owner yet, the project's organisation tag sits beside it.
    await grid.locator('.band-org', { hasText: 'acme' }).waitFor();
    expect(await title.getAttribute('title')).toContain(name);
    let squeezed = false;
    for (const width of [1920, 1680, 1440, 1280, 1100, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const shape = await grid.evaluate((el: Element) => {
        const box = el.getBoundingClientRect();
        const zoom = Number(getComputedStyle(document.querySelector('.app') as Element).zoom) || 1;
        const band = el.closest('.thread-band') as HTMLElement;
        const pills = [...el.querySelectorAll('.band-pills > .band-pill')].filter(
          (p) => (p as HTMLElement).offsetParent,
        );
        const groups = [...el.querySelectorAll('.band-group')].map((g) => {
          const r = g.getBoundingClientRect();
          return { width: r.width, top: r.top - box.top, over: g.classList.contains('is-over') };
        });
        // A pill that shows sits wholly inside its group's visible box.
        const clipped = [...el.querySelectorAll('.band-pills')].flatMap((scroller) => {
          const r = scroller.getBoundingClientRect();
          return [...scroller.children]
            .filter((p) => !p.classList.contains('is-cut') && (p as HTMLElement).offsetParent)
            .filter((p) => {
              const q = p.getBoundingClientRect();
              return q.left < r.left - 1 || q.right > r.right + 1;
            })
            .map((p) => (p as HTMLElement).innerText);
        });
        const titleColumn = (
          el.querySelector('.band-title') as HTMLElement
        ).getBoundingClientRect();
        const run = el.querySelector('.band-run') as HTMLElement;
        const drop = el.querySelector('.band-run .band-drop') as HTMLElement | null;
        return {
          // Wide screens zoom the app 1.1 (concept-v4); measure in its own pixels.
          height: Math.round(box.height / zoom),
          spill: band.scrollWidth - band.clientWidth,
          // Every pill sits on row 1 or row 2: none below the header.
          lowest: Math.max(...pills.map((p) => p.getBoundingClientRect().bottom - box.top)) / zoom,
          widest: Math.max(...groups.map((g) => g.width)) / box.width,
          titleShare: titleColumn.width / box.width,
          clipped,
          rows: [...new Set(groups.map((g) => (g.top < 26 ? 1 : 2)))].sort(),
          over: groups.some((g) => g.over),
          providerShown: !!drop && getComputedStyle(drop).display !== 'none',
          runText: run.innerText,
        };
      });
      expect({ width, height: shape.height }).toEqual({ width, height: 54 });
      expect(shape.spill).toBeLessThanOrEqual(1);
      expect(shape.lowest).toBeLessThanOrEqual(55);
      expect(shape.widest).toBeLessThanOrEqual(0.71);
      expect(shape.titleShare).toBeGreaterThanOrEqual(0.29);
      expect(shape.clipped).toEqual([]);
      expect(shape.rows).toEqual([1, 2]);
      // The model always shows; the provider is what goes, never a clipped model name.
      expect(shape.runText).toContain('Opus 5.5');
      if (!shape.providerShown) expect(shape.runText).not.toContain('Anthropic');
      if (shape.over) squeezed = true;
    }
    // Somewhere in the range a group overflows; narrower still, the long branch doesn't fit even
    // at 70%: "…" lists every pill in the group, and no pill shows cut.
    expect(squeezed).toBe(true);
    await page.setViewportSize({ width: 760, height: 900 });
    await grid.locator('.band-where.is-over').waitFor();
    const more = grid.locator('.band-where .band-more-button');
    const list = grid.locator('.band-where .band-more-list');
    // Only one copy of each pill exists until "…" is opened.
    expect(await list.count()).toBe(0);
    await more.hover();
    expect(await list.innerText()).toContain('fix/checkout-retry-limit-and-refund-reconciliation');
    await page.mouse.move(0, 0);
    await list.waitFor({ state: 'detached' });
    await more.focus();
    expect(await list.innerText()).toContain('fix/checkout-retry-limit-and-refund-reconciliation');
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
