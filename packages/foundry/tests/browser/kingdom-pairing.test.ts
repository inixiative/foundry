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
} from '@inixiative/foundry-core';
import { startViewer } from '../../src/viewer/server';
import { mockKingdom, organizationOwner } from '../helpers/kingdom-installation';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// Settings → Kingdom: the page shows Kingdom's review code and link, then the connection once approved.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('the Kingdom page pairs through the review code and shows the connection once approved', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-kingdom-page-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const kingdom = mockKingdom();
    cleanup.unshift(['kingdom', () => kingdom.stop()]);
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${viewer.server.port}/kingdom`);
    await page.locator('#kingdom-api-url').fill(kingdom.url);
    await page.locator('#kingdom-installation-name').fill('Browser Foundry');
    await page.getByRole('button', { name: 'Connect to Kingdom' }).click();

    const code = page.locator('.kingdom-connection strong');
    await code.waitFor();
    const reviewCode = await code.textContent();
    expect(
      await page.getByRole('link', { name: 'Log in to Kingdom and approve' }).getAttribute('href'),
    ).toBe(`${kingdom.url}/dashboard?reviewSignet=${reviewCode}`);

    const owner = organizationOwner();
    kingdom.approve(owner);
    const connected = page.locator('.kingdom-integration');
    await connected.filter({ hasText: `Connected to ${kingdom.url}` }).waitFor();
    expect(await connected.textContent()).toContain(owner);
    expect(await page.getByRole('button', { name: 'Connect to Kingdom' }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
