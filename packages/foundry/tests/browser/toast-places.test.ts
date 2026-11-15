/**
 * @atlas
 * @kind test
 * @partOf feature:viewer
 */
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

// Toasts have two places (Aron 11-15): a thread's own sits at the top of the thread, full width and in
// the flow, pushing the messages down; a system one floats at the bottom left of the window.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('a thread toast opens at the top of the thread, a system toast at the bottom left', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-toast-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const events = new EventStream();
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: events,
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    const made = await fetch(`${origin}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tidy', description: 'Tidy the docs' }),
    });
    expect(made.status).toBe(201);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1400, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=tidy&rail=open`);
    const box = page.locator('textarea.chat-input');
    await box.waitFor();
    await box.fill('/feedback');
    await page.keyboard.press('Enter');

    // The thread's toast: inside the conversation, right under its header, as wide as the conversation.
    const threadToast = page.locator('.conversation > .toast.toast--thread');
    await threadToast.waitFor();
    expect(await threadToast.textContent()).toContain('Usage: /feedback');
    const place = await page.evaluate(() => {
      const t = document.querySelector('.conversation > .toast--thread') as HTMLElement;
      const header = document.querySelector('.conversation > .center-band') as HTMLElement;
      const convo = document.querySelector('.conversation') as HTMLElement;
      const pad = Number.parseFloat(getComputedStyle(convo).paddingLeft) * 2;
      return {
        position: getComputedStyle(t).position,
        afterHeader: t.previousElementSibling === header,
        fullWidth: Math.abs(t.getBoundingClientRect().width - (convo.clientWidth - pad)) < 2,
      };
    });
    expect(place).toEqual({ position: 'static', afterHeader: true, fullWidth: true });
    expect(await page.locator('.toast--system').count()).toBe(0);

    // A failed turn names its thread: on screen it is that thread's toast; another thread's goes to the
    // corner, saying which thread.
    events.pushError('harness', 'Execution failed: on this one', 'error', 'tidy');
    await page.locator('.conversation > .toast--thread', { hasText: 'on this one' }).waitFor();
    events.pushError('harness', 'Execution failed: elsewhere', 'error', 'main');
    await page.locator('.toast--system', { hasText: 'elsewhere' }).waitFor();
    await page.locator('.toast--system .toast-dismiss').click();

    // A system toast (archiving leaves the thread, so its Undo is the window's): fixed, bottom left.
    const row = page.locator('.tree-row', { hasText: 'Tidy the docs' }).first();
    await row.hover();
    await row.locator('.thread-actions button').first().click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    const systemToast = page.locator('.toast.toast--system');
    await systemToast.locator('.toast-undo').waitFor();
    const corner = await systemToast.evaluate((t: HTMLElement) => {
      const r = t.getBoundingClientRect();
      return {
        position: getComputedStyle(t).position,
        left: r.left < 40,
        bottom: window.innerHeight - r.bottom < 40,
      };
    });
    expect(corner).toEqual({ position: 'fixed', left: true, bottom: true });
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
