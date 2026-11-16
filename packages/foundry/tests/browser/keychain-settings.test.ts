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
import { FOUNDRY_HOLDER, Keychain, memoryKeychainBackend } from '../../src/secrets/keychain';
import { startViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// Settings → Keychain: the owner adds, re-holds and removes entries; a value never comes back.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);
const VALUE = 'correct horse battery staple';

test('Settings → Keychain adds, re-holds and removes an entry without showing its value', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-keychain-ui-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const keychain = new Keychain({ configDir: dir, backend: memoryKeychainBackend() });
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      keychain,
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
    page.on('dialog', (dialog: { accept: () => Promise<void> }) => dialog.accept());

    await page.goto(`${origin}/settings/keychain`);
    await page.getByText('Nothing in the keychain yet.').waitFor();
    await page.getByLabel('Name', { exact: true }).fill('site-password');
    await page.getByLabel('Value', { exact: true }).fill(VALUE);
    await page.getByRole('button', { name: 'Add' }).click();
    const row = page.locator('[data-keychain-entry="site-password"]');
    await row.waitFor();
    expect(await keychain.read('site-password', FOUNDRY_HOLDER)).toBe(VALUE);
    expect(await page.content()).not.toContain(VALUE);

    await row.getByLabel('Holder of site-password').fill('mcp:linear');
    await row.getByRole('button', { name: 'Save' }).click();
    await row.getByRole('button', { name: 'Save' }).waitFor({ state: 'detached' });
    expect(keychain.entry('site-password')?.holder).toBe('mcp:linear');

    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByText('Nothing in the keychain yet.').waitFor();
    expect(keychain.list()).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
});
