import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const DEMO_EXTENSION = `
export default function setup(foundry) {
  const { html } = foundry.ui;

  foundry.setFlags('rightPanel', { showComingSoon: false });

  foundry.registerRightTab({
    id: 'metrics',
    label: 'Metrics',
    info: () => 'Custom metrics summary',
    badge: () => 7,
    render: ({ threadId }) => html\`<div class="demo-rtab-body" data-thread=\${threadId}>Metrics for \${threadId}</div>\`,
  });

  foundry.registerLeftTab({
    id: 'notes',
    label: 'Notes',
    badge: () => 2,
    render: () => html\`<div class="demo-rail-body">Left rail notes pane</div>\`,
  });

  foundry.registerMainView({
    id: 'dash',
    label: 'Dashboard',
    scope: 'workspace',
    render: () => html\`<section class="demo-ws-view"><h2>Custom Dashboard View</h2></section>\`,
  });

  foundry.extendSection('rightPanel.context.sections', {
    id: 'after-github',
    after: 'github',
    render: () => html\`<section class="rp-section demo-ctx-after-github"><h3 class="rp-section-title">After GitHub</h3></section>\`,
  });

  foundry.extendSection('rightPanel.context.sections', {
    id: 'before-runs-on',
    before: 'runs-on',
    render: () => html\`<section class="rp-section demo-ctx-before-runs"><h3 class="rp-section-title">Before Runs On</h3></section>\`,
  });

  foundry.extendSection('projectHome.sections', {
    id: 'ph-before-feedback',
    before: 'feedback',
    render: () => html\`<section class="ph-box demo-ph-before"><h4>Before Feedback</h4></section>\`,
  });

  foundry.extendSection('projectHome.sections', {
    id: 'ph-after-feedback',
    after: 'feedback',
    render: () => html\`<section class="ph-box demo-ph-after"><h4>After Feedback</h4></section>\`,
  });

  foundry.extendSection('header.right', {
    id: 'header-pill',
    before: 'help',
    render: () => html\`<span class="top-pill demo-header-pill">Demo Pill</span>\`,
  });

  foundry.extendSection('conversation.composer.actions', {
    id: 'composer-btn',
    before: 'send',
    render: () => html\`<button type="button" class="demo-composer-btn">Spark</button>\`,
  });
}
`;

const BROKEN_SETUP_EXTENSION = `
export default function setup() {
  throw new Error('setup exploded intentionally');
}
`;

const BROKEN_RENDER_EXTENSION = `
export default function setup(foundry) {
  const { html } = foundry.ui;

  foundry.registerRightTab({
    id: 'crashy',
    label: 'Crashy',
    badge: () => {
      throw new Error('badge exploded intentionally');
    },
    render: () => {
      if (!window.__ALLOW_CRASHY_RECOVERY__) {
        throw new Error('tab render exploded intentionally');
      }
      return html\`<div class="crashy-recovered">Crashy tab recovered</div>\`;
    },
  });

  foundry.extendSection('rightPanel.context.sections', {
    id: 'crashy-section',
    after: 'runs-on',
    render: () => {
      if (!window.__ALLOW_CRASHY_RECOVERY__) {
        throw new Error('section render exploded intentionally');
      }
      return html\`<section class="rp-section crashy-section-recovered">Section recovered</section>\`;
    },
  });
}
`;

