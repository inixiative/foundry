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

test('tab icons and number keys open the right panel on their tab', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-tab-keys-'));
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
    const title = page.locator('.right-panel .rp-title');
    const collapsed = page.locator('.right-panel--collapsed');

    await page.goto(`${origin}/#thread=main&detail=1`);
    await page.locator('textarea.chat-input').waitFor();
    await title.filter({ hasText: 'Context' }).waitFor();
    // Context leads with where the work lives: GitHub, the ticket, Slack, then what it runs on.
    const sections = await page.locator('.right-panel .rp-section-title').allInnerTexts();
    expect(sections.slice(0, 4).map((t: string) => t.toLowerCase())).toEqual([
      'github',
      'ticket',
      'slack',
      'runs on',
    ]);

    // The selected tab's own icon reopens the folded panel on it.
    await page.locator('body').click({ position: { x: 800, y: 300 } });
    await page.keyboard.press('Alt+BracketRight');
    await collapsed.waitFor();
    await collapsed.getByRole('button', { name: 'Open Context' }).click();
    await title.filter({ hasText: 'Context' }).waitFor();

    // A number key opens its tab; the same key again folds the panel.
    await page.keyboard.press('Alt+Digit4');
    await title.filter({ hasText: 'Work' }).waitFor();
    await page.keyboard.press('Alt+Digit4');
    await collapsed.waitFor();
    // 0 is Feedback.
    await page.keyboard.press('Alt+Digit0');
    await title.filter({ hasText: 'Feedback' }).waitFor();
    // 9 is Pointers, the Wardens' pointers (moved here from Loop).
    await page.keyboard.press('Alt+Digit9');
    await title.filter({ hasText: 'Pointers' }).waitFor();
    await page.locator('.right-panel .loop-pointers-empty').waitFor();

    // ⌘ works while typing; ⌥ too; neither types the digit.
    const box = page.locator('textarea.chat-input');
    await box.click();
    await page.keyboard.press('Meta+6');
    await title.filter({ hasText: 'Participants' }).waitFor();
    await box.click();
    await page.keyboard.press('Alt+7');
    await title.filter({ hasText: 'Permissions' }).waitFor();
    expect(await box.inputValue()).toBe('');

    // From the Watchtower, a number key brings the thread back with the panel on that tab.
    await page.locator('body').click({ position: { x: 800, y: 300 } });
    await page.keyboard.press('Alt+KeyH');
    await page.locator('.watchtower').waitFor();
    await page.keyboard.press('Alt+Digit4');
    await title.filter({ hasText: 'Work' }).waitFor();
    expect(await page.locator('.watchtower').count()).toBe(0);

    // 2 is the centre's Plan.
    await page.locator('body').click({ position: { x: 800, y: 300 } });
    await page.keyboard.press('Alt+Digit2');
    await page.locator('.plan').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
