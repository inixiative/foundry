import { expect, test } from 'bun:test';
import {
  type CompletionResult,
  ContextLayer,
  ContextStack,
  callOutcomeLabel,
  type LLMProvider,
  SignalBus,
  servedModel,
} from '@inixiative/foundry-core';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { oneCall, Warden } from '../src/agents/warden';

const configuration = {
  requestedModel: 'gpt-6-luna',
  requestedEffort: 'low',
  turnBudgetEnforcement: 'launch-option' as const,
  tokenBudget: 'unavailable' as const,
  effortBudget: 'unavailable' as const,
};
const native = (extra: object = {}) => ({
  schema: 1 as const,
  nativeOutcome: 'completed' as const,
  configuration: { ...configuration, ...extra },
});

test('a completion is served by its native acknowledgment, then its request, then the reported model', () => {
  expect(servedModel({ model: 'api-model' })).toEqual({ model: 'api-model' });
  expect(servedModel({ model: 'gpt-6-luna', native: native() })).toEqual({
    model: 'gpt-6-luna',
    effort: 'low',
  });
  expect(
    servedModel({
      model: 'opus',
      native: native({ observedModel: 'claude-opus-5-5', observedEffort: 'high' }),
    }),
  ).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  // The engine reported no effort: the requested one did not run.
  expect(servedModel({ model: 'm', native: native({ observedEffort: null }) })).toEqual({
    model: 'gpt-6-luna',
  });
});

function harness(slowDomain?: Promise<void>) {
  const signals = new SignalBus();
  const cache = new ContextLayer({ id: 'architecture', segment: 'domain-knowledge' });
  cache.set('Readers keep working.');
  const slow = new ContextLayer({ id: 'security', segment: 'domain-knowledge' });
  slow.set('Secrets stay private.');
  const stack = new ContextStack([cache, slow]);
  const librarian = new Librarian({ stack, signals });
  const provider = (id: string, answer: () => Promise<CompletionResult>): LLMProvider => ({
    id,
    complete: answer,
  });
  const advice = JSON.stringify({ layers: [], snippets: ['Keep the reader'], confidence: 1 });
  const architecture = new Warden({
    domain: 'architecture',
    cache,
    signals,
    guardTriggers: ['Write'],
    llm: provider('architecture', async () => ({
      model: 'opus',
      native: native({ observedModel: 'claude-opus-5-5', requestedEffort: 'medium' }),
      content: advice,
    })),
  });
  const security = new Warden({
    domain: 'security',
    cache: slow,
    signals,
    llm: provider('security', async () => {
      await slowDomain;
      return { model: 'late-model', content: advice };
    }),
  });
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    wardens: new Map([
      ['architecture', architecture],
      ['security', security],
    ]),
    adviseTimeoutMs: 200,
  });
  return {
    flow,
    architecture,
    dispose() {
      flow.dispose();
      librarian.dispose();
    },
  };
}

test('advice requests record what served them; a call that missed the deadline records nothing', async () => {
  let release!: () => void;
  const h = harness(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    const plan = await h.flow.preMessage('Add preferred names', {
      messageId: 'turn-1',
      threadId: 'thread-1',
      projectId: 'project-1',
    });
    const byDomain = Object.fromEntries(plan.contributions.map((c) => [c.domain, c]));
    expect(byDomain.architecture!.request).toMatchObject({
      status: 'supplied',
      served: { model: 'claude-opus-5-5', effort: 'medium' },
    });
    expect(callOutcomeLabel(byDomain.security!.outcome)).toBe('failed:timeout');
    expect(byDomain.security!.request).not.toHaveProperty('served');
  } finally {
    release();
    h.dispose();
  }
});

test('a completed guard check records what served it', async () => {
  const h = harness();
  try {
    const result = await h.architecture.guard(
      oneCall({ tool: 'Write', input: { file_path: 'a.ts' } }),
    );
    expect(callOutcomeLabel(result.outcome)).toBe('failed:invalid-response');
    expect(result.request).toMatchObject({
      status: 'supplied',
      served: { model: 'claude-opus-5-5', effort: 'medium' },
    });
  } finally {
    h.dispose();
  }
});
