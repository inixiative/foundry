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

// Renames open a small centred window: one field, ✕ Cancel, ✓ Save.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('renaming the machine opens a small window and saves through it', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-rename-'));
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
    await page.locator('.nav-footer-edit').click();
    const modal = page.getByRole('dialog', { name: 'Rename this machine' });
    await modal.waitFor();
    // Cancel leaves the name alone.
    await modal.getByRole('button', { name: /Cancel/ }).click();
    expect(await page.getByRole('dialog', { name: 'Rename this machine' }).count()).toBe(0);
    await page.locator('.nav-footer-edit').click();
    await page.getByLabel('Machine name').fill('2025 MacBook Pro');
    await page
      .getByRole('dialog', { name: 'Rename this machine' })
      .getByRole('button', { name: '✓ Save' })
      .click();
    await page.locator('.nav-footer-device', { hasText: '2025 MacBook Pro' }).waitFor();
    expect((await (await fetch(`${origin}/api/settings`)).json()).installationName).toBe(
      '2025 MacBook Pro',
    );
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
