import { expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextLayer,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { oneCall, Warden } from '../src/agents/warden';
import { primedRequest } from '../src/providers/warden-routing';

/** Records every call; answers with the given JSON. */
function recording(content: string) {
  const calls: Array<{ messages: LLMMessage[]; opts?: CompletionOpts }> = [];
  const llm: LLMProvider = {
    id: 'recording',
    async complete(messages, opts) {
      calls.push({ messages: structuredClone(messages), opts });
      return { content, model: 'm' };
    },
  };
  return { llm, calls };
}

test('the stable prefix becomes the held context and only the rest is the per-cycle input', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'ROLE' },
    { role: 'user', content: '## Domain cache (x)\nCACHE\n\n## Message\nhi' },
  ];
  const { spec, input } = primedRequest(
    messages,
    { stablePrefix: '## Domain cache (x)\nCACHE\n' },
    'T:aux:domain:x',
  );
  expect(spec).toMatchObject({ instructions: 'ROLE', context: '## Domain cache (x)\nCACHE\n' });
  expect(spec.key).toStartWith('T:aux:domain:x#');
  expect(input).toBe('\n## Message\nhi');
  // Same session and instructions, changed context: same key, new hash (re-prime).
  const changed = primedRequest(
    [messages[0]!, { role: 'user', content: '## Domain cache (x)\nNEW\n\n## Message\nhi' }],
    { stablePrefix: '## Domain cache (x)\nNEW\n' },
    'T:aux:domain:x',
  );
  expect(changed.spec.key).toBe(spec.key);
  expect(changed.spec.hash).not.toBe(spec.hash);
  // Other instructions on the same aux session: another key.
  expect(
    primedRequest([{ role: 'system', content: 'GUARD' }, messages[1]!], {}, 'T:aux:domain:x').spec
      .key,
  ).not.toBe(spec.key);
});

test('a prefix that does not match is never held; the whole message is the input', () => {
  const { spec, input } = primedRequest(
    [{ role: 'user', content: 'hello' }],
    { stablePrefix: '## Domain cache' },
    'k',
  );
  expect(spec.context).toBe('');
  expect(input).toBe('hello');
  expect(() => primedRequest([{ role: 'system', content: 'only' }], {}, 'k')).toThrow(
    'final user message',
  );
});

test('advice and guard declare their domain cache as the stable prefix of the message they send', async () => {
  const { llm, calls } = recording('{"layers":[],"snippets":[],"confidence":0.5}');
  const cache = new ContextLayer({ id: 'api', segment: 'domain-knowledge' });
  cache.set('Routes live under src/api.');
  const lib = new Warden({
    domain: 'api',
    cache,
    signals: new SignalBus(),
    llm,
    guardTriggers: ['Bash'],
  });
  await lib.advise('Add a route', 'state');
  await lib.guard(oneCall({ tool: 'Bash', input: { command: 'ls' }, output: 'ok' }), 'state');
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    const prefix = call.opts?.stablePrefix;
    expect(prefix).toBe('## Domain cache (api)\nRoutes live under src/api.\n');
    expect(call.messages[1]!.content.startsWith(prefix!)).toBe(true);
    expect(call.messages[1]!.content.length).toBeGreaterThan(prefix!.length);
  }
});
