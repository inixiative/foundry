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
import { startViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// The narrow-screen rule (design review 11-02): the centre never drops below 560 px. The left list
// folds to its strip; the right panel's shares always fit beside it from 1100 px, so it keeps its
// column. Picking Projects never folds the rail: its wider list takes only what the centre spares.
// Widening the window restores the layout you chose.
test('the centre keeps 560 px: the rail folds and the right panel keeps its column', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-narrow-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const centre = () =>
      page.locator('.panel-center').evaluate((el: Element) => el.getBoundingClientRect().width);
    const panels = page.locator('.panels');

    await page.goto(`${origin}/#thread=main&detail=1`);
    await page.locator('textarea.chat-input').waitFor();
    expect(await panels.getAttribute('class')).not.toContain('panels--left-folded');
    // 1150: the open rail and panel would leave the centre under 560, so the rail folds first.
    await page.setViewportSize({ width: 1150, height: 900 });
    await page.waitForFunction(() =>
      document.querySelector('.panels')?.classList.contains('panels--left-folded'),
    );
    // The columns animate: wait for them to settle.
    await page.waitForFunction(
      () => (document.querySelector('.panel-center')?.getBoundingClientRect().width ?? 0) >= 559,
    );
    expect(await centre()).toBeGreaterThanOrEqual(559);
    // Widened, the right panel steps to wide: a third of the window (its 440 px floor here) still
    // fits beside the folded rail, so it stays in its column (sides are shares of the window, 11-14).
    await page.locator('body').click({ position: { x: 600, y: 5 } });
    await page.keyboard.press('Alt+Shift+BracketRight');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.endsWith(' 440px'),
    );
    // The columns animate: wait for them to settle.
    await page.waitForFunction(
      () => (document.querySelector('.panel-center')?.getBoundingClientRect().width ?? 0) >= 559,
    );
    expect(await centre()).toBeGreaterThanOrEqual(559);
    // Back to a normal right panel at 1200: the rail opens again, and picking Projects (whose list is
    // wider) does not fold it; the list takes only what the centre can spare.
    await page.keyboard.press('Alt+BracketRight');
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(
      () => !document.querySelector('.panels')?.classList.contains('panels--left-folded'),
    );
    await page.goto(`${origin}/#thread=main&detail=1&rail=projects`);
    await page.locator('textarea.chat-input').waitFor();
    await page.waitForFunction(
      () => (document.querySelector('.panel-center')?.getBoundingClientRect().width ?? 0) >= 559,
    );
    expect(await panels.getAttribute('class')).not.toContain('panels--left-folded');
    await page.locator('.rail-toggle').waitFor({ state: 'visible' });
    expect(await page.locator('.rail-toggle [aria-selected="true"]').innerText()).toContain(
      'Projects',
    );
    // A wide window restores both.
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.waitForFunction(() => {
      const c = document.querySelector('.panels')?.classList;
      return c && !c.contains('panels--left-folded');
    });
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);

// Aron 11-14: under 1100 px the workspace is tabs, and the Threads tab showed an empty page (the
// tab had no panel since the rail took over the thread list). Every tab shows its panel.
test('under 1100 px every workspace tab shows its panel', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-tabs-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 900, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main`);
    await page.locator('textarea.chat-input').waitFor();
    const tabs = page.locator('.panel-navigation [role=tab]');
    expect(await tabs.allTextContents()).toEqual(['Threads', 'Chat', 'Inspect']);
    for (const name of ['Threads', 'Chat', 'Inspect']) {
      await tabs.filter({ hasText: name }).click();
      const shown = page.locator(
        `#${await tabs.filter({ hasText: name }).getAttribute('aria-controls')}`,
      );
      await shown.waitFor({ state: 'visible' });
      const box = await shown.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(800);
    }
    // The Threads tab is the rail, with its own two-row view toggle.
    await tabs.filter({ hasText: 'Threads' }).click();
    await page.locator('.rail-toggle').waitFor({ state: 'visible' });
    // Plan lives in the right panel (Aron 11-15): its key shows the panel's pane, 1 brings the thread back.
    await tabs.filter({ hasText: 'Chat' }).click();
    await page.locator('body').click({ position: { x: 450, y: 5 } });
    await page.keyboard.press('Alt+Digit2');
    await page.locator('.right-panel .plan').waitFor({ state: 'visible' });
    expect(await page.locator('.panels').getAttribute('data-compact-panel')).toBe('detail');
    await page.keyboard.press('Alt+Digit1');
    await page.locator('.panel-center textarea.chat-input').waitFor({ state: 'visible' });
    expect(await page.locator('.panels').getAttribute('data-compact-panel')).toBe('conversation');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
