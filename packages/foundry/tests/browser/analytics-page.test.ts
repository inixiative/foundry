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

// Analytics as designed in concept-v4 (design review 11-02): the capacity band first, per
// subscription login (5-hour and 7-day windows, the footer's record), tokens over a chosen range,
// and "Coming soon" where Foundry records nothing yet.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('Analytics leads with each login’s windows and charts tokens over the chosen range', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-analytics-'));
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
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const json = (body: unknown) => ({
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    const resetsAt = new Date(Date.now() + 72 * 60_000).toISOString();
    await page.route('**/api/providers/accounts*', (route: { fulfill: (r: object) => unknown }) =>
      route.fulfill(
        json([{ provider: 'claude-code', source: 'login', detail: 'inixiative', ready: true }]),
      ),
    );
    await page.route('**/api/providers/limits', (route: { fulfill: (r: object) => unknown }) =>
      route.fulfill(
        json({
          limits: [
            {
              provider: 'claude-code',
              state: 'probed',
              snapshot: {
                plan: 'Claude Max',
                windows: [
                  { id: 'five_hour', windowMinutes: 300, usedPercent: 52, resetsAt },
                  { id: 'seven_day', windowMinutes: 10_080, usedPercent: 34 },
                ],
              },
            },
          ],
        }),
      ),
    );
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    let asked = '';
    await page.route(
      '**/api/analytics/timeseries*',
      (route: { request: () => { url: () => string }; fulfill: (r: object) => unknown }) => {
        asked = route.request().url();
        route.fulfill(
          json([
            { bucket: `${day(1)}T00:00:00.000Z`, input: 600, output: 400, cost: 0, calls: 3 },
            { bucket: `${day(0)}T00:00:00.000Z`, input: 1200, output: 800, cost: 0, calls: 5 },
          ]),
        );
      },
    );

    await page.goto(`${origin}/analytics`);
    const capacity = page.getByRole('region', { name: 'Capacity' });
    const row = capacity.locator('.an-cap-row', { hasText: 'inixiative' });
    await row.waitFor();
    expect(await row.innerText()).toContain('Claude Max');
    await row.locator('.an-meter', { hasText: '52%' }).waitFor();
    await row.locator('.an-meter', { hasText: '34%' }).waitFor();
    await row.locator('.an-cap-reset', { hasText: /resets in 1 h/ }).waitFor();
    // The headline reads the same window, and the chart the range's tokens.
    await page.locator('.an-tile', { hasText: '52%' }).waitFor();
    await page.locator('.an-tile', { hasText: '3.0K' }).waitFor();
    expect(await page.locator('.an-chart .an-col').count()).toBe(2);
    expect(asked).toContain('period=daily');
    // The series is fetched in an effect after the heading paints: wait for the request itself.
    const hourly = page.waitForRequest(/\/api\/analytics\/timeseries\?period=hourly/);
    await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: 'Today' }).click();
    await page.waitForFunction(() =>
      document.querySelector('.an-tokens h3')?.textContent?.includes('Today'),
    );
    // Check the request that was awaited, not the shared `asked` (a later daily refetch can overwrite it).
    expect((await hourly).url()).toContain('period=hourly');
    // What isn't recorded yet says so.
    await page
      .locator('.an-tile', { hasText: 'Warden overhead' })
      .locator('.coming-soon')
      .waitFor();
    await page.locator('.analytics-tab', { hasText: 'Wardens' }).click();
    await page.locator('.an-box', { hasText: 'Layer 1 and Layer 2' }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
