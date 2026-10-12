import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { liveWatchFixture, until } from '../helpers/live-watch-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test("the viewer's Stop button stops a running turn through the interrupt route", async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/stop-turn-'));
  const f = await liveWatchFixture(dir);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: f.viewer.fetch,
    websocket: f.viewer.websocket,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=${f.thread.id}`);
    const turn = f.send('stop-me');
    await until(
      () => f.attempts.length === 1 && f.attempts[0].native.dispatch === 'attempted',
      'turn dispatched',
    );
    f.attempts[0].emit({ kind: 'text_delta', itemId: 'answer', text: 'Working' });
    const stop = page.locator('.live-work-stop');
    await stop.waitFor();
    const posted = page.waitForResponse((response: { url(): string }) =>
      response.url().endsWith('/turns/stop-me/interrupt'),
    );
    await stop.click();
    expect(await (await posted).json()).toEqual({ outcome: 'acknowledged' });
    expect(f.interrupts).toEqual([f.attempts[0].native.admissionId]);
    expect(await turn.done).toMatchObject({ type: 'error', cancelled: true });
    await page.locator('.live-work-stop').waitFor({ state: 'detached' });
  } finally {
    await browser.close();
    server.stop(true);
    await f.close();
  }
}, 60_000);
