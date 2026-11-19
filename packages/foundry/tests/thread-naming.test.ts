import { expect, test } from 'bun:test';
import {
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  Thread,
  threadTitle,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import {
  FIRST_MESSAGE_NAME_MAX_CHARS,
  firstMessageName,
  hasWorkContent,
  nameThreadFromMessage,
} from '../src/tools/thread-record';
import { ConfigStore } from '../src/viewer/config';
import { registerRuntimeRoutes } from '../src/viewer/routes/runtime';
import { withStreams } from './helpers/data-stream';

const unnamed = () => new Thread('t', new ContextStack(), { description: '' });

test("a first name is the message's words on one line, cut at a word with an ellipsis", () => {
  expect(firstMessageName('  Fix the flaky\n\tlogin test  ')).toBe('Fix the flaky login test');
  const long = `Please look at the billing export and ${'make it faster '.repeat(5)}`;
  const name = firstMessageName(long);
  expect(name.endsWith('…')).toBe(true);
  expect(name.length).toBeLessThanOrEqual(FIRST_MESSAGE_NAME_MAX_CHARS + 1);
  expect(long.startsWith(name.slice(0, -1))).toBe(true);
  expect(long[name.length - 1]).toBe(' ');
  // One unbroken word longer than the cap is cut hard.
  expect(firstMessageName('x'.repeat(100))).toBe(`${'x'.repeat(FIRST_MESSAGE_NAME_MAX_CHARS)}…`);
});

test('work content: greetings and filler carry none; a short request does', () => {
  for (const text of [
    'hi',
    'Hello there!',
    'thanks, ok',
    'good morning',
    'hey how are you doing today?',
  ])
    expect({ text, work: hasWorkContent(text) }).toEqual({ text, work: false });
  for (const text of ['fix it', 'add dark mode', 'ZLT-42', 'why does login fail?'])
    expect({ text, work: hasWorkContent(text) }).toEqual({ text, work: true });
});

test("an unnamed thread takes the first message that names work, once, and never over a person's or the agent's name", () => {
  const thread = unnamed();
  expect(nameThreadFromMessage(thread, 'hey there')).toBe(false);
  expect(thread.meta.foundryName).toBeUndefined();
  expect(nameThreadFromMessage(thread, 'Fix the flaky login test')).toBe(true);
  expect(threadTitle(thread.meta)).toEqual({ text: 'Fix the flaky login test', source: 'foundry' });
  expect(thread.meta.foundryName?.by).toBeUndefined();
  expect(nameThreadFromMessage(thread, 'Now add a retry')).toBe(false);
  expect(thread.meta.foundryName?.text).toBe('Fix the flaky login test');

  const person = unnamed();
  person.rename('My name');
  expect(nameThreadFromMessage(person, 'Fix the flaky login test')).toBe(false);
  expect(threadTitle(person.meta)).toEqual({ text: 'My name', source: 'human' });

  const gone = unnamed();
  gone.dispose();
  expect(nameThreadFromMessage(gone, 'Fix the flaky login test')).toBe(false);
});

test('clearing the human name shows the Foundry name again', () => {
  const thread = unnamed();
  nameThreadFromMessage(thread, 'Fix the flaky login test');
  thread.rename('Human renamed this');
  expect(threadTitle(thread.meta)).toEqual({ text: 'Human renamed this', source: 'human' });
  thread.rename('');
  expect(threadTitle(thread.meta)).toEqual({ text: 'Fix the flaky login test', source: 'foundry' });
});

test('the message route names the thread from its first message as it is sent, with no model call, and a PATCH name overrides it', async () => {
  const stack = new ContextStack();
  const thread = new Thread('routed', stack, { description: 'Main conversation thread' });
  let executed = 0;
  thread.register(
    new Executor({
      id: 'worker',
      stack,
      handler: async () => {
        executed++;
        return 'done';
      },
    }),
  );
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  const app = new Hono();
  registerRuntimeRoutes(
    app,
    withStreams({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configStore: new ConfigStore('/tmp/unused-naming-config'),
    }),
  );
  const response = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Implement the requested change', threadId: 'routed' }),
  });
  expect(response.status).toBe(200);
  // Named from the message alone; a creation description does not block it. The executor is the only call.
  expect(executed).toBe(1);
  expect(threadTitle(thread.meta)).toEqual({
    text: 'Implement the requested change',
    source: 'foundry',
  });

  const renamed = await app.request('/api/threads/routed', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Human name' }),
  });
  expect(((await renamed.json()) as { title: unknown }).title).toEqual({
    text: 'Human name',
    source: 'human',
  });
  const cleared = await app.request('/api/threads/routed', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: null }),
  });
  expect(((await cleared.json()) as { title: unknown }).title).toEqual({
    text: 'Implement the requested change',
    source: 'foundry',
  });
});
