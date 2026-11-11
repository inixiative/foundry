// Live multi-stage: a project chorus's region Wardens run its configured stages inside a real thread.
// Each later stage has its own session and, when it names a model, its own decision host; a stage
// that outlives its share of the advise deadline leaves the previous stage's outcome, journalled.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CompletionOpts,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { FileMemory } from '../../core/src/adapters/file-memory';
import {
  buildAgents,
  buildLayers,
  createSourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import {
  charterFor,
  DEFAULT_STAGES,
  LAYER_2_MODEL,
  RECOGNISE_CHARTER,
  type StageEffort,
  validateStages,
  WARDEN_CHARTER,
} from '../src/classify';
import { isStageSession, projectHostTarget } from '../src/providers/primed-decisions';
import { type FoundryConfig, starterConfig } from '../src/viewer/config';

const dirs: string[] = [];
const managers: ThreadRuntimeManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const runtime of manager.runtimes.values()) await runtime.learningSettled();
    manager.disposeAll();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `foundry-${name}-`)));
  dirs.push(d);
  return d;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const POINTER = 'Look over here: createLock (CONCURRENCY.md § Distributed Lock) — exclusion.';

/** A project with two regions; `stages` undefined writes none, so the chorus runs the default chain. */
function project(stages: unknown[] | undefined) {
  const path = temp('classify-live');
  write(
    join(path, '.foundry', 'project.json'),
    JSON.stringify({ chorus: { enabled: true, ...(stages ? { wardens: { stages } } : {}) } }),
  );
  for (const id of ['locks', 'queues']) {
    const at = join(path, '.foundry', 'regions', id);
    write(join(at, 'region.json'), JSON.stringify({ id, title: id, routing: `Is this ${id}?` }));
    write(join(at, 'knowledge.md'), `# ${id}\n\nCATALOGUE_${id.toUpperCase()}: createLock.`);
    write(join(at, 'recognise.md'), `# ${id}\n\nSHORT_${id.toUpperCase()}: what ${id} covers.`);
  }
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: '',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  c.layers = {};
  c.sources = {};
  c.composition = { preset: 'none' };
  c.projects.P = { id: 'P', path };
  // Subscription decisions, as live: stage hosts are the test's `stageHost`.
  delete c.apiTokens;
  return c;
}

interface Call {
  host: string;
  messages: LLMMessage[];
  opts: CompletionOpts;
}

function runtime(
  c: FoundryConfig,
  answer: (host: string, call: Call) => string | Promise<string>,
  options: {
    hosts?: readonly string[];
    flow?: { adviseTimeoutMs?: number };
  } = {},
) {
  const calls: Call[] = [];
  const provider = (id: string): LLMProvider => ({
    id,
    async complete(messages, opts = {}) {
      const call = { host: id, messages: structuredClone(messages), opts: { ...opts } };
      calls.push(call);
      const route = opts.threadId?.endsWith(':cartographer');
      return {
        model: id,
        content: route
          ? JSON.stringify({ layers: [], domains: [], confidence: 1 })
          : opts.threadId?.includes(':aux:')
            ? await answer(id, call)
            : 'done',
      };
    },
  });
  const central = provider('central');
  const flow = provider('flow');
  // One stub host per model and effort, its id the model it serves.
  const hosts = new Map((options.hosts ?? []).map((key) => [key, provider(key.split('|')[0]!)]));
  const providers = new Map([central, flow].map((p) => [p.id, p]));
  const sourceResolver = createSourceResolver({
    memory: new FileMemory(join(temp('memory'), 'm')),
  });
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: flow,
    providers,
    resolveSource: sourceResolver,
    stageHost: (model: string | undefined, effort: StageEffort | undefined) =>
      model || effort ? hosts.get(`${model ?? ''}|${effort ?? ''}`) : undefined,
    ...(options.flow ? { flow: options.flow } : {}),
    log() {},
    warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
  });
  managers.push(manager);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  return { factory, manager, calls };
}

const contributionsOf = (result: { meta?: Record<string, unknown> }) =>
  (
    result.meta?.injection as {
      plan?: {
        contributions: Array<{
          domain: string;
          decision: string;
          snippets: string[];
          classified?: {
            outcome?: string;
            fallback?: string;
            delivered: boolean;
            stages: unknown[];
          };
          stageRequests?: Array<{ status: string; stage?: number; providerId?: string }>;
        }>;
      };
    }
  )?.plan?.contributions ?? [];

const RECOGNISE = {
  task: 'recognise',
  doc: 'recognise.md',
  outcomes: 'ternary',
  escalate: ['yes', 'unsure'],
};

