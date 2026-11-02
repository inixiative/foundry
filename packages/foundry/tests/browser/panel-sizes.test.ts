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

// Panel sizes step: [ { for the left (hidden · strip · normal · wide), ] } for the right (hidden ·
// icons · normal · wide). A hidden side keeps a 0-width column with a restore tab; a strip
// shows only "larger"; a control disappears at its side's limit.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('panel sizes step with [ { ] }; hidden keeps its column at 0 with a restore tab; controls hide at the limit', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-sizes-'));
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
    const columns = () =>
      page.locator('.panels').evaluate((el: Element) => getComputedStyle(el).gridTemplateColumns);

    await page.goto(`${origin}/#thread=main&detail=1`);
    await page.locator('textarea.chat-input').waitFor();
    // Running folds to one line when nothing is live (sized to its content, 11-02).
    await page.locator('.running.is-folded').waitFor();
    await page.locator('body').click({ position: { x: 800, y: 5 } });

    // Left: normal → strip → hidden; the column stays, at 0, and the centre doesn't move left of it.
    await page.keyboard.press('[');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.startsWith('32px'),
    );
    // A strip shows only "larger".
    expect(await page.getByRole('button', { name: 'Make the left list smaller' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Make the left list larger' }).count()).toBe(1);
    await page.keyboard.press('[');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.startsWith('0px'),
    );
    expect((await columns()).split(' ')).toHaveLength(3);
    const tab = page.getByRole('button', { name: 'Show the left list' });
    await tab.click();
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.startsWith('32px'),
    );

    // Up to wide: no "larger" left at the limit.
    await page.keyboard.press('{');
    await page.keyboard.press('{');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.startsWith('360px'),
    );
    expect(await page.getByRole('button', { name: 'Make the left list larger' }).count()).toBe(0);

    // Right: hidden gets its own restore tab on the right edge.
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.endsWith(' 0px'),
    );
    await page.getByRole('button', { name: 'Show the right panel' }).click();
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.panels')!).gridTemplateColumns.endsWith(' 44px'),
    );
    // The icons strip shows each tab's icon (its label stays for screen readers).
    const stripTabs = page.locator('.rp-strip-tab');
    expect(await stripTabs.count()).toBe(7);
    expect(await stripTabs.locator('svg.tab-icon').count()).toBe(7);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
