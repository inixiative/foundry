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

// One message box (the default): its label picks where it sends, and /btw or /aside typed at the
// start switches it. Separate boxes (a Foundry setting) give each open view its own box instead.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('one box: /btw typed at the start switches its label; the label cycles; separate boxes move it to the views', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-boxes-'));
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
    const label = page.locator('.composer-destination');
    await label.waitFor();
    expect(await label.innerText()).toBe('Thread');
    // "/" opens the actions palette; "btw " there switches the box to /btw and returns to it.
    await box.click();
    await page.keyboard.type('/btw ');
    await page.waitForFunction(() => document.activeElement?.classList.contains('chat-input'));
    await page.keyboard.type('hello');
    expect(await label.innerText()).toBe('/btw');
    expect(await box.inputValue()).toBe('hello');
    expect(await page.locator('.chat-send-btn').isDisabled()).toBe(true);
    await page.locator('.composer-note-hint', { hasText: 'isn’t built yet' }).waitFor();
    await label.click();
    expect(await label.innerText()).toBe('/aside');
    await label.click();
    expect(await label.innerText()).toBe('Thread');
    expect(await page.locator('.chat-send-btn').isDisabled()).toBe(false);

    // Separate boxes: the label goes; an open /btw view has its own box.
    const saved = await fetch(`${origin}/api/settings/messageBox`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ separateViews: true }),
    });
    expect(saved.status).toBe(200);
    await page.reload();
    await box.waitFor();
    expect(await label.count()).toBe(0);
    await page.getByRole('button', { name: '/btw' }).first().click();
    await page.locator('.side-view--btw .view-box').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
