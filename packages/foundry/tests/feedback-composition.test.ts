// The point of the lifecycle: an applied rule reaches the routed Warden through the composition view,
// and that call is counted as its use.
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionQueue,
  type CompletionOpts,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { invalidateComposition } from '../src/agents/role-layers';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { FeedbackService } from '../src/feedback/service';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { type FoundryConfig, starterConfig, validateConfig } from '../src/viewer/config';
import { writeRegions } from './helpers/regions';

const RULE = 'When a change is green on the agentic side, merge it yourself.';
const dirs: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function config(project: string): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: 'WORKER',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  // The project's one Warden is its region `conventions`; settings declare none.
  writeRegions(project, [
    { id: 'conventions', knowledge: 'CONVENTIONS_KNOWLEDGE: scripts live in package.json.' },
  ]);
  c.layers = {};
  c.composition = {
    preset: 'none',
    nodes: {
      local: {
        scope: 'project',
        personal: true,
        // Slotted, as the default preset's role files are: a region Warden takes no general files.
        sources: [
          {
            walk: [
              {
                path: '.foundry/roles/{role}/{slot}.local.md',
                when: { slots: ['instructions', 'domainKnowledge'] },
              },
            ],
          },
        ],
      },
    },
  };
  c.projects.P = { id: 'P', path: project };
  validateConfig(c);
  return c;
}

test('an applied rule is in the routed Warden’s composed instructions on the next turn, and counts as a use', async () => {
  const project = await mkdtemp(join(tmpdir(), 'feedback-composition-'));
  const home = await mkdtemp(join(tmpdir(), 'feedback-home-'));
  dirs.push(project, home);
  const c = config(project);
  const calls: Array<{ phase: string; messages: LLMMessage[] }> = [];
  const provider = (id: string): LLMProvider => ({
    id,
    async complete(messages: LLMMessage[], opts: CompletionOpts = {}) {
      const phase = opts.threadId?.endsWith(':cartographer')
        ? 'route'
        : opts.threadId?.includes(':aux:')
          ? 'pre'
          : opts.threadId?.includes(':review:')
            ? 'post'
            : 'central';
      calls.push({ phase, messages: structuredClone(messages) });
      return {
        model: 'controlled',
        content:
          phase === 'central'
            ? 'done'
            : phase === 'route'
              ? JSON.stringify({ layers: [], domains: ['conventions'], confidence: 0.9 })
              : 'NO_COMMENT',
      };
    },
  });
  const central = provider('central'),
    flow = provider('flow');
  const providers = new Map([central, flow].map((p) => [p.id, p]));
  const sourceResolver: SourceResolver = (id, cfg) => {
    const source = cfg.sources[id];
    if (!source) return null;
    return {
      id,
      load: async () => (source.type === 'markdown' ? Bun.file(source.uri).text() : source.uri),
    };
  };
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({
    config: c,
    resolveSource: sourceResolver,
    llm: flow,
    providers,
    log() {},
    warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
  });
  const store = new LocalSessionStore(join(project, '.journal.sqlite'));
  cleanup.push(() => store.close());
  cleanup.push(
    manager.setPhaseJournal((runtime, record) => store.appendPhase(runtime.thread, record)),
  );
  cleanup.push(() => manager.disposeAll());
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  const thread = factory.create('p-thread', { projectId: 'P', cwd: project });
  const queue = new ActionQueue();
  const service = new FeedbackService({
    store,
    config: () => c,
    queue,
    thread: (id) => (id === thread.id ? thread : undefined),
    cartographer: (id) => manager.get(id)?.cartographer,
    classify: async () => ({
      isCorrection: true,
      category: 'convention',
      statements: [RULE],
      sharp: true,
      requestHash: 'h',
      providerId: 'fake',
    }),
    match: async () => ({ match: null, requestHash: 'm', providerId: 'fake' }),
    invalidate: () => invalidateComposition(),
    roots: () => ({ home, project }),
  });

  await thread.dispatch('worker', 'First turn');
  const [item] = await service.intervention(thread, 'Merge it yourself once green.');
  expect(item?.route).toMatchObject({ roles: ['conventions'], level: 'project-personal' });
  const prompt = queue.pending()[0]!;
  service.submit(item!.id, 'apply');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(queue.get(prompt.id)?.status).not.toBe('pending');
  expect(service.lifecycle.get(item!.id)?.status).toBe('applied');

  await thread.dispatch('worker', 'Second turn');
  const advice = calls.filter((call) => call.phase === 'pre').at(-1)!;
  expect(advice.messages[0]!.content).toContain(`${RULE} (${item!.id})`);
  expect(service.uses(item!.id)).toMatchObject([{ phase: 'advice', roles: ['conventions'] }]);
});