test('each region Warden runs its stages: stage 1 on its own provider, stage 2 on its stage host and session', async () => {
  const c = project([RECOGNISE, { model: 'claude-sonnet-5-5', effort: 'low' }]);
  const f = runtime(
    c,
    (host, call) => {
      const body = call.messages[1]!.content;
      if (host === 'central')
        return body.includes('SHORT_LOCKS')
          ? JSON.stringify({
              snippets: ['locks: UNSURE — a job that may overlap'],
              layers: [],
              confidence: 0.5,
            })
          : 'NO_COMMENT';
      return JSON.stringify({ snippets: [POINTER], layers: [], confidence: 0.8 });
    },
    { hosts: ['claude-sonnet-5-5|low'] },
  );
  const thread = f.factory.create('staged', { projectId: 'P' });
  const result = await thread.dispatch('worker', 'Add a nightly job that never overlaps.');

  const first = f.calls.filter(
    (c) => c.host === 'central' && c.opts.threadId?.includes(':aux:domain:'),
  );
  expect(first.map((c) => c.opts.threadId!.split(':aux:')[1]).sort()).toEqual([
    'domain:locks',
    'domain:queues',
  ]);
  // A ternary recogniser: the recognise charter with its mode's unsure section composed in.
  const ternary = charterFor(
    'recognise',
    'warden',
    undefined,
    validateStages('s', [RECOGNISE, {}])[0]!,
  );
  expect(ternary.text).not.toBe(RECOGNISE_CHARTER);
  expect(first.every((c) => c.messages[0]!.content.startsWith(ternary.text))).toBe(true);
  expect(first.every((c) => !c.messages[1]!.content.includes('CATALOGUE_'))).toBe(true);
  const second = f.calls.filter((c) => c.host === 'claude-sonnet-5-5');
  expect(second).toHaveLength(1);
  expect(second[0]!.opts.threadId).toEndWith(':aux:domain:locks:stage:1');
  expect(second[0]!.opts.model).toBe('claude-sonnet-5-5');
  expect(second[0]!.messages[0]!.content.startsWith(WARDEN_CHARTER)).toBe(true);
  expect(second[0]!.messages[1]!.content).toContain('CATALOGUE_LOCKS');
  expect(second[0]!.messages[1]!.content).toContain(
    'was unsure this moment is in your region: a job that may overlap',
  );
  // The later stage's session is the Warden's own, listed with the thread's auxiliaries.
  expect(f.manager.get(thread.id)!.auxiliarySessionIds).toContain(
    `${thread.id}:aux:domain:locks:stage:1`,
  );

  const contributions = contributionsOf(result);
  const locks = contributions.find((c) => c.domain === 'locks')!;
  expect(locks).toMatchObject({
    decision: 'contribute',
    snippets: [POINTER],
    classified: {
      outcome: 'yes',
      delivered: true,
      stages: [
        { stage: 0, task: 'recognise', doc: 'recognise.md', outcome: 'unsure' },
        {
          stage: 1,
          task: 'point',
          doc: 'knowledge.md',
          outcome: 'yes',
          model: 'claude-sonnet-5-5',
        },
      ],
    },
    stageRequests: [{ status: 'supplied', stage: 1, providerId: 'claude-sonnet-5-5' }],
  });
  expect(contributions.find((c) => c.domain === 'queues')).toMatchObject({
    decision: 'no-comment',
    classified: { outcome: 'no', delivered: false },
  });
});

test('a project that writes no stages runs the default chain: Layer 1 points with its why, each yes goes to Sonnet without it', async () => {
  const f = runtime(
    project(undefined),
    (host, call) => {
      const body = call.messages[1]!.content;
      if (host === 'central')
        return body.includes('CATALOGUE_LOCKS')
          ? JSON.stringify({
              outcome: 'yes',
              why: 'HAIKU_WHY a nightly job that must not overlap',
              snippets: [POINTER],
              layers: [],
              confidence: 0.7,
            })
          : JSON.stringify({ outcome: 'no', why: 'not a queue', snippets: [], layers: [] });
      return JSON.stringify({ snippets: [POINTER], layers: [], confidence: 0.8 });
    },
    { hosts: [`${LAYER_2_MODEL}|low`] },
  );
  const thread = f.factory.create('default-chain', { projectId: 'P' });
  const result = await thread.dispatch('worker', 'Add a nightly job that never overlaps.');

  // Layer 1 asks every region on the decision provider; Layer 2 runs only on the yes, on its host.
  const first = f.calls.filter(
    (c) => c.host === 'central' && c.opts.threadId?.includes(':aux:domain:'),
  );
  expect(first.map((c) => c.opts.threadId!.split(':aux:')[1]).sort()).toEqual([
    'domain:locks',
    'domain:queues',
  ]);
  const second = f.calls.filter((c) => c.host === LAYER_2_MODEL);
  expect(second).toHaveLength(1);
  expect(second[0]!.opts.threadId).toEndWith(':aux:domain:locks:stage:1');
  expect(second[0]!.opts.model).toBe(LAYER_2_MODEL);
  expect(second[0]!.messages[1]!.content).toContain('CATALOGUE_LOCKS');
  // carryWhy false: Sonnet judges the moment without Haiku's argument.
  expect(second[0]!.messages[1]!.content).not.toContain('HAIKU_WHY');

  const contributions = contributionsOf(result);
  expect(contributions.find((c) => c.domain === 'locks')).toMatchObject({
    decision: 'contribute',
    snippets: [POINTER],
    classified: {
      outcome: 'yes',
      delivered: true,
      stages: [
        { stage: 0, task: 'point', outcome: 'yes' },
        { stage: 1, task: 'point', outcome: 'yes', model: LAYER_2_MODEL },
      ],
    },
  });
  expect(contributions.find((c) => c.domain === 'queues')).toMatchObject({
    decision: 'no-comment',
    classified: { outcome: 'no', delivered: false },
  });
  expect(f.manager.get(thread.id)!.domainLibrarians.get('locks')!.stageCount).toBe(
    DEFAULT_STAGES.length,
  );
});

