import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  ContextStack,
  type LLMProvider,
  Thread,
  type ThreadPlan,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { PLAN_ASK_NOTE } from '../src/agents/chorus-reception';
import { PlanDrafter, parseDraft } from '../src/agents/plan-drafter';
import { ThreadNamer } from '../src/agents/thread-namer';
import { createFoundryMcp } from '../src/mcp/server';
import {
  applyPlanPatch,
  needsPlan,
  recordPlan,
  THREAD_RECORD_TOOL_DESCRIPTION,
  ThreadRecordTool,
  wantsDraft,
} from '../src/tools/thread-record';
import { m0Scenario } from './helpers/m0-domain-loop';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(
  require.resolve('@modelcontextprotocol/sdk/inMemory.js')
);

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const technical = {
  concern: 'locks',
  decision: 'reuse' as const,
  system: 'withLock',
  path: 'packages/shared/src/lock.ts',
  reason: 'The lock primitive already serialises per key',
};

/** A thread with Foundry's MCP bridge over the record tool; `call` returns the tool's sentence. */
async function bridge() {
  const thread = new Thread('t', new ContextStack(), { description: '' });
  let writes = 0;
  const tools = new ToolRegistry();
  tools.register(
    new ThreadRecordTool(() => ({
      read: (threadId) => {
        expect(threadId).toBe('t');
        return thread;
      },
      update: (threadId, change) => {
        expect(threadId).toBe('t');
        writes++;
        return change(thread);
      },
    })),
    THREAD_RECORD_TOOL_DESCRIPTION,
  );
  const mcp = createFoundryMcp({ thread, tools });
  const client = new Client({ name: 'record', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: !!result.isError,
      text: (result.content as Array<{ text: string }>)[0]!.text,
    };
  };
  const names = (await client.listTools()).tools.map((tool: { name: string }) => tool.name);
  return { thread, call, names, writes: () => writes };
}

test('the agent sees every record tool and the Herald placeholder', async () => {
  const { names } = await bridge();
  for (const name of [
    'set_plan',
    'get_plan',
    'clear_plan',
    'set_loop',
    'loop_round',
    'stop_loop',
    'rename_thread',
    'set_status',
    'ask_herald',
  ])
    expect(names).toContain(name);
});

test("set_plan records the thread's plan; a call replaces only the sections it gives; mark moves one outcome", async () => {
  const { thread, call } = await bridge();
  expect(
    await call('set_plan', {
      outcomes: [
        { text: 'Board shows the device badge', status: 'doing' },
        { text: 'Docs say so', status: 'todo' },
      ],
      strategy: [{ text: 'Stamp the device on thread meta', detail: 'From device.json' }],
      technical: [technical],
    }),
  ).toEqual({ isError: false, text: 'Plan recorded: 2 outcomes, 1 technical decisions.' });
  await call('set_plan', { mark: [{ outcome: 'Board shows the device badge', status: 'done' }] });
  await call('set_plan', { mark: [{ outcome: '2', status: 'doing' }] });
  expect(thread.meta.plan).toMatchObject({
    outcomes: [
      { text: 'Board shows the device badge', status: 'done' },
      { text: 'Docs say so', status: 'doing' },
    ],
    pains: [],
    strategy: [{ text: 'Stamp the device on thread meta', detail: 'From device.json' }],
    technical: [technical],
    draftedBy: 'agent',
  } satisfies Partial<ThreadPlan>);
  // The outcome the agent newly marked done is the thread's milestone.
  expect(thread.meta.done).toMatchObject({
    kind: 'milestone',
    text: 'Board shows the device badge',
  });

  // A bad row or an unknown outcome is refused, and nothing is recorded.
  const before = thread.meta.plan;
  expect(
    (await call('set_plan', { technical: [{ ...technical, decision: 'invent', reason: '' }] }))
      .isError,
  ).toBe(true);
  const unknown = await call('set_plan', { mark: [{ outcome: 'Nope', status: 'done' }] });
  expect(unknown).toEqual({
    isError: true,
    text: 'No outcome "Nope" in the plan: name it by its exact text or its number',
  });
  expect(thread.meta.plan).toBe(before);

  // get_plan reads it back; clear_plan removes it.
  const read = JSON.parse((await call('get_plan')).text);
  expect(read.plan.outcomes).toHaveLength(2);
  expect(read.status).toMatchObject({ state: 'done' });
  expect(await call('clear_plan')).toEqual({ isError: false, text: 'Plan cleared.' });
  expect(thread.meta.plan).toBeUndefined();
});

