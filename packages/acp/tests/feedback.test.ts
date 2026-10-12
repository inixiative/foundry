import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { InitializeRequest } from '@agentclientprotocol/sdk';
import type { CompletionResult, LLMProvider } from '@inixiative/foundry-core';
import { liveWatchFixture } from '../../foundry/tests/helpers/live-watch-fixture';
import { serveDaemon, spawnFoundryAcp, until } from './helpers/acp-host';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const INITIALIZE: InitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
  clientInfo: { name: 'Paseo', version: 'dev' },
};
const RULE = 'When a change is green on the agentic side, merge it yourself.';

/** The decision provider: the shared classify contract (sharp or not) and the match call. */
const decisions = (sharp: boolean) =>
  ({
    id: 'decisions',
    async complete(messages: Array<{ content: unknown }>): Promise<CompletionResult> {
      const classify = String(messages[0]?.content ?? '').startsWith('You classify one message');
      return {
        content: classify
          ? JSON.stringify({
              isCorrection: true,
              category: 'approach',
              statements: sharp ? [RULE] : [],
              sharp,
            })
          : JSON.stringify({ itemId: null, confidence: 0 }),
      } as CompletionResult;
    },
  }) as LLMProvider;

async function session(sharp = true) {
  await mkdir(resolve('.foundry/qa'), { recursive: true });
  const dir = await mkdtemp(resolve('.foundry/qa/acp-feedback-'));
  const f = await liveWatchFixture(dir, { feedbackProvider: decisions(sharp) });
  const daemon = serveDaemon(f.viewer);
  const h = spawnFoundryAcp(daemon.launchPath);
  cleanup.push(async () => {
    await h.close();
    daemon.stop();
    await f.close();
  });
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  const correct = (correction: string) =>
    f.viewer.app.request(`/api/threads/${sessionId}/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ traceId: 't', spanId: 's', correction }),
    });
  const command = (text: string) =>
    h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const replies = () =>
    JSON.stringify(h.updates(sessionId).filter((u) => u.sessionUpdate === 'agent_message_chunk'));
  return { f, h, sessionId, correct, command, replies };
}

const feedbackItem = async (f: Awaited<ReturnType<typeof liveWatchFixture>>) => {
  const response = await f.viewer.app.request('/api/feedback');
  return ((await response.json()) as { items: Array<{ id: string; stage: string }> }).items[0];
};

test('a non-blocking feedback prompt is a card, never a permission dialog; /feedback answers it', async () => {
  const { f, h, sessionId, correct, command } = await session();
  expect((await correct('Merge it yourself once green.')).status).toBe(201);
  await until(
    () =>
      h
        .updates(sessionId)
        .some((u) => u.sessionUpdate === 'tool_call' && u.title === 'Foundry: feedback'),
    'feedback card',
  );
  const card = h.updates(sessionId).find((u) => u.sessionUpdate === 'tool_call');
  expect(JSON.stringify(card)).toContain('What we intend: Add it');
  expect(h.permissions).toHaveLength(0);
  const item = await feedbackItem(f);
  expect(await command(`/feedback apply ${item!.id}`)).toEqual({ stopReason: 'end_turn' });
  await until(async () => (await feedbackItem(f))?.stage === 'applied', 'applied');
  await until(
    () =>
      h
        .updates(sessionId)
        .some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'),
    'card settled',
  );
});

test('a blocking feedback prompt asks the host: Apply / Not a rule / Later, and holds the turn', async () => {
  const { f, h, sessionId } = await session();
  await f.viewer.app.request('/api/settings/feedback', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tuning: 'block' }),
  });
  h.answerPermissions(async () => ({ outcome: { outcome: 'selected', optionId: 'dismiss' } }));
  const prompt = h.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'No, merge it yourself once green, I told you already.' }],
  });
  await until(
    () => f.attempts.length === 1 && f.attempts[0].native.dispatch === 'attempted',
    'dispatched after the answer',
  );
  const [ask] = h.permissions;
  expect(ask!.request.options.map((o) => [o.optionId, o.kind])).toEqual([
    ['apply', 'allow_once'],
    ['dismiss', 'reject_once'],
    ['later', 'reject_once'],
  ]);
  expect(ask!.request._meta).toMatchObject({ foundry: { feedbackItemId: expect.any(String) } });
  f.attempts[0].finish(false, 'done');
  expect(await prompt).toEqual({ stopReason: 'end_turn' });
  expect((await feedbackItem(f))?.stage).toBe('dismissed');
});

test('/feedback answers with the items that need attention, and a count of the rest', async () => {
  const { f, h, sessionId, correct, command, replies } = await session(false);
  expect((await correct("That's not how we do it.")).status).toBe(201);
  await until(() => f.actionQueue.pending().some((p) => p.meta?.feedback), 'captured');
  await command('/feedback');
  await until(() => replies().includes('1 need attention'), '/feedback summary');
  expect(replies()).toContain('Not yet a crisp rule');
  // An invalid edit is refused, not silently lost.
  const item = await feedbackItem(f);
  await command(`/feedback edit ${item!.id} Try to be careful.`);
  await until(() => replies().includes('not sharp'), 'refused edit');
  expect(h.updates(sessionId).length).toBeGreaterThan(0);
});