test('a project that writes its own stages wins over the default chain', async () => {
  const f = runtime(project([{}]), () => 'NO_COMMENT', { hosts: [`${LAYER_2_MODEL}|low`] });
  const thread = f.factory.create('own-stages', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a lock.');
  expect(f.manager.get(thread.id)!.domainLibrarians.get('locks')!.stageCount).toBe(1);
  expect(f.calls.filter((c) => c.host === LAYER_2_MODEL)).toHaveLength(0);
});

test('without stage hosts (API-token decisions) the default is the single stage, so the chorus still runs', async () => {
  const c = project(undefined);
  const calls: string[] = [];
  const provider = (id: string): LLMProvider => ({
    id,
    async complete(_messages, opts = {}) {
      calls.push(opts.threadId ?? '');
      return {
        model: id,
        content: opts.threadId?.endsWith(':cartographer')
          ? JSON.stringify({ layers: [], domains: [], confidence: 1 })
          : opts.threadId?.includes(':aux:')
            ? 'NO_COMMENT'
            : 'done',
      };
    },
  });
  const central = provider('central');
  const flow = provider('flow');
  const providers = new Map([central, flow].map((p) => [p.id, p]));
  const sourceResolver = createSourceResolver({
    memory: new FileMemory(join(temp('memory'), 'm')),
  });
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: flow,
    providers,
    resolveSource: sourceResolver,
    log() {},
    warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
  });
  managers.push(manager);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  const thread = factory.create('no-hosts', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a lock.');
  expect(manager.get(thread.id)!.domainLibrarians.get('locks')!.stageCount).toBe(1);
  expect(calls.some((id) => id.endsWith(':aux:domain:locks'))).toBe(true);
  expect(calls.some((id) => id.includes(':stage:'))).toBe(false);
});

test('a later stage that outlives its share of the advise deadline keeps the previous outcome, journalled', async () => {
  const c = project([
    { escalate: ['yes'], deadline: 0.5 },
    { model: 'claude-sonnet-5-5', effort: 'low', deadline: 0.5 },
  ]);
  const f = runtime(
    c,
    async (host, call) => {
      if (host === 'central')
        return call.messages[1]!.content.includes('CATALOGUE_LOCKS')
          ? JSON.stringify({ snippets: [POINTER], layers: [], confidence: 0.9 })
          : 'NO_COMMENT';
      await Bun.sleep(2_000);
      return 'NO_COMMENT';
    },
    { hosts: ['claude-sonnet-5-5|low'], flow: { adviseTimeoutMs: 400 } },
  );
  const thread = f.factory.create('timeout', { projectId: 'P' });
  const started = Date.now();
  const result = await thread.dispatch('worker', 'Add a lock.');
  expect(Date.now() - started).toBeLessThan(1_500);
  const locks = contributionsOf(result).find((c) => c.domain === 'locks')!;
  // Stage 1 pointed: its pointer stands and reaches the thread; the timeout is on the record.
  expect(locks).toMatchObject({
    decision: 'contribute',
    snippets: [POINTER],
    classified: {
      outcome: 'yes',
      fallback: 'timeout',
      delivered: true,
      stages: [
        { stage: 0, outcome: 'yes' },
        { stage: 1, timedOut: true },
      ],
    },
  });
  const stage2 = f.calls.find((c) => c.host === 'claude-sonnet-5-5')!;
  // The last stage gets what the run has left of the 400 ms, less the margin.
  expect(stage2.opts.timeout).toBeLessThanOrEqual(400);
});

test('a stage naming a model no host serves is refused by name; the default stage needs none', () => {
  const c = project([{ escalate: ['yes'] }, { model: 'claude-sonnet-5-5' }]);
  const f = runtime(c, () => 'NO_COMMENT');
  expect(() => f.factory.create('unserved', { projectId: 'P' })).toThrow(
    'chorus.wardens.stages[1] names claude-sonnet-5-5, and no decision host serves it (stage models run on subscription decisions)',
  );
  const plain = runtime(project([{}]), () => 'NO_COMMENT');
  expect(plain.factory.create('plain', { projectId: 'P' })).toBeDefined();
});

test('a later stage is its own primed session, never held in a project host', () => {
  expect(isStageSession('T:aux:domain:locks:stage:1')).toBe(true);
  expect(isStageSession('T:aux:domain:locks')).toBe(false);
  expect(isStageSession('T:aux:review:g1:domain:locks')).toBe(false);
  const serving = { serving: () => ({}) } as unknown as Parameters<typeof projectHostTarget>[0];
  expect(projectHostTarget(serving, 'T:aux:domain:locks')).toBeDefined();
  expect(projectHostTarget(serving, 'T:aux:domain:locks:stage:1')).toBeUndefined();
});
