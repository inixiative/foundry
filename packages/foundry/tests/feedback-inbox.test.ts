import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionResult, LLMProvider } from '@inixiative/foundry-core';
import { captureThread } from '../src/archives/capture';
import { FeedbackLifecycle } from '../src/feedback/lifecycle';
import { connectStreams } from './helpers/data-stream';
import { liveWatchFixture, until } from './helpers/live-watch-fixture';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Item = {
  id: string;
  statement: string;
  originKind: string;
  inbox: 'open' | 'archived';
  projectId: string | null;
  origin: { threadId: string; turnId: string | null; at: number };
  author?: { name: string; surface: string };
  messageId?: string;
  tags: string[];
};

/** A decision provider that would call every typed message a correction. */
const eager = {
  id: 'eager-decisions',
  async complete(messages: Array<{ content: unknown }>): Promise<CompletionResult> {
    const classify = String(messages[0]?.content ?? '').startsWith('You classify messages');
    return {
      content: classify
        ? JSON.stringify({
            results: {
              M1: { isCorrection: true, category: 'approach', statements: [], sharp: false },
            },
          })
        : JSON.stringify({ itemId: null, confidence: 0 }),
    } as CompletionResult;
  },
} as LLMProvider;

async function fixture(feedbackProvider?: LLMProvider) {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-inbox-'));
  const f = await liveWatchFixture(dir, feedbackProvider ? { feedbackProvider } : {});
  cleanup.push(async () => {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  const json = (path: string, body?: unknown) =>
    f.viewer.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const give = (threadId: string, body: Record<string, unknown>) =>
    json(`/api/threads/${threadId}/feedback`, body);
  const list = async (query = '') =>
    ((await (await f.viewer.app.request(`/api/feedback${query}`)).json()) as { items: Item[] })
      .items;
  /** One completed turn on the fixture's thread. */
  const turn = async (id: string, message: string) => {
    const response = f.viewer.app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, threadId: f.thread.id, message }),
    });
    await until(() => f.attempts.some((a) => a.native.dispatch === 'attempted' && !a.done), id);
    f.attempts.find((a) => !a.done).finish(false, `answer to ${id}`);
    expect((await response).status).toBe(200);
  };
  return { f, give, list, json, turn };
}

test('/feedback records an explicit item pointing at the last turn, with its provenance', async () => {
  const { f, give, list, turn } = await fixture();
  await turn('turn-1', 'Write the release notes.');
  const response = await give(f.thread.id, {
    text: '  Too long; one paragraph.  ',
    tags: ['notes'],
  });
  expect(response.status).toBe(201);
  const { item } = (await response.json()) as { item: Item };
  expect(item).toMatchObject({
    statement: 'Too long; one paragraph.',
    originKind: 'explicit',
    inbox: 'open',
    projectId: 'P',
    origin: { threadId: f.thread.id, turnId: 'turn-1' },
    author: { surface: 'viewer' },
    tags: ['notes'],
  });
  expect(item.author?.name).toBeTruthy();
  // Explicit feedback is recorded as said: no turn is sent, nothing is classified or tuned.
  expect(f.attempts).toHaveLength(1);
  expect(f.actionQueue.pending()).toHaveLength(0);
  expect((await list()).map((i) => i.id)).toEqual([item.id]);

  // A named message and turn win over the default.
  const named = (await (
    await give(f.thread.id, { text: 'That one.', turnId: 'turn-0', messageId: 'm-1' })
  ).json()) as { item: Item };
  expect(named.item).toMatchObject({ origin: { turnId: 'turn-0' }, messageId: 'm-1' });
});

test('feedback input is validated; an unknown thread is a 404', async () => {
  const { f, give } = await fixture();
  expect((await give(f.thread.id, {})).status).toBe(400);
  expect((await give(f.thread.id, { text: '   ' })).status).toBe(400);
  expect((await give(f.thread.id, { text: 'x', tags: [1] })).status).toBe(400);
  expect((await give(f.thread.id, { text: 'x'.repeat(4_001) })).status).toBe(400);
  expect((await give('no-such-thread', { text: 'x' })).status).toBe(404);
});

