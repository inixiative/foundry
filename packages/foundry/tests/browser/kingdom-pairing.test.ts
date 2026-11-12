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
import { mockKingdom, organizationOwner, reviewUrlFor } from '../helpers/kingdom-installation';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// Settings → Kingdom: the page shows Kingdom's review code and link, then the connection once approved.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

/** Kingdom's extended access/describe: who holds the Signet, by name. */
const described = (presented: { signetId: string; integrationId: string }) => ({
  signetId: presented.signetId,
  name: 'Browser Foundry',
  expiresAt: null,
  lifecycle: 'ongoing',
  taskId: null,
  currentRevision: 1,
  remainingRequests: null,
  operations: [],
  holder: {
    integration: { id: presented.integrationId, name: 'Browser Foundry', provider: 'foundry' },
    owner: {
      ownerModel: 'OrganizationUser',
      name: null,
      organization: { id: Bun.randomUUIDv7(), name: 'Acme Robotics', slug: 'acme' },
      space: null,
      user: { id: Bun.randomUUIDv7(), name: 'Ada Operator', email: 'ada@acme.test' },
    },
    issuedBy: { id: Bun.randomUUIDv7(), name: 'Grace Admin', email: 'grace@acme.test' },
    webUrl: 'https://kingdom.acme.test/',
    manageUrl: 'https://kingdom.acme.test/integrations/browser-foundry',
  },
});

test('the Kingdom page pairs through the review code and shows the connection once approved', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-kingdom-page-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const kingdom = mockKingdom({
      onSignet: (action, _body, presented) => (action === 'describe' ? described(presented) : {}),
    });
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
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    // The name comes from Settings → Profile; the pairing form shows it instead of asking.
    await fetch(`${origin}/api/settings/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationName: 'Browser Foundry' }),
    });
    await page.goto(`${origin}/kingdom`);
    await page.locator('.kingdom-pair', { hasText: 'Pairs as Browser Foundry' }).waitFor();
    // A custom Kingdom URL is a dev-mode field.
    expect(await page.locator('#kingdom-api-url').count()).toBe(0);
    await page.getByRole('switch', { name: 'Dev mode' }).check();
    await page.locator('#kingdom-api-url').fill(kingdom.url);
    await page.getByRole('button', { name: 'Connect to Kingdom' }).click();

    const code = page.locator('.review-code');
    await code.waitFor();
    const reviewCode = await code.textContent();
    expect(
      await page.getByRole('link', { name: 'Log in to Kingdom and approve' }).getAttribute('href'),
    ).toBe(reviewUrlFor(reviewCode!));

    const owner = organizationOwner();
    kingdom.approve(owner);
    expect(kingdom.requested()?.name ?? kingdom.installations.at(-1)?.name).toBe('Browser Foundry');
    // The paired Kingdom is a Signet card named the way Kingdom describes it.
    const row = page.locator('.kingdom-row');
    await row.filter({ hasText: 'Connected' }).waitFor();
    const head = await row.locator('.signet-card-head').innerText();
    expect(head).toContain('Acme Robotics');
    expect(head).toContain(new URL(kingdom.url).host);
    const facts = (await row.locator('.signet-facts dd').allInnerTexts()).map((t: string) =>
      t.trim(),
    );
    expect(facts).toEqual([
      'Browser Foundry',
      'Ada Operator ada@acme.test',
      'Grace Admin grace@acme.test',
    ]);
    for (const part of ['Look', 'Manage', 'Get more', 'Adjust'])
      await row.getByRole('region', { name: part }).waitFor();
    expect(await row.getByRole('link', { name: 'Manage in Kingdom' }).getAttribute('href')).toBe(
      'https://kingdom.acme.test/integrations/browser-foundry',
    );
    expect(await page.locator('.kingdom-home').getAttribute('href')).toBe(
      'https://kingdom.acme.test/',
    );
    expect(kingdom.calls).toContain('describe');
    expect(await page.getByRole('button', { name: 'Connect to Kingdom' }).isVisible()).toBe(true);

    // Reconnect offers the same Kingdom again; Disconnect removes the row.
    await row.getByRole('button', { name: 'Reconnect' }).click();
    await page.getByRole('button', { name: 'Reconnect with Kingdom approval' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await page.locator('.kingdom-pair', { hasText: 'Pair a Kingdom' }).waitFor();
    expect(await page.locator('.kingdom-row').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
