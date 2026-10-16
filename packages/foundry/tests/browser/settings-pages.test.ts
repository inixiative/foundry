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
