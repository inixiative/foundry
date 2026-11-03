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

// Aron 11-02: toasts go at the top of the thread, under its header, never over the message box.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

type Box = { x: number; y: number; width: number; height: number };
const meets = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('a toast sits at the top of the centre, never over the message box, header or side panel', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-toast-'));
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
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const toast = (message: string, type: string) =>
      page.evaluate(
        async ([m, t]: string[]) =>
          (
            (await import('/ui/store.js' as string)) as {
              showToast: (m: string, t: string) => void;
            }
          ).showToast(m, t),
        [message, type],
      );
    const rect = (selector: string) => page.locator(selector).first().boundingBox();

    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/#thread=main&detail=1`);
      await page.locator('.panel-center textarea.chat-input').waitFor();
      // An error stays until dismissed: the one from Aron's screenshot.
      await toast('[harness] Execution failed: the session ended', 'error');
      const shown = page.locator('.toast.error');
      await shown.waitFor();
      const t = (await shown.boundingBox())!;
      const composer = (await rect('.panel-center .chat-input-bar'))!;
      const header = (await rect('.panel-center .context-bar'))!;
      const centre = (await rect('.panel-center'))!;
      expect({ width, overComposer: meets(t, composer) }).toEqual({ width, overComposer: false });
      expect({ width, overHeader: meets(t, header) }).toEqual({ width, overHeader: false });
      // Under the header, inside the centre column (so never over the right panel or the rail).
      expect(t.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(t.y).toBeLessThan(centre.y + centre.height / 3);
      expect(t.x).toBeGreaterThanOrEqual(centre.x);
      expect(t.x + t.width).toBeLessThanOrEqual(centre.x + centre.width);
      const right = await rect('.panel-right');
      if (right && right.width > 0) expect(meets(t, right)).toBe(false);
      await page.getByRole('button', { name: 'Dismiss' }).click();
      await shown.waitFor({ state: 'detached' });
    }

    // Without a thread (the Board), the top of the centre area too; an info toast fades by itself.
    await page.keyboard.press('Alt+KeyB');
    await page.locator('.board').waitFor();
    await toast('Saved', 'ok');
    const ok = page.locator('.toast.ok');
    await ok.waitFor();
    const board = (await rect('.board'))!;
    const placed = (await ok.boundingBox())!;
    expect(placed.y).toBeLessThan(board.y + 120);
    await ok.waitFor({ state: 'detached' });
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