test('the inbox: newest first, filter by status, project and thread; bulk archive and unarchive', async () => {
  const { f, give, list, json } = await fixture();
  const streams = connectStreams(f.viewer);
  cleanup.push(() => streams.disconnect());
  await streams.open('feedback');
  const ids: string[] = [];
  for (const [thread, text] of [
    [f.thread.id, 'first'],
    [f.other.id, 'second'],
    [f.thread.id, 'third'],
  ] as const) {
    const { item } = (await (await give(thread, { text })).json()) as { item: Item };
    ids.push(item.id);
    await Bun.sleep(2);
  }
  expect((await list()).map((i) => i.statement)).toEqual(['third', 'second', 'first']);
  expect((await list(`?threadId=${f.other.id}`)).map((i) => i.statement)).toEqual(['second']);
  expect(await list('?projectId=P')).toHaveLength(3);
  expect(await list('?projectId=elsewhere')).toHaveLength(0);
  expect((await f.viewer.app.request('/api/feedback?status=closed')).status).toBe(400);

  const archived = await json('/api/feedback/status', {
    itemIds: [ids[0], ids[2]],
    status: 'archived',
  });
  expect(archived.status).toBe(200);
  expect(((await archived.json()) as { items: Item[] }).items).toHaveLength(2);
  expect((await list('?status=open')).map((i) => i.statement)).toEqual(['second']);
  expect((await list('?status=archived')).map((i) => i.statement)).toEqual(['third', 'first']);
  // The stream holder sees the change.
  await until(
    () =>
      streams
        .data('feedback')
        .some(
          (frame) => frame.payload?.item?.id === ids[0] && frame.payload.item.inbox === 'archived',
        ),
    'archived on the stream',
  );

  await json('/api/feedback/status', { itemIds: [ids[2]], status: 'open' });
  expect((await list('?status=open')).map((i) => i.statement)).toEqual(['third', 'second']);
  expect(
    (await json('/api/feedback/status', { itemIds: ['fb_nope'], status: 'open' })).status,
  ).toBe(404);
  expect((await json('/api/feedback/status', { itemIds: [], status: 'open' })).status).toBe(400);

  // The inbox is journalled: a restart folds the same state back.
  const again = new FeedbackLifecycle(f.viewer.localStore!.feedbackPhases());
  expect(again.get(ids[0]!)?.inbox).toBe('archived');
  expect(again.get(ids[2]!)?.inbox).toBe('open');
});

test('automatic correction detection is off by default; /correction still records', async () => {
  const { f, list, turn } = await fixture(eager);
  await turn('turn-1', 'No, merge it yourself once green, I told you already.');
  await Bun.sleep(50);
  expect(await list()).toHaveLength(0);
  const response = await f.viewer.app.request(`/api/threads/${f.thread.id}/interventions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ traceId: 't', spanId: 's', correction: "That's not how we do it." }),
  });
  expect(response.status).toBe(201);
  await until(async () => (await list()).length === 1, 'correction recorded');
  expect((await list())[0]).toMatchObject({ originKind: 'intervention', inbox: 'open' });
});

test('without a decision provider, /correction is recorded as explicit feedback', async () => {
  const { f, list } = await fixture();
  await f.viewer.app.request(`/api/threads/${f.thread.id}/interventions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ traceId: 't', spanId: 's', correction: 'Use the shared helper.' }),
  });
  await until(async () => (await list()).length === 1, 'correction recorded');
  expect((await list())[0]).toMatchObject({
    originKind: 'explicit',
    statement: 'Use the shared helper.',
    tags: ['correction'],
  });
});

test("feedback reaches the thread's archive snapshot as entries with its text and provenance", async () => {
  const { f, give, json, turn } = await fixture();
  await turn('turn-1', 'Rename the module.');
  const { item } = (await (await give(f.thread.id, { text: 'Keep the old name.' })).json()) as {
    item: Item;
  };
  await json('/api/feedback/status', { itemIds: [item.id], status: 'archived' });
  const snapshot = captureThread(f.viewer.localStore!, crypto.randomUUID(), f.thread.id);
  const entries = snapshot.entries.filter((entry) => entry.text?.includes(item.id));
  expect(entries.map((entry) => JSON.parse(entry.text!).phase)).toEqual([
    'feedback-capture',
    'feedback-status',
  ]);
  expect(entries[0]).toMatchObject({ turnId: 'turn-1', kind: 'event' });
  expect(JSON.parse(entries[0]!.text!).record).toMatchObject({
    statement: 'Keep the old name.',
    origin: 'explicit',
  });
});
