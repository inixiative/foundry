import { afterEach, expect, test } from 'bun:test';
import {
  ContextLayer,
  ContextStack,
  EventStream,
  Harness,
  type LLMMessage,
  type LLMProvider,
  type NativeEvidence,
  type ThreadMeta,
} from '@inixiative/foundry-core';
import { oneCall, renderTurnActivity } from '../src/agents/domain-librarian';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { reduceMiddleware } from '../src/archives/reduced-middleware';
import { KnowledgePersistence } from '../src/persistence/knowledge-persistence';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { serializeTrace } from '../src/persistence/trace-record';
import { SubagentRecorder, type SubagentSpawn, type SubagentTurnEnd } from '../src/turns/subagents';
import { type FoundryConfig, starterConfig, validateConfig } from '../src/viewer/config';

// One guard per turn (Aron, 2026-10-15): the Wardens are asked once over the turn's tool activity in
// call order, when the turn's tool activity ends, not once per tool call; `guard: "per-call"` restores
// the old shape. A handoff to a subagent (`task_started`) is its own trigger: the chorus briefs it, the
// brief is journalled on the parent and rides with the parent's next turn. Real runtime, factory,
// Harness, orchestrator, Warden and journal; controlled providers only.

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
const GUARD = '## Response protocol (guard phase';
const BRIEF = 'trigger: subagent-spawn)';
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
  const config = starterConfig('controlled', 'controlled');
  if (opts.guard) config.guard = opts.guard;
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'controlled',
      model: 'controlled',
      prompt: 'Work',
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
  const auxiliary: LLMProvider = {
    id: 'controlled-aux',
    async complete(messages) {
      aux.push(structuredClone(messages));
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes(GUARD)) {
        guardCalls.push(structuredClone(messages));
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
    const sent = await harness.send({ id: turnId, payload: message, timestamp: Date.now() } as any);
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
  return { manager, thread, runtime, store, aux, guardCalls, briefCalls, central, turn, rows };
}

test('per-turn: the chorus is asked once, when the turn ends, over every guardable call in order; reads never enter the moment', async () => {
  const f = fixture();
  const sent = await f.turn('turn-1', 'Add preferred names', [
    { tool: 'Read', input: { file_path: 'contacts.ts' } },
    { tool: 'Write', input: { file_path: 'contacts.ts' }, output: 'written' },
    { tool: 'Edit', input: { file_path: 'schema.prisma', old_string: 'a', new_string: 'b' } },
    { tool: 'Bash', input: { command: 'bun test' }, output: 'ok' },
  ]);
  await until(() => f.rows('turn-1').some((r) => r.phase === 'guard-outcome'), 'guard outcome');
  // One moment: one request per asked Warden, one outcome wrapping the turn.
  expect(f.guardCalls).toHaveLength(1);
  const phases = f.rows('turn-1').map((r) => r.phase);
  expect(phases.filter((p) => p === 'guard-request')).toHaveLength(1);
  expect(phases.filter((p) => p === 'guard-outcome')).toHaveLength(1);
  const outcome = f.rows('turn-1').find((r) => r.phase === 'guard-outcome')!;
  expect(outcome.record).toMatchObject({
    trigger: 'agent-action',
    mode: 'per-turn',
    wraps: 'turn:turn-1',
    correlation: 'live-dispatch',
    status: 'reported',
    domainsChecked: ['architecture'],
    observation: { tool: 'Write, Edit, Bash', calls: 3, agentId: 'worker', turnId: 'turn-1' },
    activity: {
      turnId: 'turn-1',
      calls: [
        { tool: 'Write', callId: 'call-2', ok: true },
        { tool: 'Edit', callId: 'call-3', ok: true },
        { tool: 'Bash', callId: 'call-4', ok: true },
      ],
    },
  });
  expect((outcome.record.observation as Record<string, unknown>).callId).toBeUndefined();
  // The Warden saw the turn's actions in order, with the projector's summaries as input and output.
  const seen = f.guardCalls[0]!.map((m) => m.content).join('\n');
  expect(seen).toContain("## The agent's actions this turn (3 tool calls, in order)");
  const order = [
    '### Call 1: Write (call-2)',
    '### Call 2: Edit (call-3)',
    '### Call 3: Bash (call-4)',
  ].map((marker) => seen.indexOf(marker));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(seen).toContain('Input: {"file_path":"schema.prisma","old_string":"a","new_string":"b"}');
  expect(seen).toContain('Output: written');
  // The thread state above the moment may mention the read; the moment itself holds no reads.
  expect(seen.slice(seen.indexOf("## The agent's actions this turn"))).not.toContain('Read');
  // The request row carries the same identity; the turn's own meta recorded the one guard entry.
  const request = f.rows('turn-1').find((r) => r.phase === 'guard-request')!;
  expect(request.record).toMatchObject({ domain: 'architecture', wraps: 'turn:turn-1' });
  expect((request.record.observation as any).momentId).toBe(
    (outcome.record.observation as any).momentId,
  );
  const guards = (sent.result.meta as any).phases.guards as Array<Record<string, unknown>>;
  expect(guards).toHaveLength(1);
  expect(guards[0]).toMatchObject({ wraps: 'turn:turn-1', correlation: 'live-dispatch' });
  // A turn with reads only has no moment: no guard call, no row.
  await f.turn('turn-2', 'Look around', [{ tool: 'Read', input: { file_path: 'a.ts' } }]);
  await Bun.sleep(20);
  expect(f.guardCalls).toHaveLength(1);
  expect(f.rows('turn-2').some((r) => r.phase.startsWith('guard'))).toBe(false);
});

test('per-call: every tool call is its own moment, wrapping its call id', async () => {
  const f = fixture({ guard: 'per-call' });
  await f.turn('turn-1', 'Add preferred names', [
    { tool: 'Read', input: { file_path: 'contacts.ts' } },
    { tool: 'Write', input: { file_path: 'contacts.ts' } },
    { tool: 'Edit', input: { file_path: 'schema.prisma' } },
  ]);
  await until(
    () => f.rows('turn-1').filter((r) => r.phase === 'guard-outcome').length === 3,
    'three guard outcomes',
  );
  expect(f.guardCalls).toHaveLength(2);
  const outcomes = f.rows('turn-1').filter((r) => r.phase === 'guard-outcome');
  expect(outcomes.map((r) => r.record.wraps)).toEqual(['call-1', 'call-2', 'call-3']);
  expect(outcomes.map((r) => (r.record.observation as any).momentId)).toEqual([
    'sig-tool-1',
    'sig-tool-2',
    'sig-tool-3',
  ]);
  expect(outcomes[0]!.record).toMatchObject({ mode: 'per-call', domainsChecked: [] });
  expect(outcomes[1]!.record).toMatchObject({ domainsChecked: ['architecture'] });
});

test("an observed subagent's turn is guarded once when it ends, on its node", async () => {
  const f = fixture();
  const node = {
    id: 'sub_child',
    meta: {
      description: 'audit',
      tags: [],
      status: 'active',
      parentThreadId: f.thread.id,
      createdAt: 1,
      lastActiveAt: 1,
    } satisfies ThreadMeta,
  };
  f.store.saveThread(node);
  const call = (n: number, tool: string) =>
    f.thread.signals.emit({
      id: `sig-sub-${n}`,
      kind: 'tool_observation',
      source: `subagent:${node.id}`,
      timestamp: Date.now(),
      content: {
        threadId: f.thread.id,
        tool,
        input: { file_path: `${n}.ts` },
        callId: `sub-call-${n}`,
        agentId: 'subagent',
        subagent: { node, turnId: 'sub-turn-1' },
      },
    });
  await call(1, 'Write');
  await call(2, 'Read');
  await call(3, 'Edit');
  await Bun.sleep(10);
  expect(f.guardCalls).toHaveLength(0);
  await f.thread.signals.emit({
    id: 'sig-subturn-1',
    kind: 'subagent_turn',
    source: `subagent:${node.id}`,
    timestamp: Date.now(),
    content: { threadId: f.thread.id, node, turnId: 'sub-turn-1', outcome: 'completed' },
  });
  await until(
    () => f.rows(undefined, node.id).some((r) => r.phase === 'guard-outcome'),
    'subagent guard outcome',
  );
  expect(f.guardCalls).toHaveLength(1);
  expect(f.rows(undefined, f.thread.id).some((r) => r.phase.startsWith('guard'))).toBe(false);
  const outcome = f.rows(undefined, node.id).find((r) => r.phase === 'guard-outcome')!;
  expect(outcome.turnId).toBe('sub-turn-1');
  expect(outcome.record).toMatchObject({
    wraps: 'turn:sub-turn-1',
    correlation: 'subagent-turn',
    observation: { tool: 'Write, Edit', calls: 2, agentId: 'subagent' },
    activity: {
      calls: [
        { tool: 'Write', callId: 'sub-call-1' },
        { tool: 'Edit', callId: 'sub-call-3' },
      ],
    },
  });
});

test('subagent-spawn: the chorus briefs the handoff from the task text; the brief is journalled on the parent and rides with the next turn', async () => {
  const f = fixture();
  await f.turn('turn-1', 'Audit the snapshots');
  await f.thread.signals.emit({
    id: 'sig-spawn-1',
    kind: 'subagent_spawn',
    source: 'subagent:sub_child',
    timestamp: Date.now(),
    content: {
      threadId: f.thread.id,
      childThreadId: 'sub_child',
      parent: { id: f.thread.id, meta: f.thread.meta },
      parentTurnId: 'turn-1',
      handoffId: 'handoff:sub_child',
      description: 'audit scalar snapshots',
      agentType: 'general-purpose',
      prompt: 'Make the audit snapshots column-only and drop relations.',
    },
  });
  await until(
    () =>
      f.rows('turn-1').some((r) => r.phase === 'advice' && r.record.trigger === 'subagent-spawn'),
    'brief journalled',
  );
  // The Warden was asked once, with the handoff as its moment and the brief protocol.
  expect(f.briefCalls).toHaveLength(1);
  const asked = f.briefCalls[0]!.map((m) => m.content).join('\n');
  expect(asked).toContain('## Handoff to a subagent');
  expect(asked).toContain('general-purpose "audit scalar snapshots"');
  expect(asked).toContain('Make the audit snapshots column-only and drop relations.');
  expect(asked).toContain('## Response protocol (advice phase, trigger: subagent-spawn)');
  expect(asked).toContain('the moment touches nothing in your domain, whatever it says to build');
  // Journalled on the parent, wrapping the handoff, with the Warden's decision and snippets.
  const brief = f
    .rows('turn-1')
    .find((r) => r.phase === 'advice' && r.record.trigger === 'subagent-spawn')!;
  expect(brief.dispatchId).toBeNull();
  expect(brief.record).toMatchObject({
    wraps: 'handoff:sub_child',
    handoff: {
      childThreadId: 'sub_child',
      handoffId: 'handoff:sub_child',
      description: 'audit scalar snapshots',
      agentType: 'general-purpose',
    },
    participants: [
      {
        domain: 'architecture',
        decision: 'contribute',
        snippets: ['Snapshots are column-only: use pickColumns (fb_7).'],
      },
    ],
  });
  // Delivered as a "chimed in" note on the parent's next turn, then gone.
  const flow = f.runtime.flowOrchestrator;
  expect(flow.pendingNotes).toHaveLength(1);
  expect(flow.pendingNotes[0]).toMatchObject({
    id: 'brief:handoff:sub_child:architecture',
    source: 'architecture',
    placement: 'after-message',
  });
  expect(flow.pendingNotes[0]!.text).toBe(
    'The architecture Warden chimed in on the handoff to audit scalar snapshots:\n- Snapshots are column-only: use pickColumns (fb_7).',
  );
  await f.turn('turn-2', 'How did it go?');
  expect(flow.pendingNotes).toHaveLength(0);
  expect(f.central.at(-1)).toContain(
    'The architecture Warden chimed in on the handoff to audit scalar snapshots:',
  );
  // Reduced for Archive: the brief wraps the handoff, not the turn.
  const reduced = reduceMiddleware([
    { id: brief.id, turnId: brief.turnId, phase: brief.phase, record: brief.record, storedAt: 1 },
  ]);
  expect(reduced).toHaveLength(1);
  expect(reduced[0]).toMatchObject({
    role: 'architecture',
    trigger: 'subagent-spawn',
    wraps: 'handoff:sub_child',
    decision: 'contribute',
    result: ['Snapshots are column-only: use pickColumns (fb_7).'],
  });
});

test('a silent brief is journalled (silence is measurable) and queues no note', async () => {
  const f = fixture({ brief: 'NO_COMMENT' });
  await f.turn('turn-1', 'Audit the snapshots');
  await f.thread.signals.emit({
    id: 'sig-spawn-2',
    kind: 'subagent_spawn',
    source: 'subagent:sub_quiet',
    timestamp: Date.now(),
    content: {
      threadId: f.thread.id,
      childThreadId: 'sub_quiet',
      parent: { id: f.thread.id, meta: f.thread.meta },
      parentTurnId: 'turn-1',
      handoffId: 'handoff:sub_quiet',
      prompt: 'List the files.',
    },
  });
  await until(
    () =>
      f.rows('turn-1').some((r) => r.phase === 'advice' && r.record.trigger === 'subagent-spawn'),
    'brief journalled',
  );
  const brief = f
    .rows('turn-1')
    .find((r) => r.phase === 'advice' && r.record.trigger === 'subagent-spawn')!;
  expect(brief.record).toMatchObject({
    participants: [{ domain: 'architecture', decision: 'no-comment', snippets: [] }],
  });
  expect(f.runtime.flowOrchestrator.pendingNotes).toHaveLength(0);
});

test('the recorder reports each spawn (the handoff as the subagent starts) and each turn end', () => {
  const store = new LocalSessionStore(':memory:');
  closes.push(() => store.close());
  const root = {
    id: 'main',
    meta: {
      description: 'Main',
      tags: [],
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1,
    } satisfies ThreadMeta,
  };
  store.saveThread(root);
  store.beginTurn(root, 'turn-1', 'Delegate');
  store.startTurn(root, 'turn-1');
  const spawns: Array<{ root: string; spawn: SubagentSpawn }> = [];
  const ends: Array<{ root: string; turn: SubagentTurnEnd }> = [];
  const recorder = new SubagentRecorder({
    store,
    thread: (id) => store.threads().find((t) => t.id === id),
    onSpawn: (rootId, spawn) => spawns.push({ root: rootId, spawn }),
    onTurnEnd: (rootId, turn) => ends.push({ root: rootId, turn }),
  });
  const base = { schema: 1 as const, nativeOutcome: 'unknown' as const };
  recorder.observe('main', {
    ...base,
    kind: 'subagent',
    subagent: {
      phase: 'started',
      taskId: 'task-1',
      toolUseId: 'toolu_spawn',
      agentType: 'explorer',
      description: 'look around',
      prompt: 'Find the settings',
    },
  } satisfies NativeEvidence);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.root).toBe('main');
  expect(spawns[0]!.spawn).toMatchObject({
    parent: { id: 'main' },
    parentTurnId: 'turn-1',
    description: 'look around',
    agentType: 'explorer',
    prompt: 'Find the settings',
  });
  expect(spawns[0]!.spawn.handoffId).toBe(`handoff:${spawns[0]!.spawn.node.id}`);
  expect(spawns[0]!.spawn.node.meta.parentThreadId).toBe('main');
  expect(ends).toHaveLength(0);
  recorder.observe('main', {
    ...base,
    kind: 'subagent',
    subagent: { phase: 'ended', taskId: 'task-1', status: 'completed', summary: 'Found it' },
  } satisfies NativeEvidence);
  expect(ends).toHaveLength(1);
  expect(ends[0]!.turn).toMatchObject({
    node: { id: spawns[0]!.spawn.node.id },
    outcome: 'completed',
  });
  expect(typeof ends[0]!.turn.turnId).toBe('string');
});

