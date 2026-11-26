// Dev mode's review (R-2026-11-25-05): one completed dispatch is one `chorus.review` for every Warden,
// each Warden learning its own update off the shared answer through the local commit path.

import { afterEach, expect, test } from 'bun:test';
import { ContextLayer, ContextStack, type LLMProvider } from '@inixiative/foundry-core';
import type { ChorusOperation } from '@inixiative/signet';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import {
  type ChorusCallOutcome,
  type ChorusTransport,
  createChorusRemote,
} from '../src/providers/chorus-client';
import { starterConfig } from '../src/viewer/config';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test('one chorus.review for N Wardens; each learns only its own update', async () => {
  const domains = ['security', 'docs'];
  const config = starterConfig('mock', 'mock');
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'mock',
      model: 'mock',
      prompt: '',
      temperature: 0,
      enabled: true,
    },
  };
  const template = new ContextStack(
    domains.map((d) => {
      const layer = new ContextLayer({ id: d, prompt: `Configured ${d} instructions` });
      layer.set(`CONFIGURED-${d}-KNOWLEDGE`);
      return layer;
    }),
  );
  const provider: LLMProvider = {
    id: 'mock',
    complete: async () => ({ model: 'mock', content: 'WORK-OUTPUT: done' }),
  };
  const localAsks: string[] = [];
  const flowLlm: LLMProvider = {
    id: 'flow',
    complete: async (_messages, opts) => {
      localAsks.push(opts?.threadId ?? '');
      return { model: 'mock', content: 'NO_COMMENT' };
    },
  };
  const sent: Array<{ operation: ChorusOperation; projectId: string; domains: unknown }> = [];
  const transport: ChorusTransport = async (operation, call) => {
    const input = call.input as Record<string, unknown>;
    sent.push({ operation, projectId: call.projectId, domains: input.domains });
    const outcome =
      operation === 'chorus.review'
        ? {
            ok: true,
            result: {
              rosterRevision: 'r1',
              threadKnowledgeUpdates: { security: 'REMOTE-LEARNED: tokens live in cookies' },
              elapsedMs: 1,
            },
          }
        : { ok: true, result: { rosterRevision: 'r1', contributions: [], elapsedMs: 1 } };
    return outcome as ChorusCallOutcome<typeof operation>;
  };
  const remote = createChorusRemote({ projectId: 'P', endpoint: 'http://chorus', transport });
  const runtime = new ThreadRuntimeManager({
    config,
    log: () => {},
    warn: () => {},
    codeWardens: domains.map((d) => ({ domain: d, layerId: d, guardTriggers: [] })),
    llm: flowLlm,
    chorusRemote: (projectId) => (projectId === 'P' ? remote : undefined),
  });
  cleanups.push(() => runtime.disposeAll());
  const factory = new ThreadFactory({
    stack: template,
    agents: buildAgents(config, template, { provider }),
    runtime,
  });
  const thread = factory.create('a', { projectId: 'P' });
  await thread.dispatch('worker', 'Set up auth');
  const owned = runtime.get('a')!;
  await owned.learningSettled();

  const reviews = sent.filter((s) => s.operation === 'chorus.review');
  expect(reviews).toEqual([{ operation: 'chorus.review', projectId: 'P', domains }]);
  expect(sent.some((s) => s.operation === 'chorus.advise')).toBe(true);
  // No local Warden model was asked to advise or review.
  expect(localAsks.filter((id) => id.includes(':domain:'))).toEqual([]);
  expect(owned.wardens.get('security')!.threadKnowledge.content).toContain('REMOTE-LEARNED');
  expect(owned.wardens.get('docs')!.threadKnowledge.revision).toBe(0);
});
