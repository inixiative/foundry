import { expect, test } from 'bun:test';
import { ContextLayer, ContextStack, type LLMMessage, SignalBus } from '@inixiative/foundry-core';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { Warden } from '../src/agents/warden';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

test('historical Warden evidence retains the actual phase protocol, separately from its three owned parts', async () => {
  const cache = new ContextLayer({ id: 'architecture', segment: 'domain-knowledge' });
  cache.set('DOMAIN_BEFORE: existing readers must keep working.');
  const stack = new ContextStack([cache]),
    signals = new SignalBus();
  const librarian = new Librarian({ stack, signals });
  const calls: LLMMessage[][] = [];
  const warden = new Warden({
    domain: 'architecture',
    cache,
    signals,
    advisePrompt: 'INSTRUCTIONS_BEFORE: assess architecture decisions.',
    llm: {
      id: 'controlled-phase-warden',
      async complete(messages) {
        calls.push(structuredClone(messages));
        return {
          model: 'controlled',
          content: '{"layers":[],"snippets":["Keep the legacy reader regression"],"confidence":1}',
        };
      },
    },
  });
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    wardens: new Map([['architecture', warden]]),
  });
  try {
    const plan = await flow.preMessage('Add preferred names');
    const prepared = await flow.hydrateDelta(plan);
    expect(calls).toHaveLength(1);
    const actualUserInput = calls[0]!.find((message) => message.role === 'user')!.content;
    const protocolStart = actualUserInput.indexOf(
      '## Response protocol (advice phase, trigger: user-message)',
    );
    expect(protocolStart).toBeGreaterThanOrEqual(0);
    const actualProtocol = actualUserInput.slice(protocolStart).trim();
    expect(actualProtocol).toContain('"layers"');

    // Inspect persisted-shaped evidence, not the current Warden or source constant.
    const historical = JSON.parse(JSON.stringify({ plan, decoration: prepared.decoration }));
    cache.set('DOMAIN_AFTER: changed after the turn.');
    expect(historical.plan.contributions[0].segments).toEqual({
      instructions: 'INSTRUCTIONS_BEFORE: assess architecture decisions.',
      domainKnowledge: 'DOMAIN_BEFORE: existing readers must keep working.',
      threadKnowledge: '',
    });
    expect(JSON.stringify(historical)).not.toContain('DOMAIN_AFTER');
    expect(strings(historical).some((value) => value.includes(actualProtocol))).toBe(true);
  } finally {
    flow.dispose();
    librarian.dispose();
  }
});
