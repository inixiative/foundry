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

// The keyboard never makes you leave the message box: ⌥ works while typing, holding ⌥ shows how,
// Tab stays among message boxes, Esc leaves and / comes back.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('⌥ shortcuts work while typing; hold ⌥ shows them; Tab stays in the message boxes; Esc leaves and / returns', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-keys-'));
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
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main`);
    const box = page.locator('textarea.chat-input');
    await box.waitFor();
    await box.click();
    await box.type('hello');

    // Hold ⌥: the overlay appears, and goes on release.
    await page.keyboard.down('Alt');
    await page.locator('.hold-keys').waitFor();
    await page.keyboard.up('Alt');
    expect(await page.locator('.hold-keys').count()).toBe(0);

    // ⌥] while typing folds or opens the right panel; no character lands in the box.
    await box.focus();
    const before = await page.evaluate(() => location.hash.includes('detail=0'));
    await page.keyboard.press('Alt+BracketRight');
    await page.waitForFunction(
      (was: boolean) => location.hash.includes('detail=0') !== was,
      before,
    );
    expect(await box.inputValue()).toBe('hello');

    // Tab stays in the only message box (Send and the rest are never stops).
    await box.focus();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('chat-input')),
    ).toBe(true);

    // Esc leaves; / comes back.
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('chat-input')),
    ).toBe(false);
    await page.keyboard.press('/');
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('chat-input')),
    ).toBe(true);
    expect(await box.inputValue()).toBe('hello');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