test("the agent's first set_plan replaces a Foundry draft whole, and a draft never marks a milestone", () => {
  const thread = new Thread('d', new ContextStack(), { description: '' });
  recordPlan(
    thread,
    {
      outcomes: [{ text: 'Login works', status: 'doing' }],
      strategy: [{ text: 'Guessed step' }],
    },
    'foundry',
  );
  expect(thread.meta.plan?.draftedBy).toBe('foundry');
  expect(thread.meta.done).toBeUndefined();
  recordPlan(thread, { outcomes: [{ text: 'Login endpoint returns a token', status: 'todo' }] });
  expect(thread.meta.plan).toMatchObject({
    outcomes: [{ text: 'Login endpoint returns a token', status: 'todo' }],
    strategy: [],
    draftedBy: 'agent',
  });
  // Later agent patches keep the agent's own sections.
  expect(applyPlanPatch(thread.meta.plan, { pains: [{ text: 'No login' }] }).outcomes).toHaveLength(
    1,
  );
});

test('the loop: set_loop starts it, loop_round records rounds, the limit says stop, stop_loop ends it', async () => {
  const { thread, call } = await bridge();
  expect((await call('loop_round', { result: 'fail', note: 'x' })).text).toBe(
    'No loop is running on this thread: start one with set_loop',
  );
  expect(
    (
      await call('set_loop', {
        goal: 'Suite green',
        steps: [{ text: 'Run the suite' }, { text: 'Fix the first failure' }],
        until: 'bun run check passes',
        maxRounds: 2,
      })
    ).text,
  ).toBe('Loop running: 2 steps a round, until bun run check passes.');
  expect((await call('loop_round', { result: 'fail', note: '3 failures' })).text).toBe(
    'Round 1 recorded (fail).',
  );
  // A revision of the running loop keeps its rounds.
  expect(
    (
      await call('set_loop', {
        goal: 'Suite green',
        steps: [{ text: 'Run the suite' }],
        until: 'bun run check passes',
        maxRounds: 2,
      })
    ).text,
  ).toBe('Loop running: 1 steps a round, until bun run check passes (1 rounds so far).');
  expect((await call('loop_round', { result: 'partial', note: '1 failure' })).text).toBe(
    "Round 2 recorded (partial). That is the loop's limit of 2: stop it (stop_loop) and tell the person where it stands.",
  );
  expect((await call('stop_loop', { result: 'stopped', reason: 'Limit reached' })).text).toBe(
    'Loop stopped after 2 rounds.',
  );
  expect(thread.meta.loop).toMatchObject({
    state: 'stopped',
    stopReason: 'Limit reached',
    rounds: [
      { round: 1, result: 'fail', note: '3 failures' },
      { round: 2, result: 'partial', note: '1 failure' },
    ],
  });
  // A new loop after one ended starts fresh.
  await call('set_loop', { goal: 'Again', steps: [{ text: 'Run' }], until: 'green' });
  expect(thread.meta.loop?.rounds).toEqual([]);
});

test("rename_thread sets the Foundry name as the agent's; a person's name stays and the namer leaves the agent's alone", async () => {
  const { thread, call } = await bridge();
  expect(await call('rename_thread', { name: 'Fix flaky login test' })).toEqual({
    isError: false,
    text: 'Thread renamed: Fix flaky login test.',
  });
  expect(thread.meta.foundryName).toMatchObject({ text: 'Fix flaky login test', by: 'agent' });

  let decisions = 0;
  const provider: LLMProvider = {
    id: 'naming',
    async complete() {
      decisions++;
      return { content: '{"title":"Something else entirely"}', model: 'haiku' };
    },
  };
  const namer = new ThreadNamer({
    provider,
    changed() {},
    quietMs: 0,
    minIntervalMs: 0,
    minTurns: 1,
  });
  namer.turnCompleted(thread, { user: 'Now look at the signup page layout', agent: 'ok' });
  await Bun.sleep(10);
  expect(decisions).toBe(0);
  expect(thread.meta.foundryName?.text).toBe('Fix flaky login test');

  thread.meta.name = { text: 'My name', updatedAt: Date.now() };
  const refused = await call('rename_thread', { name: 'Another name here' });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('The person named this thread "My name"');
});

test('set_status: needs-you and blocked are the agent’s; done is the milestone; clear resets; Foundry’s states are refused', async () => {
  const { thread, call } = await bridge();
  expect((await call('set_status', { status: 'needs-you' })).isError).toBe(true);
  expect((await call('set_status', { status: 'queued', text: 'x' })).isError).toBe(true);
  expect((await call('set_status', { status: 'working', text: 'x' })).isError).toBe(true);
  await call('set_status', { status: 'needs-you', text: 'Which table should it write to?' });
  expect(thread.meta.agentStatus).toMatchObject({
    state: 'needs-you',
    text: 'Which table should it write to?',
  });
  await call('set_status', { status: 'blocked', text: 'No GitHub token' });
  expect(thread.meta.agentStatus?.state).toBe('blocked');
  await call('set_status', { status: 'done', text: 'Login endpoint shipped' });
  expect(thread.meta.agentStatus).toBeUndefined();
  expect(thread.meta.done).toMatchObject({ kind: 'milestone', text: 'Login endpoint shipped' });
  await call('set_status', { status: 'clear' });
  expect(thread.meta.done).toBeUndefined();
});

