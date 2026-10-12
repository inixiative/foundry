import { expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextLayer,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { Cartographer } from '../src/agents/cartographer';
import { DomainLibrarian } from '../src/agents/domain-librarian';
import { primedRequest } from '../src/providers/primed-decisions';

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

test('the stable prefix becomes primed context and only the rest is the per-cycle input', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'ROLE' },
    { role: 'user', content: '## Domain cache (x)\nCACHE\n\n## Message\nhi' },
  ];
  const { spec, input } = primedRequest(
    messages,
    { stablePrefix: '## Domain cache (x)\nCACHE\n' },
    'T:aux:domain:x',
    true,
  );
  expect(spec).toMatchObject({ instructions: 'ROLE', context: '## Domain cache (x)\nCACHE\n' });
  expect(spec.key).toBe(`primed:${spec.hash!.slice(0, 32)}`);
  expect(input).toBe('\n## Message\nhi');
  // The key is the primed content: another session (phase or thread) with it shares the key.
  expect(
    primedRequest(
      messages,
      { stablePrefix: '## Domain cache (x)\nCACHE\n' },
      'U:aux:review:1',
      true,
    ).spec.key,
  ).toBe(spec.key);
  // Changed context or instructions: another primed state, another key.
  const changed = primedRequest(
    [messages[0]!, { role: 'user', content: '## Domain cache (x)\nNEW\n\n## Message\nhi' }],
    { stablePrefix: '## Domain cache (x)\nNEW\n' },
    'T:aux:domain:x',
    true,
  );
  expect(changed.spec.key).not.toBe(spec.key);
  expect(
    primedRequest([{ role: 'system', content: 'GUARD' }, messages[1]!], {}, 'T:aux:domain:x', true)
      .spec.key,
  ).not.toBe(spec.key);
  // Unshared (Codex, one-shot): the logical session's own key.
  const oneShot = primedRequest(
    messages,
    { stablePrefix: '## Domain cache (x)\nCACHE\n' },
    'decision:1',
    false,
  );
  expect(oneShot.spec.key).toStartWith('decision:1#');
  expect(oneShot.spec.hash).toBe(spec.hash);
});

test("a configured Warden's advice, guard and review fork one primed state on every thread", async () => {
  const specs: string[] = [];
  const answers = [
    'NO_COMMENT',
    'NO_COMMENT',
    'NO_COMMENT',
    'NO_COMMENT',
    'NO_COMMENT',
    'NO_COMMENT',
  ];
  const llm: LLMProvider = {
    id: 'recording',
    async complete(messages, opts) {
      const { spec, input } = primedRequest(messages, opts ?? {}, opts?.threadId ?? 'x', true);
      expect(spec.context).not.toBe('');
      expect(input).not.toContain('Routes live under src/api.');
      specs.push(`${spec.key} ${spec.hash}`);
      return { content: answers.shift()!, model: 'm' };
    },
  };
  for (const thread of ['T1', 'T2']) {
    const cache = new ContextLayer({ id: 'api', segment: 'domain-knowledge' });
    cache.set('Routes live under src/api.');
    const instructions = new ContextLayer({ id: 'api-instructions' });
    instructions.set('You are the API Warden.');
    const lib = new DomainLibrarian({
      domain: 'api',
      cache,
      instructions,
      signals: new SignalBus(),
      llm: {
        ...llm,
        complete: (m, o) => llm.complete(m, { ...o, threadId: `${thread}:aux:domain:api` }),
      },
      reviewLlm: {
        ...llm,
        complete: (m, o) =>
          llm.complete(m, { ...o, threadId: `${thread}:aux:review:1:domain:api` }),
      },
      guardTriggers: ['Bash'],
    });
    await lib.advise('Add a route', 'state');
    await lib.guard({ tool: 'Bash', input: { command: 'ls' }, output: 'ok' } as never, 'state');
    await lib.review({
      evidence: { kind: 'dispatch', id: 'd1', timestamp: 1 },
      agentId: 'a',
      ok: true,
      userMessage: 'Add a route',
      output: 'done',
      toolObservations: [],
    });
  }
  expect(specs).toHaveLength(6);
  expect(new Set(specs).size).toBe(1);
});

test('a prefix that does not match is never primed; the whole message is the input', () => {
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
  const lib = new DomainLibrarian({
    domain: 'api',
    cache,
    signals: new SignalBus(),
    llm,
    guardTriggers: ['Bash'],
  });
  await lib.advise('Add a route', 'state');
  await lib.guard({ tool: 'Bash', input: { command: 'ls' }, output: 'ok' } as never, 'state');
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    const prefix = call.opts?.stablePrefix;
    expect(prefix).toBe('## Domain cache (api)\nRoutes live under src/api.\n');
    expect(call.messages[1]!.content.startsWith(prefix!)).toBe(true);
    expect(call.messages[1]!.content.length).toBeGreaterThan(prefix!.length);
  }
});

test('routing declares the topology map (and atlas) as its stable prefix', async () => {
  const { llm, calls } = recording('{"layers":[],"domains":[],"confidence":0.5}');
  const layer = new ContextLayer({ id: 'auth-docs' });
  layer.set('Auth docs.');
  const carto = new Cartographer({
    stack: new ContextStack([layer]),
    signals: new SignalBus(),
    llm,
  });
  await carto.route('Where are the auth docs?', 'state');
  const prefix = calls[0]!.opts!.stablePrefix!;
  expect(prefix).toStartWith('## Available context (topology map)\n');
  expect(calls[0]!.messages[1]!.content.startsWith(prefix)).toBe(true);
  expect(calls[0]!.messages[1]!.content.slice(prefix.length)).toContain(
    '## Message to route\nWhere are the auth docs?',
  );
});
