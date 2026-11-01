import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// Settings → About: what Foundry is, the open-source credits, version and licence.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('the About page says what Foundry is and credits T3 Code and Paseo', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-about-'));
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

    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as {
      version: string;
    };
    const health = (await (await fetch(`${origin}/api/health`)).json()) as { version: string };
    expect(health.version).toBe(pkg.version);

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/settings/about`);
    await page.locator('[data-about="what"]').waitFor();
    expect(await page.locator('[data-about="what"]').innerText()).toContain(
      'Foundry is a local harness for coding agents',
    );
    await page.locator('.about-facts dd.mono', { hasText: pkg.version }).waitFor();

    const credits = page.locator('[data-about="open-source"]');
    expect(await credits.innerText()).toContain('helped shape the language Foundry uses');
    expect(await credits.getByRole('link', { name: 'T3 Code' }).getAttribute('href')).toBe(
      'https://github.com/pingdotgg/t3code',
    );
    expect(await credits.getByRole('link', { name: 'Paseo' }).getAttribute('href')).toBe(
      'https://github.com/getpaseo/paseo',
    );
    expect(await page.locator('[data-about="supporters"]').innerText()).toContain(
      'Thanks to UserEvidence for supporting open-source software.',
    );

    // About is last in the Foundry settings nav.
    const navLinks = await page.locator('.settings-nav a').allInnerTexts();
    expect(navLinks.at(-1)?.trim()).toBe('About');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
});
