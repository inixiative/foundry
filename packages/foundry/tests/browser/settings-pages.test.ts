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

// Settings and analytics are pages, Foundry-wide or per project; Forge Master is a workspace default.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('settings and analytics are addressable pages scoped to Foundry or a project', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-settings-pages-'));
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
    const created = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, label: 'Scratch' }),
    });
    const project = (await created.json()) as { id: string };
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    const nav = (name: string | RegExp) =>
      page.locator('.settings-nav').getByRole('link', { name, exact: typeof name === 'string' });
    // Profile comes first; the nav groups Integrations and Advanced, Dev mode sits at the bottom.
    await page.goto(`${origin}/settings`);
    await page.locator('h1.settings-title', { hasText: 'Profile' }).waitFor();
    expect(
      (await page.locator('.settings-sections li').allInnerTexts()).map((t: string) => t.trim()),
    ).toEqual([
      'Profile',
      'Providers',
      'INTEGRATIONS',
      'Kingdom',
      'Archive',
      'GitHub',
      'Linear',
      'Devices',
      'ADVANCED',
      'Layers',
      'Agents',
      'Activity',
    ]);
    await page.locator('#installation-name').fill('Studio Foundry');
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.getByRole('button', { name: /Use the default/ }).waitFor();
    expect((await (await fetch(`${origin}/api/settings`)).json()).installationName).toBe(
      'Studio Foundry',
    );
    expect(await page.locator('.profile-card').innerText()).toContain('Pair a Kingdom');

    // Kingdom: what it is and a link to it; the URL field only in dev mode, which persists.
    await nav('Kingdom').click();
    await page.locator('.kingdom-pair', { hasText: 'Pairs as Studio Foundry' }).waitFor();
    expect(await page.locator('.kingdom-home').getAttribute('href')).toBe(
      'https://api.kingdom.inixiative.com/dashboard',
    );
    expect(await page.locator('#kingdom-api-url').count()).toBe(0);
    await page.getByRole('switch', { name: 'Dev mode' }).check();
    await page.locator('#kingdom-api-url').waitFor();
    await page.reload();
    await page.locator('#kingdom-api-url').waitFor();
    await page.getByRole('switch', { name: 'Dev mode' }).uncheck();
    expect(await page.locator('#kingdom-api-url').count()).toBe(0);

    // GitHub and Linear: what is connected, and connecting an account is coming soon.
    await nav('GitHub').click();
    await page.locator('.integration-card .coming-soon').waitFor();
    expect(await page.getByRole('button', { name: 'Connect GitHub' }).isDisabled()).toBe(true);

    // Devices without Kingdom says what peers and the tunnel are for; the tunnel waits for Kingdom.
    await nav('Devices').click();
    await page
      .locator('.devices-kingdom', { hasText: 'Peers and the tunnel need Kingdom' })
      .waitFor();
    await page.locator('.tunnel-mode[data-mode="auto"]', { hasText: 'stays off' }).waitFor();

    // Advanced sections explain themselves; an unwrapped Foundry has no layers.
    await nav('Layers').click();
    expect(await page.locator('.settings-empty').innerText()).toContain('unwrapped');

    // An old address lands on the section that now holds it.
    await page.goto(`${origin}/settings/models`);
    await page.locator('h1.settings-title', { hasText: 'Providers' }).waitFor();
    expect(new URL(page.url()).pathname).toBe('/settings/providers');

    // One row per vendor, the five main labs first; subscription and API are modes of one row.
    const vendors = page.locator('.vendor-row');
    await vendors.first().waitFor();
    expect(
      (await vendors.locator('.vendor-name').allTextContents())
        .slice(0, 5)
        .map((t: string) => t.trim()),
    ).toEqual([
      '▸ Anthropic (Claude)',
      '▸ OpenAI (Codex, GPT)',
      '▸ Google (Gemini)',
      '▸ Meta (Muse)',
      '▸ xAI (Grok)',
    ]);
    const google = page.locator('.vendor-row[data-vendor="google"]');
    expect(await google.locator('.mode-chip').first().textContent()).toBe(
      'Subscription: coming soon',
    );
    expect(await page.locator('.decision-hint').textContent()).toContain('nothing uses it yet');

    // Expanding a vendor shows each mode's models; a model becomes the default in one click.
    const openai = page.locator('.vendor-row[data-vendor="openai"]');
    await openai.locator('.vendor-name').click();
    const subscription = openai.locator('.vendor-mode[data-mode="subscription"]');
    const astra = subscription.locator('.vendor-model', { hasText: 'gpt-6-astra' });
    await astra.getByRole('button', { name: 'Set as default model' }).click();
    await page
      .locator('.model-selection-value[data-choice="default"]', { hasText: 'GPT-6 Astra' })
      .waitFor();
    await astra.locator('.model-badge.default').waitFor();
    const settings = await (await fetch(`${origin}/api/settings`)).json();
    expect(settings.defaults).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
    // API decisions need API keys on; the button says so instead of failing.
    const apiLuna = openai
      .locator('.vendor-mode[data-mode="api"] .vendor-model', { hasText: 'gpt-6-luna' })
      .getByRole('button', { name: 'Set as decision model' });
    expect(await apiLuna.isDisabled()).toBe(true);

    // A vendor's switch turns all its modes off; the setting is saved per vendor.
    await page.locator('.vendor-row[data-vendor="xai"] .vendor-head .switch input').uncheck();
    await page.locator('.vendor-row[data-vendor="xai"].vendor-off').waitFor();
    expect((await (await fetch(`${origin}/api/settings`)).json()).vendors.xai.enabled).toBe(false);

    await page.getByRole('link', { name: 'Project', exact: true }).click();
    expect(new URL(page.url()).pathname).toBe(`/projects/${project.id}/settings/integrations`);
    await page.locator('.settings-breadcrumb', { hasText: 'Scratch' }).waitFor();
    // Gloss and Overrides are coming soon: marked in the nav, no controls on the page.
    expect(await page.locator('.settings-section .coming-soon').count()).toBe(2);
    await nav(/Gloss/).click();
    await page.locator('.coming-soon-card').waitFor();
    expect(await page.locator('.settings-body input, .settings-body button').count()).toBe(0);
    await nav('Integrations').click();

    await page.getByRole('link', { name: 'Analytics' }).click();
    expect(new URL(page.url()).pathname).toBe(`/projects/${project.id}/analytics`);
    expect(await page.locator('.analytics-scope').inputValue()).toBe(project.id);

    await page.goBack();
    expect(new URL(page.url()).pathname).toBe(`/projects/${project.id}/settings/integrations`);

    await page.getByRole('link', { name: 'Workspace' }).click();
    await page.locator('.proj-item', { hasText: 'Forge Master' }).click();
    await page.locator('.forge-master .settings-chat-title', { hasText: 'Forge Master' }).waitFor();
    expect(new URL(page.url()).hash).toContain('forge=1');

    await page.locator('.proj-item', { hasText: 'Global' }).click();
    expect(await page.locator('.forge-master').count()).toBe(0);

    // No horizontal overflow on a narrow phone.
    await page.setViewportSize({ width: 333, height: 800 });
    for (const path of [
      '/settings/providers',
      `/projects/${project.id}/settings/archive`,
      '/analytics',
    ]) {
      await page.goto(`${origin}${path}`);
      await page.locator('.settings-page, .analytics-page').first().waitFor();
      expect({
        path,
        overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      }).toEqual({ path, overflow: false });
    }

    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
