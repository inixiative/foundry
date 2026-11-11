import { afterEach, expect, test } from 'bun:test';
import {
  ContextLayer,
  ContextStack,
  EventStream,
  Harness,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { chorusRetries } from '../src/agents/chorus-degraded';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { KnowledgePersistence } from '../src/persistence/knowledge-persistence';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { serializeTrace } from '../src/persistence/trace-record';
import { type FoundryConfig, starterConfig } from '../src/viewer/config';

// FEAT-008: a Warden that failed on a turn is recorded as degraded, the thread's message index shows it,
// and Retry asks only it again on the same moment: an advice chime rides with the next turn ("asked
// again"), a guard retry is a guard-outcome row. Real runtime, factory, orchestrator, Warden and journal;
// controlled providers only.

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
const GUARD = '## Response protocol (guard phase';
const BRIEF = 'trigger: subagent-spawn)';
const ADVICE = 'trigger: user-message)';
async function until(predicate: () => boolean, label: string, ms = 2000) {
  const end = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > end) throw Error(`deadline: ${label}`);
    await Bun.sleep(2);
  }
}

interface Call {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
}

function fixture(opts: { guard?: FoundryConfig['guard']; brief?: string } = {}) {
  // Calls that fail while set: the advice on a message, the guard over a turn.
  const failing = { advice: false, guard: false };
  const config = starterConfig('controlled', 'controlled');
  if (opts.guard) config.guard = opts.guard;
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'controlled',
      model: 'controlled',
      prompt: '',
      temperature: 0,
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  const layer = new ContextLayer({ id: 'architecture', segment: 'domain-knowledge' });
  layer.set('Snapshots are column-only: use pickColumns.');
  const stack = new ContextStack([layer]);
  const events = new EventStream();
  const aux: LLMMessage[][] = [];
  const guardCalls: LLMMessage[][] = [];
  const briefCalls: LLMMessage[][] = [];
  const adviceCalls: LLMMessage[][] = [];
  const auxiliary: LLMProvider = {
    id: 'controlled-aux',
    async complete(messages) {
      aux.push(structuredClone(messages));
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes(GUARD)) {
        guardCalls.push(structuredClone(messages));
        if (failing.guard) throw Error('guard provider down');
        return { model: 'controlled', content: 'NO_COMMENT' };
      }
      if (text.includes(BRIEF)) {
        briefCalls.push(structuredClone(messages));
        return {
          model: 'controlled',
          content:
            opts.brief ??
            '{"layers":[],"snippets":["Snapshots are column-only: use pickColumns (fb_7)."],"confidence":0.9}',
        };
      }
      if (text.includes(ADVICE)) {
        adviceCalls.push(structuredClone(messages));
        if (failing.advice) throw Error('advice provider down');
        return {
          model: 'controlled',
          content:
            '{"layers":[],"snippets":["Snapshots are column-only: use pickColumns (fb_7)."],"confidence":0.9}',
        };
      }
      if (text.includes('## Message to route'))
        return {
          model: 'controlled',
          content: '{"domains":["architecture"],"layers":["architecture"],"confidence":1}',
        };
      return { model: 'controlled', content: 'NO_COMMENT' };
    },
  };
  const manager = new ThreadRuntimeManager({
    config,
    log() {},
    warn() {},
    eventStream: events,
    domains: [
      {
        domain: 'architecture',
        layerId: 'architecture',
        guardTriggers: ['Write', 'Edit', 'Bash'],
        guardPrompt: 'CUSTOM_GUARD: storage only.',
      },
    ],
    learning: { enabled: false },
    llm: auxiliary,
  });
  const central: string[] = [];
  const factory = new ThreadFactory({
    stack,
    runtime: manager,
    agents: buildAgents(config, stack, {
      provider: {
        id: 'central',
        async complete(messages) {
          central.push(messages.find((m) => m.role === 'user')?.content ?? '');
          return { model: 'central', content: 'COMPLETED' };
        },
      },
    }),
  });
  const store = new LocalSessionStore(':memory:');
  new KnowledgePersistence(manager, store, events, []);
  const thread = factory.create('per-turn', { projectId: 'P' });
  const runtime = manager.get(thread.id)!;
  closes.push(() => {
    manager.disposeAll();
    store.close();
  });
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  let tools = 0;
  // The executor's tool calls of a turn, observed on the live dispatch as the native projector emits them.
  let script: Call[] = [];
  thread.middleware.use('test-tool-observations', async (ctx, next) => {
    for (const call of script) {
      tools++;
      void thread.signals.emit({
        id: `sig-tool-${tools}`,
        kind: 'tool_observation',
        source: `thread:${thread.id}`,
        timestamp: Date.now(),
        content: {
          threadId: thread.id,
          dispatchId: ctx.dispatchId,
          agentId: 'worker',
          tool: call.tool,
          callId: `call-${tools}`,
          // The native projector hands bounded JSON, not the object: the guard reads it as the input.
          inputSummary: JSON.stringify(call.input),
          ...(call.output !== undefined ? { outputSummary: call.output } : {}),
          ok: true,
        },
      });
    }
    return next();
  });
  const turn = async (turnId: string, message: string, calls: Call[] = []) => {
    script = calls;
    store.beginTurn(thread, turnId, message);
    const sent = await harness.send({ id: turnId, payload: message });
    store.completeTurn(
      thread,
      turnId,
      String(sent.result.output ?? ''),
      { ...(sent.result.meta ?? {}) },
      serializeTrace(sent.trace),
    );
    return sent;
  };
  const rows = (turnId?: string, nodeId = thread.id) =>
    store
      .phaseHistory(nodeId, turnId ? { turnId } : undefined)
      .filter((r) => r.phase !== 'middleware-reduced');
  return {
    manager,
    thread,
    runtime,
    store,
    failing,
    adviceCalls,
    guardCalls,
    central,
    turn,
    rows,
  };
}