test('the guard setting takes per-turn or per-call, nothing else', () => {
  const config = starterConfig('controlled', 'controlled');
  expect(() => validateConfig(config)).not.toThrow();
  config.guard = 'per-call';
  expect(() => validateConfig(config)).not.toThrow();
  (config as { guard: unknown }).guard = 'sometimes';
  expect(() => validateConfig(config)).toThrow('guard must be one of "per-turn", "per-call"');
});

test('the moment is bounded: each call clipped, the middle of a long turn elided with a count', () => {
  const activity = {
    turnId: 't',
    observations: Array.from({ length: 60 }, (_, i) => ({
      tool: 'Write',
      input: { file_path: `${i}.ts`, content: 'x'.repeat(5_000) },
      output: 'y'.repeat(3_000),
      callId: `c${i}`,
    })),
  };
  const text = renderTurnActivity(activity);
  expect(text.length).toBeLessThan(70_000);
  expect(text).toContain('### Call 1: Write (c0)');
  expect(text).toContain('### Call 60: Write (c59)');
  expect(text).toMatch(/… \d+ call\(s\) elided …/);
  expect(text).toMatch(/Input: \{"file_path":"0\.ts","content":"x+… \[\d+ more chars\]/); // the input past 4 000 chars
  expect(text).toContain('… [2000 more chars]'); // the output past 1 000 chars
  expect(renderTurnActivity(oneCall({ tool: 'Bash', input: { command: 'ls' }, ok: false }))).toBe(
    '### Call 1: Bash — FAILED\nInput: {"command":"ls"}',
  );
});
