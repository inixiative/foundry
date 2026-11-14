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

// The workspace comes back as it was left: across Settings and across a bare reload.
// A first visit ever opens on Open with the right panel folded.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('first visit opens on Open with the right panel folded; the workspace is remembered across pages and reloads', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-memory-'));
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

    await page.goto(origin);
    await page.locator('.header').waitFor();
    // First visit: the right panel starts folded and the rail is on Attention.
    expect(new URL(page.url()).hash).toContain('detail=0');
    expect(new URL(page.url()).hash).not.toContain('rail=projects');

    // Leave it on Projects, go to Settings, come back: still Projects.
    await page.getByRole('tab', { name: 'Projects', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('rail=projects'));
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForFunction(() => location.pathname.startsWith('/settings'));
    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('rail=projects'));

    // A bare visit (no hash) brings the remembered workspace back.
    await page.goto(origin);
    await page.locator('.header').waitFor();
    await page.waitForFunction(() => location.hash.includes('rail=projects'));
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
