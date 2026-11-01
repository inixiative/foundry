import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { writeRegions } from '../helpers/regions';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(['git', ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

/** Give a written region a counted size, as the region builder records it. */
function sized(regionsDir: string, id: string, tokens: number) {
  const file = join(regionsDir, id, 'region.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), tokens }));
}

// A project's home: About (description, hosted repo, worktree mode, Kingdom), no Threads or Archive
// box, and two header actions. Knowledge and chorus lists the six steps with the regions' sizes;
// Esc returns home; the board action opens the board on this project.
test('Project home shows About and opens Knowledge and chorus and its board', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-project-pages-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const repo = join(dir, 'shop');
    Bun.spawnSync(['mkdir', '-p', repo]);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { 'worktree:create': 'x' } }),
    );
    const regions = writeRegions(repo, [{ id: 'database' }, { id: 'checkout' }, { id: 'auth' }]);
    sized(regions, 'database', 41_000);
    sized(regions, 'checkout', 24_000);
    sized(regions, 'auth', 12_000);

    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: repo,
      tags: [],
      runtime: 'claude-code',
      description: "Acme's storefront and checkout.",
    });
    project.addThread(
      new Thread('shop-1', new ContextStack(), { description: 'Cap retries', projectId: 'shop' }),
    );

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.projects.shop = {
      id: 'shop',
      path: repo,
      label: 'acme-shop',
      description: "Acme's storefront and checkout.",
    };
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${server.port}/#project=shop&home=1`);
    const home = page.locator('.project-home');
    await home.locator('h2', { hasText: 'acme-shop' }).waitFor();
    const about = home.locator('.ph-about');
    await about.locator('.ph-desc', { hasText: "Acme's storefront and checkout." }).waitFor();
    await about.locator('dd', { hasText: 'GitHub · acme/shop' }).waitFor();
    await about.locator('dd', { hasText: 'template mode' }).waitFor();
    await about.locator('dd', { hasText: 'Not linked' }).waitFor();
    const boxes = await home.locator('.ph-box h4').allInnerTexts();
    expect(boxes.some((h: string) => /^Threads/.test(h) || h === 'Archive')).toBe(false);

    const activeRow = page.locator('.proj-item.proj-active');
    expect(await activeRow.innerText()).toContain('acme-shop');
    await home.getByRole('button', { name: 'Knowledge and chorus' }).click();
    const know = page.locator('.knowledge');
    await know.locator('h2', { hasText: 'Knowledge and chorus' }).waitFor();
    await page.waitForFunction(() => location.hash.includes('home=knowledge'));
    expect(await know.locator('.kstep h3').allInnerTexts()).toEqual([
      'Set up',
      'Update since the last setup',
      'Analyse the docs',
      'Build regions',
      'Tune Wardens',
      'Oracle',
    ]);
    const build = know.locator('.kstep', { hasText: 'Build regions' });
    await build.locator('.kwarn', { hasText: 'database: 41k · over the cap' }).waitFor();
    expect(
      await build
        .locator('.ksize')
        .evaluateAll((els: Element[]) => els.map((e: Element) => e.getAttribute('data-level'))),
    ).toEqual(['over', 'large', 'ok']);
    expect(await know.getByRole('button', { name: 'Build regions · not built' }).isDisabled()).toBe(
      true,
    );

    expect(await activeRow.innerText()).toContain('acme-shop');
    // Reload keeps the page; Esc goes back to the project's home.
    await page.reload();
    await know.locator('h2', { hasText: 'Knowledge and chorus' }).waitFor();
    await page.keyboard.press('Escape');
    await about.waitFor();

    await home.getByRole('button', { name: 'Board for this project' }).click();
    await page.locator('.filter-chip.is-on', { hasText: 'Project' }).waitFor();
    await page.locator('.filter-chip.is-on', { hasText: 'Project' }).click();
    expect(
      await page
        .getByRole('group', { name: 'Project' })
        .getByRole('button', { name: /^acme-shop/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    // The project's row stays highlighted on its threads too.
    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1&rail=projects`);
    await page.locator('.context-bar-title', { hasText: 'Cap retries' }).waitFor();
    expect(await page.locator('.proj-item.proj-active').innerText()).toContain('acme-shop');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
