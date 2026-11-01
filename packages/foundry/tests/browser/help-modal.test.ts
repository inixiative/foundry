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

// ? opens Help: one centred window with two tabs, keys & commands and statuses & icons.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('? opens a centred help window with Keys & commands and Statuses & icons tabs', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-help-'));
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
    await page.getByRole('button', { name: 'Help' }).click();
    const modal = page.getByRole('dialog', { name: 'Help' });
    await modal.waitFor();
    expect(
      await modal.getByRole('tab', { name: 'Keys & commands' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(await modal.innerText()).toContain('/btw');
    await modal.getByRole('tab', { name: 'Statuses & icons' }).click();
    expect(await modal.innerText()).toContain('PERMISSION MODE');
    expect(await modal.innerText()).toContain('Dangerous');
    await modal.getByRole('button', { name: 'Close' }).click();
    expect(await page.getByRole('dialog', { name: 'Help' }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
