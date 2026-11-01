import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { ContextStack, Thread, type ThreadPlan, ToolRegistry } from '@inixiative/foundry-core';
import { createFoundryMcp } from '../src/mcp/server';
import { applyPlanPatch, PLAN_TOOL_DESCRIPTION, ThreadPlanTool } from '../src/tools/thread-plan';
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

test("the agent's set_plan records the thread's plan; a call replaces only the sections it gives", async () => {
  const thread = new Thread('t', new ContextStack(), { description: '' });
  const tools = new ToolRegistry();
  tools.register(
    new ThreadPlanTool(() => ({
      setPlan: (threadId, patch) => {
        expect(threadId).toBe('t');
        thread.meta.plan = applyPlanPatch(thread.meta.plan, patch);
        return thread.meta.plan;
      },
    })),
    PLAN_TOOL_DESCRIPTION,
  );
  const mcp = createFoundryMcp({ thread, tools });
  const client = new Client({ name: 'plan', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(() => client.close());
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'set_plan', arguments: args });
    return {
      isError: !!result.isError,
      text: (result.content as Array<{ text: string }>)[0]!.text,
    };
  };
  expect((await client.listTools()).tools.map((tool: { name: string }) => tool.name)).toContain(
    'set_plan',
  );
  expect(
    await call({
      outcomes: [{ text: 'Board shows the device badge', status: 'doing' }],
      strategy: [{ text: 'Stamp the device on thread meta', detail: 'From device.json' }],
      technical: [technical],
    }),
  ).toEqual({ isError: false, text: 'Plan recorded: 1 outcomes, 1 technical decisions.' });
  await call({ outcomes: [{ text: 'Board shows the device badge', status: 'done' }] });
  expect(thread.meta.plan).toMatchObject({
    outcomes: [{ text: 'Board shows the device badge', status: 'done' }],
    pains: [],
    strategy: [{ text: 'Stamp the device on thread meta', detail: 'From device.json' }],
    technical: [technical],
  } satisfies Partial<ThreadPlan>);

  // A technical row must name the system and say why; a bad decision word is refused, nothing recorded.
  const before = thread.meta.plan;
  const refused = await call({ technical: [{ ...technical, decision: 'invent', reason: '' }] });
  expect(refused.isError).toBe(true);
  expect(thread.meta.plan).toBe(before);
});

test("the viewer's plans service records the plan on the thread's journalled meta", async () => {
  const s = await m0Scenario();
  cleanup.push(() => s.close());
  const plan = s.current.plans.setPlan('a', {
    outcomes: [{ text: 'Migration applied', status: 'todo' }],
    technical: [
      {
        ...technical,
        decision: 'new',
        system: 'none close',
        reason: 'No primitive migrates this table; the nearest, db push, drops data',
      },
    ],
  });
  expect(plan.outcomes).toHaveLength(1);
  expect(s.current.localStore!.threads().find((t) => t.id === 'a')?.meta.plan).toEqual(plan);
  expect(() => s.current.plans.setPlan('nope', { pains: [] })).toThrow(
    'This thread is not live here',
  );
});
