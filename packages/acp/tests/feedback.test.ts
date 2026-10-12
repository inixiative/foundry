import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { InitializeRequest } from '@agentclientprotocol/sdk';
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

async function session() {
  await mkdir(resolve('.foundry/qa'), { recursive: true });
  const dir = await mkdtemp(resolve('.foundry/qa/acp-feedback-'));
  const f = await liveWatchFixture(dir);
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
  return { f, h, sessionId };
}

/** A tuning prompt as the feedback service raises it. */
const tuning = (
  f: Awaited<ReturnType<typeof liveWatchFixture>>,
  threadId: string,
  blocking: boolean,
) =>
  f.actionQueue.prompt({
    kind: 'choice',
    threadId,
    agentId: 'feedback',
    capability: 'feedback',
    message: 'm',
    options: [
      { id: 'apply', label: 'Apply' },
      { id: 'edit', label: 'Edit, then apply' },
      { id: 'dismiss', label: 'Not a rule' },
      { id: 'later', label: 'Later' },
    ],
    meta: {
      feedback: {
        itemId: 'fb_0123456789ab',
        blocking,
        shown: {
          happened: 'You said "again"',
          did: 'Captured rule fb_0123456789ab',
          intend: 'Add it',
        },
      },
    },
  });

test('a non-blocking feedback prompt is a card, never a permission dialog; /feedback answers it', async () => {
  const { f, h, sessionId } = await session();
  const answered = tuning(f, sessionId, false);
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
  const reply = await h.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '/feedback apply fb_0123456789ab' }],
  });
  expect(reply).toEqual({ stopReason: 'end_turn' });
  expect((await answered).action).toBe('apply');
  await until(
    () =>
      h
        .updates(sessionId)
        .some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'),
    'card settled',
  );
});

test('a blocking feedback prompt asks the host: Apply / Not a rule / Later', async () => {
  const { f, h, sessionId } = await session();
  h.answerPermissions(async () => ({ outcome: { outcome: 'selected', optionId: 'dismiss' } }));
  const answered = tuning(f, sessionId, true);
  expect((await answered).action).toBe('dismiss');
  const [ask] = h.permissions;
  expect(ask!.request.options.map((o) => [o.optionId, o.kind])).toEqual([
    ['apply', 'allow_once'],
    ['dismiss', 'reject_once'],
    ['later', 'reject_once'],
  ]);
  expect(ask!.request._meta).toMatchObject({ foundry: { feedbackItemId: 'fb_0123456789ab' } });
  await until(
    () =>
      h
        .updates(sessionId)
        .some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed'),
    'card settled as not a rule',
  );
});