test('ask_herald says Heralds are coming soon and what to use today', async () => {
  const { call, writes } = await bridge();
  const answer = await call('ask_herald', { question: 'Is anyone working on login?' });
  expect(answer.text).toContain('Heralds are coming soon');
  expect(answer.text).toContain('foundry_threads');
  expect(writes()).toBe(0);
});

test('a plan is due on new work: none, only a draft, or every outcome done; a draft is wanted only when the agent left none', () => {
  const plan = (status: 'done' | 'doing', draftedBy?: 'foundry') => ({
    plan: {
      outcomes: [{ text: 'x', status }],
      pains: [],
      strategy: [],
      reasons: [],
      technical: [],
      ...(draftedBy ? { draftedBy } : {}),
      updatedAt: 0,
    },
  });
  expect(needsPlan({})).toBe(true);
  expect(needsPlan(plan('doing'))).toBe(false);
  expect(needsPlan(plan('done'))).toBe(true);
  expect(needsPlan(plan('doing', 'foundry'))).toBe(true);
  expect(wantsDraft({})).toBe(true);
  expect(wantsDraft(plan('done'))).toBe(true);
  expect(wantsDraft(plan('doing', 'foundry'))).toBe(false);
  expect(PLAN_ASK_NOTE).toContain('set_plan');
});

test('the drafter writes a marked draft after a work turn with no plan, skips chat, and never overwrites the agent', async () => {
  const answers: string[] = [];
  const provider: LLMProvider = {
    id: 'decisions',
    async complete() {
      return { content: answers.shift() ?? '{"skip":true}', model: 'haiku' };
    },
  };
  let changed = 0;
  const drafter = new PlanDrafter({ provider, changed: () => changed++ });
  const thread = new Thread('p', new ContextStack(), { description: '' });

  // Chat: no decision runs at all.
  drafter.turnCompleted(thread, { user: 'hi there', agent: 'hello' });
  await Bun.sleep(5);
  expect(thread.meta.plan).toBeUndefined();

  // The decision says skip (a question).
  answers.push('{"skip":true}');
  drafter.turnCompleted(thread, { user: 'What does the login route return?', agent: 'A token.' });
  await Bun.sleep(5);
  expect(thread.meta.plan).toBeUndefined();

  // Work: a draft, marked as Foundry's.
  answers.push(
    '{"outcomes":[{"text":"Login endpoint returns a token","status":"doing"}],"strategy":[{"text":"Add the route"}]}',
  );
  drafter.turnCompleted(thread, { user: 'Add a login endpoint', agent: 'Added it.' });
  await Bun.sleep(5);
  expect(thread.meta.plan).toMatchObject({
    draftedBy: 'foundry',
    outcomes: [{ text: 'Login endpoint returns a token', status: 'doing' }],
  });
  expect(thread.meta.done).toBeUndefined();
  expect(changed).toBe(1);

  // A draft exists: no second draft.
  answers.push('{"outcomes":[{"text":"Other","status":"todo"}]}');
  drafter.turnCompleted(thread, { user: 'Also add logout', agent: 'Done.' });
  await Bun.sleep(5);
  expect(thread.meta.plan?.outcomes[0]?.text).toBe('Login endpoint returns a token');

  // A draft that claims done, or is malformed, is dropped.
  expect(parseDraft('{"outcomes":[{"text":"x","status":"done"}]}')).toBeUndefined();
  expect(parseDraft('not json')).toBeUndefined();
});

test("the viewer's records service writes on the thread's journalled meta", async () => {
  const s = await m0Scenario();
  cleanup.push(() => s.close());
  const plan = s.current.records.update('a', (thread) =>
    recordPlan(thread, {
      outcomes: [{ text: 'Migration applied', status: 'todo' }],
      technical: [
        {
          ...technical,
          decision: 'new',
          system: 'none close',
          reason: 'No primitive migrates this table; the nearest, db push, drops data',
        },
      ],
    }),
  );
  expect(plan.outcomes).toHaveLength(1);
  expect(s.current.localStore!.threads().find((t) => t.id === 'a')?.meta.plan).toEqual(plan);
  expect(() => s.current.records.read('nope')).toThrow('This thread is not live here');
});
