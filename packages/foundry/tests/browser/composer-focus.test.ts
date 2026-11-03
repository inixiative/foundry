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

// Aron 11-02: "If there's a thread message box on the screen, it should always be in focus, unless
// something else is actually holding the focus: a place to type." Clicking a row, a tab, the right
// panel or a Board card leaves focus in the message box; plain letters are typed, never commands
// (those are ⌥ chords); a real place to type (Search) holds focus and hands it back when it closes.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('typing always lands in the message box after clicking around', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-composer-focus-'));
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
    // A second thread, so the Board has a card to click.
    const made = await fetch(`${origin}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Cap checkout retries' }),
    });
    expect(made.status).toBe(201);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main&detail=1`);
    const box = page.locator('.panel-center textarea.chat-input');
    await box.waitFor();
    let typed = '';
    const typeAfter = async (what: string, click: () => Promise<unknown>) => {
      await click();
      await page.keyboard.type(what);
      typed += what;
      await page.waitForFunction(
        (want: string) =>
          (document.querySelector('.panel-center textarea.chat-input') as HTMLTextAreaElement)
            ?.value === want,
        typed,
      );
      expect({
        after: what,
        focused: await box.evaluate((el: Element) => el === document.activeElement),
      }).toEqual({
        after: what,
        focused: true,
      });
    };

    // A thread row in the left list.
    await typeAfter('row ', () => page.locator('.tree-node').first().click());
    // A right-panel tab, and the panel's body.
    await typeAfter('tab ', () => page.locator('.rp-strip-tab, .rp-tab').first().click());
    await typeAfter('panel ', () => page.locator('.right-panel .rp-section-title').first().click());
    // Plain letters are typed, never commands: b would open the Board.
    await typeAfter('b ', async () => {});
    expect(await page.locator('.board').count()).toBe(0);

    // A Board card: ⌥B opens the Board, its card opens the thread, and typing lands in its box.
    await page.keyboard.press('Alt+KeyB');
    // An idle thread is quiet: show the quiet ones.
    await page.getByRole('button', { name: /Show quiet/ }).click();
    const card = page.locator('.board-card', { hasText: 'Cap checkout retries' });
    await card.waitFor();
    await card.locator('.board-card-title').click();
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    // Each thread keeps its own draft: this one starts empty.
    typed = '';
    await typeAfter('card', async () => {});

    // A real place to type holds focus while in use, and hands it back when it closes.
    await page.keyboard.press('Alt+Shift+KeyF');
    const search = page.locator('.search-page input.search-input');
    await search.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('input.search-input'));
    await page.keyboard.type('xyz');
    expect(await search.inputValue()).toBe('xyz');
    await page.keyboard.press('Escape');
    await box.waitFor();
    await page.waitForFunction(() =>
      document.activeElement?.matches('.panel-center textarea.chat-input'),
    );
    // The draft comes back with it.
    for (let i = 0; i < 50 && (await box.inputValue()) !== typed; i++)
      await page.waitForTimeout(100);
    expect(await box.inputValue()).toBe(typed);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
