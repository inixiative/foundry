import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { liveWatchFixture, until } from '../helpers/live-watch-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

/** A 1x1 PNG and a 1x1 GIF. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

test('images pasted and dropped into the composer show as thumbnails and are sent with the message', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/images-browser-'));
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
    const input = page.locator('.chat-input');
    await input.waitFor();

    // Cmd+V of a screenshot: a paste event whose clipboard holds an image file.
    await input.evaluate((element: HTMLElement, data: string) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, PNG);
    // Drag and drop of two files onto the composer.
    await page.locator('.chat-input-bar').evaluate(
      (element: HTMLElement, data: { png: string; gif: string }) => {
        const transfer = new DataTransfer();
        const file = (b64: string, name: string, type: string) =>
          new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type });
        transfer.items.add(file(data.gif, 'dropped.gif', 'image/gif'));
        transfer.items.add(file(data.png, 'removed.png', 'image/png'));
        element.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
        element.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      },
      { png: PNG, gif: GIF },
    );

    const thumbnails = page.locator('.composer-image');
    await page.locator('.composer-image[data-status="ready"]').nth(2).waitFor();
    expect(await thumbnails.count()).toBe(3);
    // A thumbnail can be removed before sending.
    await thumbnails.nth(2).locator('.composer-image-remove').click();
    expect(await thumbnails.count()).toBe(2);

    await input.fill('What are these?');
    await page.locator('.chat-send-btn').click();
    await until(() => f.attempts.length === 1, 'turn dispatched');
    expect(f.attempts[0].images).toEqual([
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/gif', data: GIF },
    ]);
    expect(f.attempts[0].prompt).toContain('What are these?');
    expect(await thumbnails.count()).toBe(0);

    // The sent message shows its images, loaded from the attachment route.
    const sent = page.locator('.chat-user .chat-msg-image img');
    await sent.nth(1).waitFor();
    expect(await sent.count()).toBe(2);
    await until(
      () => sent.evaluateAll((images: HTMLImageElement[]) => images.every((i) => i.naturalWidth)),
      'sent images loaded',
    );
    f.attempts[0].finish();
    await page.locator('.chat-agent .chat-msg-content', { hasText: 'FINAL_ONLY' }).waitFor();

    // After a reload the history still shows them.
    await page.reload();
    await page.locator('.chat-user .chat-msg-image img').nth(1).waitFor();
  } finally {
    await browser.close();
    server.stop(true);
    await f.close();
  }
}, 60_000);
