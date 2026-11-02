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

// Aron, 2026-11-02: "how do we see if balancing is happening? … a balancing toggle, maybe like a
// scale". The footer shows each runtime's pool with its scale; clicking it toggles the balancer.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const window5h = (used: number) => ({
  runtime: 'claude',
  source: 'poll',
  observedAt: Date.now(),
  windows: [
    { id: 'five_hour', windowMinutes: 300, usedPercent: used },
    { id: 'seven_day', windowMinutes: 10_080, usedPercent: used / 2 },
  ],
});
const login = (id: string, name: string, used: number, runs: number, status = 'ready') => ({
  id,
  name,
  own: false,
  status,
  limits: window5h(used),
  runs,
  preferred: id === 'a',
});
const pool = (pinned: boolean) => ({
  runtime: 'claude',
  routing: 'quartile-balanced',
  pinned,
  preferredLoginId: 'a',
  from: pinned ? 'foundry' : 'default',
  overrides: [],
  balancing: pinned
    ? { state: 'stopped', reason: 'pinned', on: 'inixiative' }
    : { state: 'balanced', across: 3, routing: 'quartile-balanced', by: 'usage' },
  logins: [
    login('a', 'inixiative', 40, 5),
    login('b', 'personal', 22, 3),
    login('c', 'work', 100, 1, 'exhausted'),
  ],
  lastRuns: [
    { at: Date.now(), loginId: 'b', name: 'personal', threadId: 't1', why: 'balanced' },
    { at: Date.now() - 1, loginId: 'a', name: 'inixiative', threadId: 't2', why: 'kept' },
  ],
});

test('the footer scale shows balancing and toggles the load balancer; Settings lists the logins', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-pools-'));
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
    let pinned = false;
    const patches: unknown[] = [];
    type Route = {
      request(): { method(): string; postDataJSON(): Record<string, unknown> };
      fulfill(r: object): unknown;
    };
    await page.route('**/api/providers/pools', (route: Route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          pools: [pool(pinned)],
          setups: [],
          kingdom: [{ projectId: 'p', name: 'template' }],
        }),
      }),
    );
    await page.route('**/api/providers/pools/claude', (route: Route) => {
      const body = route.request().postDataJSON();
      patches.push(body);
      pinned = body.pinned === true;
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    });

    await page.goto(origin);
    const footer = page.locator('.nav-footer');
    await footer.locator('.pool-balancing', { hasText: 'Balancing across 3 logins' }).waitFor();
    // The Kingdom pool's balancing isn't shown yet: its badge is the link to the plan.
    await footer.locator('.pool-kingdom a.coming-soon', { hasText: 'Coming soon' }).waitFor();
    await footer.locator('.pool .nav-footer-row').click();
    const rows = footer.locator('.pool-login');
    expect(await rows.count()).toBe(3);
    await footer.locator('.pool-login[data-status="exhausted"]', { hasText: 'work' }).waitFor();
    await footer.locator('.pool-login', { hasText: '5 in 5h' }).waitFor();
    await footer.locator('.pool-last', { hasText: 'Last runs: personal, inixiative' }).waitFor();

    // The scale turns balancing off (pinned to the preferred login), then back on.
    const scale = footer.locator('.scale-btn');
    expect(await scale.getAttribute('aria-pressed')).toBe('true');
    await scale.click();
    await footer.locator('.pool-balancing', { hasText: 'Stopped: pinned to inixiative' }).waitFor();
    expect(patches[0]).toEqual({ pinned: true, preferredLoginId: 'a' });
    expect(await scale.getAttribute('aria-pressed')).toBe('false');
    await scale.click();
    await footer.locator('.pool-balancing', { hasText: 'Balancing across 3 logins' }).waitFor();
    expect(patches[1]).toEqual({ pinned: false });

    // Settings › Providers: the same pool, each login with its meters, turns and actions.
    await page.goto(`${origin}/settings/providers`);
    const card = page.locator('.login-pools .pool-card[data-runtime="claude"]');
    await card.locator('.pool-table tbody tr').first().waitFor();
    expect(await card.locator('.pool-table tbody tr').count()).toBe(3);
    await card.locator('button', { hasText: 'Add a Claude login' }).waitFor();
    await card.locator('.pool-last', { hasText: 'Last runs: personal, inixiative' }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
