import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionResult, LLMMessage, LLMProvider } from '@inixiative/foundry-core';
import { connectStreams } from './helpers/data-stream';
import { liveWatchFixture, until } from './helpers/live-watch-fixture';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const RULE = 'When a change is green on the agentic side, merge it yourself.';

/** The decision provider: answers the shared classify contract and the match call. */
function decisions(): LLMProvider & { calls: LLMMessage[][] } {
  const calls: LLMMessage[][] = [];
  return {
    id: 'feedback-decisions',
    calls,
    async complete(messages: LLMMessage[]): Promise<CompletionResult> {
      calls.push(messages);
      const system = String(messages[0]?.content ?? '');
      const content = system.startsWith('You classify one message')
        ? JSON.stringify({
            isCorrection: true,
            category: 'approach',
            statements: [RULE],
            sharp: true,
          })
        : JSON.stringify({ itemId: null, confidence: 0 });
      return {
        content,
        model: 'haiku',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as CompletionResult;
    },
  } as LLMProvider & { calls: LLMMessage[][] };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-viewer-'));
  const provider = decisions();
  const f = await liveWatchFixture(dir, { feedbackProvider: provider });
  cleanup.push(async () => {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  const send = (id: string, message: string) =>
    f.viewer.app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, threadId: f.thread.id, message }),
    });
  const settings = (section: string, body: unknown) =>
    f.viewer.app.request(`/api/settings/${section}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { f, dir, provider, send, settings };
}

const feedbackPrompt = (f: Awaited<ReturnType<typeof liveWatchFixture>>) =>
  f.actionQueue.pending().find((p) => p.meta?.feedback);

test('a correction typed in a turn reaches the lifecycle view: captured, routed, applied, used', async () => {
  const { f, dir, provider, send } = await fixture();
  const streams = connectStreams(f.viewer);
  cleanup.push(() => streams.disconnect());
  await streams.open('feedback:P');

  const response = send('turn-1', 'No, merge it yourself once green, I told you already.');
  await until(
    () => f.attempts.length === 1 && f.attempts[0].native.dispatch === 'attempted',
    'dispatched',
  );
  // Non-blocking: the turn runs while the prompt waits.
  f.attempts[0].finish(false, 'merged');
  expect((await response).status).toBe(200);
  await until(() => feedbackPrompt(f), 'tuning prompt raised');
  // The classifier saw the user's words and the previous agent turn (none yet).
  expect(JSON.stringify(provider.calls[0])).toContain('merge it yourself once green');

  const prompt = feedbackPrompt(f)!;
  const resolved = await f.viewer.app.request(`/api/prompts/${prompt.id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'apply' }),
  });
  expect(resolved.status).toBe(200);
  await until(async () => {
    const { items } = (await (await f.viewer.app.request('/api/feedback?projectId=P')).json()) as {
      items: Array<{ status: string }>;
    };
    return items[0]?.status === 'applied';
  }, 'applied');
  const { items } = (await (await f.viewer.app.request('/api/feedback?projectId=P')).json()) as {
    items: Array<{
      id: string;
      statement: string;
      route: { roles: string[]; level: string };
      changes: Array<{ path: string; changeId: string }>;
    }>;
  };
  const [item] = items;
  expect(item).toMatchObject({
    statement: RULE,
    route: { roles: ['main'], level: 'org-personal' },
  });
  // org-personal: the project's parent directory, a personal role file for the main thread.
  expect(item!.changes[0]!.path).toBe(join(dir, '.foundry/roles/main/instructions.local.md'));
  expect(await readFile(item!.changes[0]!.path, 'utf8')).toContain(`${RULE} (${item!.id})`);

  // The stream holder saw the item go from captured to applied.
  await until(
    () => streams.data('feedback:P').some((frame) => frame.payload?.item?.status === 'applied'),
    'stream append',
  );

  const undone = await f.viewer.app.request(`/api/feedback/${item!.id}/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changeId: item!.changes[0]!.changeId }),
  });
  expect(undone.status).toBe(200);
  expect(await readFile(item!.changes[0]!.path, 'utf8')).not.toContain(item!.id);
});

test('blocking tuning holds the turn before it reaches the executor', async () => {
  const { f, send, settings } = await fixture();
  expect((await settings('feedback', { tuning: 'block', blockTimeoutMs: 60_000 })).status).toBe(
    200,
  );
  const response = send('turn-1', 'Again: merge it yourself.');
  await until(() => feedbackPrompt(f), 'tuning prompt raised');
  await Bun.sleep(50);
  expect(f.attempts).toHaveLength(0);
  f.actionQueue.resolve(feedbackPrompt(f)!.id, 'dismiss');
  await until(
    () => f.attempts.length === 1 && f.attempts[0].native.dispatch === 'attempted',
    'dispatched',
  );
  f.attempts[0].finish(false, 'ok');
  expect((await response).status).toBe(200);
});

test('a viewer correction is captured as explicit feedback', async () => {
  const { f } = await fixture();
  const response = await f.viewer.app.request(`/api/threads/${f.thread.id}/interventions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      traceId: 't',
      spanId: 's',
      correction: 'Merge it yourself once green.',
    }),
  });
  expect(response.status).toBe(201);
  await until(() => feedbackPrompt(f), 'tuning prompt raised');
  const { items } = (await (await f.viewer.app.request('/api/feedback')).json()) as {
    items: Array<{ originKind: string }>;
  };
  expect(items[0]?.originKind).toBe('intervention');
});
