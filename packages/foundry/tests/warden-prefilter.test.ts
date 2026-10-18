import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextLayer, ContextStack, type LLMMessage, SignalBus } from '@inixiative/foundry-core';
import { Cartographer } from '../src/agents/cartographer';
import { DomainLibrarian, oneCall } from '../src/agents/domain-librarian';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { NO_COMMENT } from '../src/classify';
import { enabledPrefilter } from '../src/daemon';
import {
  DEFAULT_PREFILTER,
  type PrefilterHealth,
  resolvePrefilterSettings,
  validatePrefilterSettings,
  WardenPrefilter,
} from '../src/providers/warden-prefilter';
import { inspectReadiness } from '../src/readiness';
import { ConfigStore, starterConfig } from '../src/viewer/config';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** A System One server double: a score per question, chosen by the Warden named in it. */
function server(scores: Record<string, number>, seen: unknown[] = []) {
  return async (url: string, init: RequestInit) => {
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    const body = JSON.parse(init.body as string) as {
      questions: Record<string, { instructions: string }>;
    };
    seen.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, q]) => {
        const domain = Object.keys(scores).find((d) => q.instructions.includes(`${d} rules`));
        return [id, { type: 'noul', noul: domain ? scores[domain] : 0.9 }];
      }),
    );
    return Response.json({
      model: 'kev-latest',
      answers,
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  };
}
const down = async () => {
  throw new TypeError('fetch failed');
};

function roster(domains: string[], prefilter?: WardenPrefilter) {
  const calls: Array<{ domain: string; phase: string }> = [];
  const signals = new SignalBus();
  const layers = domains.map((id) => {
    const layer = new ContextLayer({ id, segment: 'domain-knowledge' });
    layer.set(`${id} knowledge`);
    return layer;
  });
  const stack = new ContextStack(layers);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({
    stack,
    signals,
    llm: {
      id: 'route',
      complete: async () => ({
        model: 'x',
        content: JSON.stringify({ layers: [], domains: [], confidence: 0 }),
      }),
    },
  });
  const phaseOf = (messages: readonly LLMMessage[]) =>
    messages.some((m) => String(m.content).includes('Response protocol (guard phase'))
      ? 'guard'
      : 'advice';
  const libs = new Map(
    layers.map((cache) => [
      cache.id,
      new DomainLibrarian({
        domain: cache.id,
        cache,
        signals,
        advisePrompt: `You are the ${cache.id} Warden. Check ${cache.id} rules.`,
        guardPrompt: `You are the ${cache.id} Warden. Check ${cache.id} rules.`,
        guardTriggers: ['Edit'],
        llm: {
          id: `warden-${cache.id}`,
          async complete(messages) {
            calls.push({ domain: cache.id, phase: phaseOf(messages) });
            return { model: 'x', content: NO_COMMENT };
          },
        },
      }),
    ]),
  );
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    cartographer,
    domainLibrarians: libs,
    ...(prefilter ? { prefilter, threadId: 't1' } : {}),
  });
  cleanups.push(() => {
    flow.dispose();
    cartographer.dispose();
    librarian.dispose();
  });
  return { flow, calls };
}

test('the pre-filter is off by default, on a loopback model server when turned on', () => {
  expect(resolvePrefilterSettings(undefined)).toEqual(DEFAULT_PREFILTER);
  expect(DEFAULT_PREFILTER.enabled).toBe(false);
  expect(resolvePrefilterSettings({ enabled: true }).enabled).toBe(true);
  expect(() =>
    validatePrefilterSettings('prefilter', { baseUrl: 'https://api.example.com' }),
  ).toThrow('loopback');
  expect(() => validatePrefilterSettings('prefilter', { skipBelow: 1 })).toThrow('skipBelow');
  expect(() => validatePrefilterSettings('prefilter', { other: true })).toThrow('unknown field');
});

test('a confident no skips the Warden, journalled with its score; an unsure one is asked', async () => {
  const seen: unknown[] = [];
  const prefilter = new WardenPrefilter(
    { skipBelow: 0.2 },
    { fetch: server({ voice: 0.05, schema: 0.15, ship: 0.35 }, seen) },
  );
  const { flow, calls } = roster(['voice', 'schema', 'ship'], prefilter);

  const plan = await flow.preMessage('Add a column to the invites table');
  const by = Object.fromEntries(plan.contributions.map((c) => [c.domain, c]));
  expect(by.voice).toMatchObject({
    decision: 'skipped',
    reason: 'prefilter',
    prefilter: { score: 0.05, skipBelow: 0.2 },
  });
  expect(by.schema).toMatchObject({ decision: 'skipped', prefilter: { score: 0.15 } });
  expect(by.ship!.decision).toBe('no-comment');
  expect(plan.prefilter).toMatchObject({ status: 'scored', skipped: 2 });
  expect(calls).toEqual([{ domain: 'ship', phase: 'advice' }]);
  // One call per trigger, every Warden's question in it.
  expect(seen).toHaveLength(1);

  calls.length = 0;
  const report = await flow.postAction(
    oneCall({
      tool: 'Edit',
      input: { file_path: 'prisma/schema.prisma' },
    }),
  );
  expect(report.prefiltered).toEqual([
    { domain: 'voice', score: 0.05, skipBelow: 0.2 },
    { domain: 'schema', score: 0.15, skipBelow: 0.2 },
  ]);
  expect(report.domainsChecked).toEqual(['ship']);
  expect(calls).toEqual([{ domain: 'ship', phase: 'guard' }]);
});