test('custom themes, safe-ui mode, composable extension slots/tabs/views, and crash isolation work end-to-end', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-ui-ext-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    // Seed custom theme & extensions under <tmpDir>/ui/.
    mkdirSync(join(dir, 'ui', 'themes'), { recursive: true });
    mkdirSync(join(dir, 'ui', 'extensions', 'demo'), { recursive: true });
    writeFileSync(
      join(dir, 'ui', 'theme.css'),
      ':root { --custom-test-accent: rgb(255, 0, 170); }\n',
    );
    writeFileSync(
      join(dir, 'ui', 'themes', 'emerald.css'),
      ':root { --custom-test-accent: rgb(16, 185, 129); }\n',
    );
    writeFileSync(join(dir, 'ui', 'extensions', 'demo', 'index.js'), DEMO_EXTENSION);
    writeFileSync(join(dir, 'ui', 'extensions', 'broken-setup.js'), BROKEN_SETUP_EXTENSION);
    writeFileSync(join(dir, 'ui', 'extensions', 'broken-render.js'), BROKEN_RENDER_EXTENSION);

    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: join(dir, 'shop'),
      tags: [],
      runtime: 'claude-code',
    });
    project.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: 'Demo thread',
        projectId: 'shop',
      }),
    );

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.projects.shop = { id: 'shop', path: join(dir, 'shop'), label: 'acme-shop' };
    config.ui = {
      extensions: ['demo', 'broken-setup', 'broken-render'],
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
      localStore: null,
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const origin = `http://127.0.0.1:${server.port}`;

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    // 1. Custom theme + extensions load on normal workspace URL.
    await page.goto(`${origin}/#thread=shop-1&detail=1`);
    await page.locator('.demo-header-pill').waitFor();
    await page.locator('.demo-composer-btn').waitFor();

    const customVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--custom-test-accent').trim(),
    );
    expect(customVar).toBe('rgb(255, 0, 170)');

    // 2. Context tab: Coming Soon is hidden via rightPanel.showComingSoon=false,
    // before/after sections are positioned cleanly, and broken-render section renders isolated fallback.
    await page.locator('.demo-ctx-after-github').waitFor();
    await page.locator('.demo-ctx-before-runs').waitFor();
    expect(await page.locator('.right-panel .coming-soon').count()).toBe(0);

    const ctxTitles = await page.locator('.right-panel .rp-section-title').allInnerTexts();
    const lowerTitles = ctxTitles.map((t: string) => t.toLowerCase());
    expect(lowerTitles.indexOf('after github')).toBe(lowerTitles.indexOf('github') + 1);
    expect(lowerTitles.indexOf('before runs on')).toBe(lowerTitles.indexOf('runs on') - 1);

    const ctxFallback = page.locator(
      '.right-panel .ext-error-fallback[data-ext-id="broken-render"]',
    );
    await ctxFallback.waitFor();
    expect(await ctxFallback.innerText()).toContain('section render exploded intentionally');

    // 3. Extension Right Panel tab: clickable, bookmarkable via #rtab=demo:metrics across reload.
    await page.locator('.rp-tab[data-rtab-id="demo:metrics"]').click();
    await page.locator('.demo-rtab-body', { hasText: 'Metrics for shop-1' }).waitFor();
    await page.waitForFunction(() => location.hash.includes('rtab=demo%3Ametrics'));
    await page.reload();
    await page.locator('.demo-rtab-body', { hasText: 'Metrics for shop-1' }).waitFor();

    // 4. Broken Right Panel tab: badge() threw safely without crashing tab bar, render() shows isolated fallback,
    // and Retry recovers once the failure condition clears.
    await page.locator('.rp-tab[data-rtab-id="broken-render:crashy"]').click();
    const tabFallback = page.locator(
      '.right-panel .ext-error-fallback[data-ext-id="broken-render"]',
    );
    await tabFallback.waitFor();
    expect(await tabFallback.innerText()).toContain('tab render exploded intentionally');
    await page.evaluate(() => {
      (window as unknown as { __ALLOW_CRASHY_RECOVERY__: boolean }).__ALLOW_CRASHY_RECOVERY__ =
        true;
    });
    await tabFallback.getByRole('button', { name: 'Retry' }).click();
    await page.locator('.crashy-recovered', { hasText: 'Crashy tab recovered' }).waitFor();

    // 5. Extension Left Rail tab: clickable + bookmarkable via #rail=demo:notes across reload.
    await page.locator('.rail-toggle-btn[data-rail-id="demo:notes"]').click();
    await page.locator('.demo-rail-body', { hasText: 'Left rail notes pane' }).waitFor();
    await page.waitForFunction(() => location.hash.includes('rail=demo%3Anotes'));
    await page.reload();
    await page.locator('.demo-rail-body', { hasText: 'Left rail notes pane' }).waitFor();

    // 6. Extension Workspace view: clickable + bookmarkable via #view=demo:dash across reload.
    await page.locator('.ws-custom-button[data-view-id="demo:dash"]').click();
    await page.locator('.demo-ws-view', { hasText: 'Custom Dashboard View' }).waitFor();
    await page.waitForFunction(() => location.hash.includes('view=demo%3Adash'));
    await page.reload();
    await page.locator('.demo-ws-view', { hasText: 'Custom Dashboard View' }).waitFor();

    // 7. Project Home sections before/after feedback.
    await page.goto(`${origin}/#project=shop&home=1`);
    await page.locator('.demo-ph-before').waitFor();
    await page.locator('.demo-ph-after').waitFor();
    const phHeadings = (await page.locator('.project-home .ph-box h4').allInnerTexts()).map(
      (t: string) => t.trim().toLowerCase(),
    );
    expect(phHeadings.indexOf('before feedback')).toBe(phHeadings.indexOf('feedback') - 1);
    expect(phHeadings.indexOf('after feedback')).toBe(phHeadings.indexOf('feedback') + 1);

    // 8. Settings -> Appearance shows discovered themes, active/error statuses for extensions.
    await page.goto(`${origin}/settings/appearance`);
    await page.locator('h1.settings-title', { hasText: 'Appearance' }).waitFor();
    await page.locator('[data-ext-row="demo"] .appearance-badge--active').waitFor();
    await page.locator('[data-ext-row="broken-setup"] .appearance-badge--error').waitFor();
    expect(await page.locator('[data-ext-row="broken-setup"]').innerText()).toContain(
      'setup exploded intentionally',
    );

    // 9. ?safe-ui=1 bypasses custom CSS + JS extensions and survives route navigation.
    await page.goto(`${origin}/?safe-ui=1#thread=shop-1&detail=1`);
    await page.locator('textarea.chat-input').waitFor();
    const safeVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--custom-test-accent').trim(),
    );
    expect(safeVar).toBe('');
    expect(await page.locator('.demo-header-pill').count()).toBe(0);
    expect(await page.locator('.demo-composer-btn').count()).toBe(0);
    expect(await page.locator('.rp-tab[data-rtab-id="demo:metrics"]').count()).toBe(0);

    // Navigate to Settings (project scope -> Foundry scope -> Appearance) and back to Workspace: ?safe-ui=1 persists!
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.locator('h1.settings-title').waitFor();
    expect(new URL(page.url()).searchParams.get('safe-ui')).toBe('1');
    await page.locator('.settings-nav').getByRole('link', { name: 'Foundry', exact: true }).click();
    await page
      .locator('.settings-nav')
      .getByRole('link', { name: 'Appearance', exact: true })
      .click();
    await page.locator('.appearance-banner', { hasText: 'Safe UI mode is active' }).waitFor();
    expect(new URL(page.url()).searchParams.get('safe-ui')).toBe('1');
    await page.getByRole('link', { name: 'Workspace' }).click();
    await page.locator('textarea.chat-input').waitFor();
    expect(new URL(page.url()).searchParams.get('safe-ui')).toBe('1');
    expect(await page.locator('.demo-header-pill').count()).toBe(0);

    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 120_000);
