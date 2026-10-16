import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { CompletionResult, LLMProvider } from '@inixiative/foundry-core';
import { liveWatchFixture, until } from '../helpers/live-watch-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

const RULE = 'When a change is green on the agentic side, merge it yourself.';
const EDITED = 'Never ask before merging a green agentic change.';

test('a correction becomes a tuning card in chat; edit applies it; the Feedback view shows its cycle', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/feedback-view-'));
  const provider = {
    id: 'decisions',
    async complete(messages: Array<{ content: unknown }>): Promise<CompletionResult> {
      const classify = String(messages[0]?.content ?? '').startsWith('You classify messages');
      return {
        content: classify
          ? JSON.stringify({
              results: {
                M1: {
                  isCorrection: true,
                  category: 'approach',
                  statements: [RULE],
                  sharp: true,
                },
              },
            })
          : JSON.stringify({ itemId: null, confidence: 0 }),
      } as CompletionResult;
    },
  } as LLMProvider;
  const f = await liveWatchFixture(dir, { feedbackProvider: provider });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: f.viewer.fetch,
    websocket: f.viewer.websocket,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 960 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=${f.thread.id}`);
    await f.viewer.app.request(`/api/threads/${f.thread.id}/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        traceId: 't',
        spanId: 's',
        correction: 'Merge it yourself once green, again.',
      }),
    });

    const card = page.locator('.feedback-prompt');
    await card.waitFor();
    await expect(card.locator('.feedback-lines').innerText()).resolves.toContain('What we intend');
    await card.getByRole('button', { name: 'Edit, then apply' }).click();
    await card.getByLabel('Rule').fill(EDITED);
    await card.getByLabel('Level').selectOption('project-personal');
    await card.getByRole('button', { name: 'Apply' }).click();
    await card.waitFor({ state: 'detached' });
    await until(async () => {
      const response = await f.viewer.app.request('/api/feedback');
      const { items } = (await response.json()) as { items: Array<{ stage: string }> };
      return items[0]?.stage === 'applied';
    }, 'applied');

    // The project's feedback (the strip, or the center Feedback tab): the item with its learning loop.
    await page.locator('.feedback-strip').click();
    const row = page.locator('.feedback-item').first();
    await row.waitFor();
    expect(await row.locator('.feedback-statement').innerText()).toBe(EDITED);
    expect(await row.getAttribute('data-origin')).toBe('intervention');
    const loop = row.locator('.feedback-loop');
    await loop.locator('summary').click();
    expect(await loop.locator('summary').innerText()).toContain('applied');
    expect(await loop.locator('.feedback-change code').innerText()).toContain(EDITED);
    await loop.getByRole('button', { name: 'undo' }).click();
    await until(
      async () => !(await loop.locator('summary').innerText()).includes('applied'),
      'reverted in the view',
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
    await f.close();
  }
}, 60_000);
