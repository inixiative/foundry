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

// Aron 11-02: a collapsed right panel's tab icon opens the panel on that tab, the tab already
// selected included; number keys work plain, with ⌘ (even while typing) or
// with ⌥: 1–3 the centre's tabs, 4–0 the right panel's, and a key for the tab showing folds it.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// The narrow-screen rule (design review 11-02): the centre never drops below 560 px. The left list
// folds to its strip first; then the right panel floats over the centre as a drawer. Widening the
// window restores the layout you chose.
test('the centre keeps 560 px: the rail folds, then the right panel floats', async () => {
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
    expect(await centre()).toBeGreaterThanOrEqual(559);
    // Widened, the right panel steps to wide: folding the rail isn't enough, so it floats.
    await page.locator('body').click({ position: { x: 600, y: 5 } });
    await page.keyboard.press('}');
    await page.waitForFunction(() =>
      document.querySelector('.panels')?.classList.contains('panels--right-overlay'),
    );
    expect(await centre()).toBeGreaterThanOrEqual(559);
    const drawer = await page
      .locator('.panel-right > .right-panel')
      .evaluate((el: Element) => [getComputedStyle(el).position, el.getBoundingClientRect().width]);
    expect(drawer[0]).toBe('absolute');
    expect(drawer[1]).toBeGreaterThan(400);
    // A wide window restores both.
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.waitForFunction(() => {
      const c = document.querySelector('.panels')?.classList;
      return c && !c.contains('panels--left-folded') && !c.contains('panels--right-overlay');
    });
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
