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

// The actions palette by Send: "/" in an empty box or the Actions button opens it, typing filters,
// Enter runs the highlighted action, and actions that aren't built say why instead of running.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('"/" in an empty box opens the actions palette; it filters, runs, and names what isn’t built', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-actions-'));
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
    await box.click();
    await page.keyboard.type('/');
    const palette = page.locator('.action-palette');
    await palette.waitFor();
    expect(await box.inputValue()).toBe('');
    expect(await palette.locator('h5').allInnerTexts()).toEqual([
      'THREAD',
      'SEND THIS DRAFT',
      'FEEDBACK',
    ]);

    // A built action runs: "feedback" filters to Give feedback; Enter puts /feedback in the box.
    await page.keyboard.type('feedback');
    expect(await palette.locator('.action-palette-item').first().innerText()).toContain(
      'Give feedback',
    );
    await page.keyboard.press('Enter');
    expect(await palette.count()).toBe(0);
    await page.waitForFunction(
      () =>
        (document.querySelector('textarea.chat-input') as HTMLTextAreaElement).value ===
        '/feedback ',
    );

    // One that isn't built says why and stays open.
    await box.fill('');
    await page.getByRole('button', { name: /^Actions/ }).click();
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains('action-palette-input'),
    );
    await page.keyboard.type('fork');
    await page.keyboard.press('Enter');
    await page.locator('.toast', { hasText: 'CORE-004' }).waitFor();
    expect(await palette.count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await palette.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
