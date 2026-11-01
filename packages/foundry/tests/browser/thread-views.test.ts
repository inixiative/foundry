import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionQueue,
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
import { until } from '../helpers/live-watch-fixture';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// The Thread tab has three views: the thread, /btw (you and your agent) and asides (people only).
// One /thread · /btw · /aside control; two or more on sit side by side, remembered in the browser. The
// composer says where it sends; until asides land, /btw and Aside send nothing and keep the text.
test('/thread, /btw and /aside: one control, side by side, and a composer that says where it sends', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-views-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
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
        description: 'Checkout errors since 2:02',
        projectId: 'shop',
      }),
    );
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      actionQueue: new ActionQueue(),
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
    const url = `http://127.0.0.1:${server.port}/#thread=shop-1`;
    await page.goto(url);
    await page.locator('.context-bar-title', { hasText: 'Checkout errors since 2:02' }).waitFor();

    // One control, /thread · /btw · /aside: each segment shows or hides its view.
    const seg = (name: string) => page.locator('.thread-segment', { hasText: name });
    expect(await seg('/thread').getAttribute('aria-pressed')).toBe('true');
    await seg('/btw').click();
    await page.locator('.side-view--btw').waitFor();
    expect(await page.locator('.thread-views--2 > *').count()).toBe(2);
    await seg('/aside').click();
    expect(await page.locator('.thread-views--3 > *').count()).toBe(3);
    // Turning everything off leaves the thread.
    await seg('/thread').click();
    await seg('/btw').click();
    await seg('/aside').click();
    expect(await seg('/thread').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('.chat-messages').isVisible()).toBe(true);
    // What's on is remembered across a reload.
    await seg('/btw').click();
    await page.reload();
    await page.locator('.thread-views--2').waitFor();
    expect(await seg('/btw').getAttribute('aria-pressed')).toBe('true');

    // The views toggle chooses what shows; the composer has no channel picker of its own.
    expect(await page.locator('.channel-tab, .channel-sending').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
