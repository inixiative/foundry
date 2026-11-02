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

// The actions palette by Send: "/" in an empty box or the Actions button opens it, typing filters,
// Enter runs the highlighted action, and actions that aren't built say why instead of running.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// A destination command typed at full speed through the palette: "/" in an empty box opens the
// palette, and "aside " closes it and switches the box's destination, the rest kept in the box.
// No keystroke is lost between the box, the palette and back.
test('typing "/aside hello" at full speed switches to aside and keeps "hello"', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-slash-race-'));
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
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main`);
    const box = page.locator('textarea.chat-input');
    await box.waitFor();
    const destination = page.locator('.composer-destination');
    for (const [typed, expected, rest] of [
      ['/aside hello', 'aside', 'hello'],
      ['/btw what does this do', 'btw', 'what does this do'],
      ['/thread back to everyone', 'thread', 'back to everyone'],
      ['/aside hello', 'aside', 'hello'],
      ['/aside hello', 'aside', 'hello'],
    ] as const) {
      await box.fill('');
      await box.click();
      await page.keyboard.type(typed, { delay: 0 });
      await page.waitForFunction(
        ([d, r]: readonly [string, string]) =>
          document.querySelector('.composer-destination')?.getAttribute('data-destination') === d &&
          (document.querySelector('textarea.chat-input') as HTMLTextAreaElement).value === r,
        [expected, rest] as const,
      );
      expect(await page.locator('.action-palette').count()).toBe(0);
      expect(await destination.getAttribute('data-destination')).toBe(expected);
    }
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
