import { expect, test } from 'bun:test';
import { ContextStack, Harness, type LLMProvider } from '@inixiative/foundry-core';
import { regionRoleId } from '../src/agents/region-roster';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { FOLLOWUP_QUESTION } from '../src/classify';
import { DECISION_LATENCY_BUDGET } from '../src/providers/decision-budget';
import { type AgentSettingsConfig, type FoundryConfig, starterConfig } from '../src/viewer/config';

const DOMAINS = ['api', 'db', 'ui', 'auth', 'security', 'testing'];
/** A Warden's id is a namespaced role id, as a generated region Warden's is. */
const wardenId = (domain: string) => regionRoleId(`${domain}-warden`);
const warden = (domain: string): AgentSettingsConfig => ({
  id: wardenId(domain),
  kind: 'warden',
  domain,
  prompt: `Advise on ${domain}.`,
  provider: 'decisions',
  model: 'luna',
  tools: false,
  domainKnowledge: [`${domain}-source`],
  enabled: true,
});

/** Six Wardens on one decision provider; a central worker. */
function config(): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: '',
      provider: 'central',
      model: 'central-model',
      enabled: true,
    },
    ...Object.fromEntries(DOMAINS.map((d) => [wardenId(d), warden(d)])),
  };
  c.layers = Object.fromEntries(
    DOMAINS.map((d) => [
      `${d}-reference`,
      {
        id: `${d}-reference`,
        domain: d,
        segment: 'domain-knowledge',
        prompt: `${d} context`,
        sourceIds: [`${d}-source`],
        writers: [wardenId(d)],
        staleness: 0,
        enabled: true,
      },
    ]),
  );
  c.sources = Object.fromEntries(
    DOMAINS.map((d) => [
      `${d}-source`,
      {
        id: `${d}-source`,
        label: d,
        type: 'inline',
        uri: `${d.toUpperCase()}: owned knowledge`,
        enabled: true,
      },
    ]),
  );
  return c;
}

/** Every decision takes `delayMs`; records how many run at once and when the worker is first called. */
function providers(delayMs: number) {
  let live = 0,
    peak = 0,
    calls = 0,
    workerStartedAt = 0;
  const decisions: LLMProvider = {
    id: 'decisions',
    async complete(messages, opts = {}) {
      const id = opts.threadId ?? '';
      // Post-turn learning review runs after the worker; only pre-message decisions are measured.
      // A Warden's debug reason is asked after its decision is journalled, off the measured path.
      if (messages.at(-1)?.content === FOLLOWUP_QUESTION)
        return { content: 'It is outside the domain.\nREVISED: KEEP', model: 'luna' };
      if (id.includes(':aux:review:'))
        return {
          content: 'NO_COMMENT',
          model: 'luna',
        };
      calls++;
      live++;
      peak = Math.max(peak, live);
      await Bun.sleep(delayMs);
      live--;
      void messages;
      return { content: 'NO_COMMENT', model: 'luna' };
    },
  };
  const central: LLMProvider = {
    id: 'central',
    async complete() {
      workerStartedAt ||= performance.now();
      return { content: 'done', model: 'central-model' };
    },
  };
  return {
    decisions,
    central,
    get peak() {
      return peak;
    },
    get calls() {
      return calls;
    },
    get workerStartedAt() {
      return workerStartedAt;
    },
  };
}

test('the pre-message phase is one concurrent round: message to worker start costs about one decision', async () => {
  const delayMs = 150;
  const c = config(),
    p = providers(delayMs);
  const sourceResolver: SourceResolver = (id, cfg) =>
    cfg.sources[id] ? { id, load: async () => cfg.sources[id].uri } : null;
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const map = new Map<string, LLMProvider>([
    [p.decisions.id, p.decisions],
    [p.central.id, p.central],
  ]);
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: p.decisions,
    providers: map,
    log() {},
    warn() {},
  });
  const deps = { provider: p.central, providers: map };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  const thread = factory.create('lead', { cwd: '/tmp' });
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  try {
    for (const layer of stack.layers) await layer.warm?.();
    const started = performance.now();
    const result = await harness.send({ id: 'm1', payload: 'Add a login endpoint' });
    const toWorker = p.workerStartedAt - started;
    expect(result.result.output).toBe('done');
    // six Wardens, all at once
    expect(p.calls).toBe(6);
    expect(p.peak).toBe(6);
    // One round of decisions, within the structural budget.
    expect(toWorker).toBeLessThan(
      delayMs * DECISION_LATENCY_BUDGET.messageToWorkerInDecisionRounds,
    );
    expect(toWorker).toBeGreaterThanOrEqual(delayMs);
    console.log(
      JSON.stringify({
        decisionMs: delayMs,
        messageToWorkerMs: Math.round(toWorker),
        concurrentDecisions: p.peak,
      }),
    );
  } finally {
    manager.disposeAll();
  }
});
