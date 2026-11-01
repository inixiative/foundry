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

// The Watchtower maps this Foundry's threads by lifecycle stage. `h` (or its button) opens it, it is
// part of the remembered workspace, and a card opens its thread.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('h opens the Watchtower: every stage is a column, a thread is a card, a card opens its thread', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-watch-'));
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
    await page.locator('textarea.chat-input').waitFor();
    await page.locator('body').click();
    await page.keyboard.press('h');
    const tower = page.locator('.watchtower');
    await tower.waitFor();
    await page.waitForFunction(() => location.hash.includes('view=watch'));
    expect(await tower.locator('.wt-th').allTextContents()).toEqual([
      '',
      'Idea · pain · bug',
      'Discussing',
      'Aligned',
      'Planned',
      'In progress',
      'Review · QA',
      'Blocked',
    ]);

    // The scope switch names whose work is shown; Esc leaves.
    await tower.getByRole('tab', { name: 'Involves me' }).click();
    expect(await tower.locator('.wt-meta').innerText()).toBe("Work you're on, on any machine");
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !location.hash.includes('view=watch'));
    await page.keyboard.press('h');

    await page.reload();
    await tower.waitFor();
    await tower.locator('.wt-card').first().click();
    await page.locator('textarea.chat-input').waitFor();
    expect(await tower.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
