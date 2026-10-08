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

    await page.goto(`${origin}/settings`);
    await page.locator('h1.settings-title', { hasText: 'Models' }).waitFor();

    await page.getByRole('link', { name: 'Providers' }).click();
    expect(new URL(page.url()).pathname).toBe('/settings/providers');
    await page.locator('.provider-account').first().waitFor();

    await page.getByRole('tab', { name: 'Project' }).click();
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

    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
