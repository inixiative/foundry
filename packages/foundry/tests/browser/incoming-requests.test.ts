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

// Incoming requests sit at the top of Open › Shared as hatched rows; one opens a request view that
// keeps the chosen route on its Accept link, which goes to Kingdom to decide.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const REQUEST = {
  id: 'req-1',
  requester: 'Dana (Acme)',
  name: 'Bring her agent into a thread',
  operations: ['threads.post', 'threads.read'],
  lifecycle: 'task',
  maxRequests: 50,
  until: null,
  createdAt: new Date().toISOString(),
  reviewUrl: 'https://kingdom.example/dashboard?integration=x&signetRequest=req-1',
};

test('an incoming request is a hatched row in Shared; it opens a request view whose Accept names the route and goes to Kingdom', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-incoming-'));
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
    await page.route(
      '**/api/kingdom/incoming',
      (route: { fulfill: (r: object) => Promise<void> }) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ requests: [REQUEST] }),
        }),
    );

    await page.goto(`${origin}/#thread=main`);
    const row = page.locator('.incoming-row');
    await row.waitFor();
    expect(await row.textContent()).toContain('Dana (Acme)');
    await row.click();

    const view = page.locator('.request-view');
    await view.waitFor();
    expect(await view.textContent()).toContain('Bring her agent into a thread');
    await page.getByLabel('Keep it personal').check();
    const accept = page.getByRole('link', { name: /^Accept · personal · review in Kingdom/ });
    expect(await accept.getAttribute('href')).toBe(REQUEST.reviewUrl);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
