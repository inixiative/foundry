import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { m0Scenario } from '../helpers/m0-domain-loop';
import { releaseAll } from '../helpers/release-all';

// "full trace" opens one turn as a timeline in the centre: Foundry's steps before the agent (with
// each domain's answer), the agent's work, Foundry after. Filters narrow it, ↑↓ step, Raw shows a
// step's record, Esc goes back to the thread. Real factory/runtime over the M0 domain loop.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);
const root = resolve(import.meta.dir, '../../../..');

test('full trace opens the turn view: grouped steps, filters, arrow keys, Raw, Esc back', async () => {
  const out = resolve(root, '.foundry/qa', `turn-view-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  process.env.FOUNDRY_M0_OUTPUT_DIR = out;
  const errors: string[] = [];
  let scenario: Awaited<ReturnType<typeof m0Scenario>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: { close: () => Promise<void>; newPage: (o: object) => Promise<any> } | undefined;
  try {
    scenario = await m0Scenario();
    const s = scenario;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, srv) => s.current.fetch(request, srv),
      websocket: s.current.websocket,
    });
    await s.send('a', 't1', 'Perform the migration');
    await s.settled('a');
    browser = await chromium.launch({ headless: true });
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=a`);
    await page.locator('.chat-fulltrace-btn').first().click();
    const view = page.locator('.turn-view');
    // The turn arrives over the flow stream after the view opens.
    await view.locator('.tv-group').first().waitFor();
    const groups = await view.locator('.tv-group h3').allTextContents();
    expect(groups[0]).toBe('Foundry, before');
    expect(groups.at(-1)).toBe('Foundry, after');
    // The chorus step lists each region's answer.
    const chorus = view.locator('.tv-step', { hasText: 'Chorus' });
    expect(await chorus.locator('.tv-regions li').count()).toBeGreaterThan(0);
    expect(await view.locator('.tv-step').count()).toBeGreaterThan(2);

    // This turn made no tool calls: Tools shows nothing; All brings the steps back.
    await view.getByRole('tab', { name: 'Tools' }).click();
    expect(await view.locator('.tv-step').count()).toBe(0);
    await view.getByRole('tab', { name: 'All' }).click();

    // Arrow keys move between steps; Raw shows the step's record.
    await view.focus();
    await page.keyboard.press('ArrowDown');
    expect(await view.locator('.tv-step.is-at').getAttribute('data-step-index')).toBe('1');
    await view.locator('.tv-step').first().getByRole('button', { name: 'Raw' }).click();
    expect(await view.locator('.tv-step').first().locator('pre').count()).toBe(1);

    await view.focus();
    await page.keyboard.press('Escape');
    await page.locator('textarea.chat-input').waitFor();
    expect(await view.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll([
      ['browser', browser ? () => browser!.close() : undefined],
      ['server', server ? () => server!.stop(true) : undefined],
      ['scenario', scenario ? () => scenario!.close() : undefined],
    ]);
  }
}, 120_000);
