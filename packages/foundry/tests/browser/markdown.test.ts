import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { completionFixture } from '../helpers/completion-persistence-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const reply = [
  '## Result',
  '',
  '**Done** with `one` change. <img src=x onerror="window.__xss=1">',
  '',
  '- first',
  '- second',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '[unsafe](javascript:window.__xss=2) [safe](https://example.com)',
  '',
  '```mermaid',
  'graph TD',
  '  A[Ask] --> B[Answer]',
  '```',
].join('\n');

test('agent replies render as Markdown, raw HTML stays text, and a mermaid block becomes a diagram', async () => {
  const fixture = await completionFixture(reply);
  const runtime = fixture.make();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: runtime.fetch,
    websocket: runtime.websocket,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
    await page.locator('.chat-input').fill('Reply in Markdown');
    await page.locator('.chat-input').press('Enter');
    const body = page.locator('.chat-agent .md').first();
    await body.locator('h2', { hasText: 'Result' }).waitFor();
    expect(await body.locator('strong', { hasText: 'Done' }).count()).toBe(1);
    expect(await body.locator('li').count()).toBe(2);
    expect(await body.locator('td').count()).toBe(2);
    expect(await body.locator('img').count()).toBe(0);
    expect(await body.textContent()).toContain('<img src=x');
    expect(await body.locator('a').count()).toBe(1);
    expect(await body.locator('a').getAttribute('href')).toBe('https://example.com');
    await body.locator('.md-mermaid-diagram svg').waitFor({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    fixture.close();
  }
}, 60_000);
