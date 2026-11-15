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

// Aron 11-15: a thread's toast is a full-width bar at the top of the thread, under its header and in the
// flow, pushing the messages down; a system toast floats at the bottom left. Never over the message box.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

type Box = { x: number; y: number; width: number; height: number };
const meets = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('a thread toast is a bar under the thread header, a system toast sits bottom left', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-toast-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const events = new EventStream();
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: events,
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
    const toast = (message: string, type: string, thread?: string) =>
      page.evaluate(
        async ([m, t, th]: (string | undefined)[]) =>
          (
            (await import('/ui/store.js' as string)) as {
              showToast: (m?: string, t?: string, o?: { thread?: string }) => void;
            }
          ).showToast(m, t, { thread: th }),
        [message, type, thread],
      );
    const rect = (selector: string) => page.locator(selector).first().boundingBox();

    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/#thread=main&detail=1`);
      await page.locator('.panel-center textarea.chat-input').waitFor();
      // The columns animate: measure once the centre has stopped changing width.
      await page.waitForFunction(
        () => {
          const w = document.querySelector('.panel-center')!.getBoundingClientRect().width;
          const last = (window as unknown as { __w?: number }).__w;
          (window as unknown as { __w?: number }).__w = w;
          return last === w;
        },
        undefined,
        { polling: 200 },
      );
      // An error stays until dismissed: the one from Aron's screenshot, a failed turn on this thread.
      events.pushError('harness', 'Execution failed: the session ended', 'error', 'main');
      const shown = page.locator('.panel-center .conversation > .toast--thread.error');
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
      // In the flow right after the header, as wide as the conversation's content.
      const flow = await shown.evaluate((el: HTMLElement) => {
        const convo = el.parentElement as HTMLElement;
        const pad = Number.parseFloat(getComputedStyle(convo).paddingLeft) * 2;
        return {
          position: getComputedStyle(el).position,
          afterHeader: el.previousElementSibling?.classList.contains('center-band') ?? false,
          fullWidth: Math.abs(el.getBoundingClientRect().width - (convo.clientWidth - pad)) < 2,
        };
      });
      expect({ width, ...flow }).toEqual({
        width,
        position: 'static',
        afterHeader: true,
        fullWidth: true,
      });
      expect(await page.locator('.toast--system').count()).toBe(0);
      const right = await rect('.panel-right');
      if (right && right.width > 0) expect(meets(t, right)).toBe(false);
      await page.getByRole('button', { name: 'Dismiss' }).click();
      await shown.waitFor({ state: 'detached' });
    }

    // Another thread's failure goes to the corner, naming the thread, not onto the open one.
    events.pushError('harness', 'Execution failed: elsewhere', 'error', 'tidy');
    const elsewhere = page.locator('.toast--system', {
      hasText: 'tidy: [harness] Execution failed: elsewhere',
    });
    await elsewhere.waitFor();
    expect(await page.locator('.toast--thread').count()).toBe(0);
    await elsewhere.locator('.toast-dismiss').click();

    // A thread's toast while its conversation is off screen (the Board) goes to the corner too. A system
    // toast sits at the bottom left; an info toast fades by itself.
    await page.keyboard.press('Alt+KeyB');
    await page.locator('.board').waitFor();
    await toast('Saved', 'ok', 'main');
    const ok = page.locator('.toast--system.ok', { hasText: 'Saved' });
    await ok.waitFor();
    const placed = (await ok.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(placed.x).toBeLessThan(40);
    expect(viewport.height - (placed.y + placed.height)).toBeLessThan(40);
    expect(await ok.evaluate((el: HTMLElement) => getComputedStyle(el).position)).toBe('fixed');
    await ok.waitFor({ state: 'detached' });
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