test('a failed Warden on the message is degraded, shown on the turn, and Retry asks it again for the next turn', async () => {
  const f = fixture();
  f.failing.advice = true;
  await f.turn('turn-1', 'Snapshot the audit rows');
  const sealed = f.rows('turn-1').find((r) => r.phase === 'advice')!;
  expect(sealed.record).toMatchObject({
    trigger: 'user-message',
    moment: 'Snapshot the audit rows',
    participants: [{ domain: 'architecture', decision: 'error' }],
    degraded: [{ domain: 'architecture', kind: 'error', layer: 1, silent: true }],
  });
  // Silence is unchanged: the turn went on without it and nothing it would have said reached the session.
  expect(f.central.at(-1)).not.toContain('chimed in');
  // The thread's message index carries the turn's open notice on the agent row.
  const agent = f.store.messageIndex(f.thread.id).messages.find((m) => m.actor === 'agent')!;
  expect(agent.chorus).toMatchObject({
    open: [sealed.id],
    notices: [{ rowId: sealed.id, trigger: 'user-message', retriedBy: null }],
  });

  f.failing.advice = false;
  const detail = f.store.turnDetail(f.thread.id, 'turn-1')!;
  const { retries } = chorusRetries({
    turnId: 'turn-1',
    phases: detail.phases,
    nativeHistory: detail.nativeHistory,
  });
  expect(retries).toEqual([
    {
      kind: 'advice',
      of: sealed.id,
      turnId: 'turn-1',
      trigger: 'user-message',
      moment: 'Snapshot the audit rows',
      domains: ['architecture'],
    },
  ]);
  const asked = f.adviceCalls.length;
  const run = f.runtime.retryChorus(retries[0]!)!;
  // A second Retry on the same row while the first runs is refused.
  expect(f.runtime.retryChorus(retries[0]!)).toBeNull();
  await run;
  expect(f.adviceCalls.length).toBe(asked + 1);
  expect(
    f.adviceCalls
      .at(-1)!
      .map((m) => m.content)
      .join('\n'),
  ).toContain('Snapshot the audit rows');
  const retry = f.rows('turn-1').find((r) => r.phase === 'advice' && r.record.retryOf)!;
  expect(retry.record).toMatchObject({
    trigger: 'user-message',
    retryOf: sealed.id,
    participants: [{ domain: 'architecture', decision: 'contribute' }],
  });
  expect(retry.record.degraded).toBeUndefined();
  // The notice is resolved: the row was asked again and answered.
  const after = f.store.messageIndex(f.thread.id).messages.find((m) => m.actor === 'agent')!;
  expect(after.chorus).toMatchObject({ open: [], notices: [{ retriedBy: retry.id }] });
  // The chime rides with the next turn, like a handoff brief.
  const notes = f.runtime.flowOrchestrator.pendingNotes;
  expect(notes).toHaveLength(1);
  expect(notes[0]!.text).toBe(
    'The architecture Warden chimed in on your earlier message (asked again):\n- Snapshots are column-only: use pickColumns (fb_7).',
  );
  await f.turn('turn-2', 'Carry on');
  expect(f.central.at(-1)).toContain(
    'The architecture Warden chimed in on your earlier message (asked again):',
  );
});

test('a failed guard is degraded; Retry guards the same calls with only the failed Warden', async () => {
  const f = fixture();
  f.failing.guard = true;
  await f.turn('turn-1', 'Edit the schema', [
    { tool: 'Edit', input: { file_path: 'schema.prisma', old_string: 'a', new_string: 'b' } },
  ]);
  await until(() => f.rows('turn-1').some((r) => r.phase === 'guard-outcome'), 'guard outcome');
  const outcome = f.rows('turn-1').find((r) => r.phase === 'guard-outcome')!;
  expect(outcome.record).toMatchObject({
    failed: ['architecture'],
    degraded: [{ domain: 'architecture', kind: 'error', layer: 1, silent: true }],
  });
  f.failing.guard = false;
  await f.runtime.retryChorus({
    kind: 'guard',
    of: outcome.id,
    turnId: 'turn-1',
    observations: [
      { tool: 'Edit', input: { file_path: 'schema.prisma' }, callId: 'call-1', ok: true },
    ],
    domains: ['architecture'],
  });
  const retried = f.rows('turn-1').filter((r) => r.phase === 'guard-outcome')[1]!;
  expect(retried.record).toMatchObject({
    retryOf: outcome.id,
    correlation: 'retry',
    status: 'reported',
    domainsChecked: ['architecture'],
    failed: [],
  });
  expect(retried.record.degraded).toBeUndefined();
});

test('a dismissed notice is no longer open', async () => {
  const f = fixture();
  f.failing.advice = true;
  await f.turn('turn-1', 'Snapshot the audit rows');
  const sealed = f.rows('turn-1').find((r) => r.phase === 'advice')!;
  f.store.appendPhase(f.thread, {
    id: 'phase-dismiss',
    turnId: 'turn-1',
    dispatchId: null,
    phase: 'chorus-dismiss',
    record: { of: [sealed.id] },
  });
  const agent = f.store.messageIndex(f.thread.id).messages.find((m) => m.actor === 'agent')!;
  expect(agent.chorus).toMatchObject({ open: [], notices: [{ rowId: sealed.id }] });
});