test('a missing model fails open: every Warden is asked, and the warning fires once', async () => {
  const warnings: PrefilterHealth[] = [];
  const prefilter = new WardenPrefilter(
    { enabled: true },
    {
      fetch: down,
      onHealth: (health) => warnings.push(health),
    },
  );
  const { flow, calls } = roster(['voice', 'schema'], prefilter);

  const plan = await flow.preMessage('Add a column');
  expect(plan.contributions.map((c) => c.decision)).toEqual(['no-comment', 'no-comment']);
  expect(plan.prefilter).toMatchObject({ status: 'unavailable' });
  const report = await flow.postAction(oneCall({ tool: 'Edit', input: {} }));
  expect(report.domainsChecked).toEqual(['voice', 'schema']);
  expect(report.prefilter).toMatchObject({ status: 'unavailable' });
  expect(calls).toHaveLength(4);
  expect(warnings).toEqual([{ ok: false, reason: 'TypeSafe decision transport failed' }]);
  expect((await prefilter.check()).ok).toBe(false);
  expect(warnings).toHaveLength(1);
});

test('turned off, no pre-filter call is made and every Warden is asked', async () => {
  const { flow, calls } = roster(['voice', 'schema']);
  const plan = await flow.preMessage('Add a column');
  expect(plan.prefilter).toBeUndefined();
  expect(calls).toHaveLength(2);
});

test('the doctor reports off by default with no warning, and warns when turned on without a model', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'prefilter-models-'));
  cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
  const config = starterConfig('claude-code', 'fable');
  const which = () => '/usr/bin/true';
  const off = await inspectReadiness(config, { which, modelsDir: empty });
  expect(off.prefilter).toEqual({ status: 'off', url: DEFAULT_PREFILTER.baseUrl });
  expect(off.issues.map((i) => i.code).filter((code) => code.startsWith('prefilter'))).toEqual([]);
  const missing = await inspectReadiness(
    { ...config, prefilter: { enabled: true } },
    { which, modelsDir: empty },
  );
  expect(missing.prefilter?.status).toBe('not-installed');
  expect(missing.issues).toContainEqual(
    expect.objectContaining({ severity: 'warning', code: 'prefilter-not-installed' }),
  );
});

test('setup installs the model only when the home turns the pre-filter on', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prefilter-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  expect(await enabledPrefilter(home)).toBeUndefined();
  const store = new ConfigStore(join(home, '.foundry'));
  await store.save(starterConfig('claude-code', 'fable'));
  expect(await enabledPrefilter(home)).toBeUndefined();
  await store.save({ ...starterConfig('claude-code', 'fable'), prefilter: { enabled: true } });
  expect(await enabledPrefilter(home)).toEqual({ enabled: true });
});

test('a thread skips a ruled-out Warden at advice and at review, each journalled with its score', async () => {
  const phases: string[] = [];
  const config = starterConfig('mock', 'mock');
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'mock',
      model: 'mock',
      prompt: 'Work',
      temperature: 0,
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  const layer = new ContextLayer({ id: 'security', prompt: 'Security knowledge' });
  layer.set('Secrets never reach logs.');
  const stack = new ContextStack([layer]);
  const manager = new ThreadRuntimeManager({
    config,
    log() {},
    warn() {},
    domains: [{ domain: 'security', layerId: 'security', guardTriggers: [] }],
    prefilter: new WardenPrefilter(undefined, {
      fetch: async (url, init) => {
        if (url.endsWith('/health')) return Response.json({ status: 'ok' });
        const { questions } = JSON.parse(init.body as string) as { questions: object };
        const answers = Object.fromEntries(
          Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.02 }]),
        );
        return Response.json({
          model: 'kev-latest',
          answers,
          usage: { input_tokens: 1, output_tokens: 0 },
        });
      },
    }),
    llm: {
      id: 'flow',
      async complete(messages) {
        const all = messages.map((m) => String(m.content)).join('\n');
        phases.push(
          all.includes('Response protocol (post-work review)')
            ? 'review'
            : all.includes('Response protocol (advice')
              ? 'advice'
              : 'route',
        );
        return {
          model: 'flow',
          content: JSON.stringify({ layers: [], domains: [], confidence: 0 }),
        };
      },
    },
  });
  const factory = new ThreadFactory({
    stack,
    runtime: manager,
    agents: buildAgents(config, stack, {
      provider: { id: 'mock', complete: async () => ({ model: 'mock', content: 'done' }) },
    }),
  });
  const thread = factory.create('t', { projectId: 'P' });
  cleanups.push(() => manager.disposeAll());
  const result = await thread.dispatch('worker', 'Rename the sidebar label', undefined, {
    messageId: 'm1',
  });
  const plan = (
    result.meta?.injection as { plan?: { contributions: Array<Record<string, unknown>> } }
  )?.plan;
  expect(plan?.contributions).toEqual([
    expect.objectContaining({
      domain: 'security',
      decision: 'skipped',
      reason: 'prefilter',
      prefilter: { score: 0.02, skipBelow: DEFAULT_PREFILTER.skipBelow },
    }),
  ]);
  const runtime = manager.get('t')!;
  await runtime.learningSettled();
  const last = runtime.domainLibrarians.get('security')!.threadKnowledge.history.at(-1)!;
  expect(last.decision).toBe('prefiltered');
  expect(last.reason).toContain('0.020');
  expect(phases).not.toContain('advice');
  expect(phases).not.toContain('review');
});
