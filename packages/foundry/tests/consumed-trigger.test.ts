import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextLayer,
  ContextStack,
  EventStream,
  Harness,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import {
  CHOOSE_ONE_CAVEAT,
  CHORUS_RECEPTION,
  CHORUS_RECEPTION_LAYER,
} from '../src/agents/warden-charter';
import { consumedMatcher, DEFAULT_CONSUMED_MAX_CHARS, workItemOf } from '../src/agents/work-items';
import { reduceMiddleware } from '../src/archives/reduced-middleware';
import { KnowledgePersistence } from '../src/persistence/knowledge-persistence';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { serializeTrace } from '../src/persistence/trace-record';
import { type ConsumedSettings, starterConfig, validateConfig } from '../src/viewer/config';
import { projectChorus, resolveProjectView } from '../src/viewer/config-resolve';

// The consumed trigger (Aron, 2026-10-17): a work item the thread takes in (a ticket or spec file it
// reads, a Linear issue or Notion page it fetches) is a moment every Warden is asked about, so an
// over-specified ticket meets the existing systems before the build. Wardens only point; the main
// thread reads the chime under the reception charter it holds once. Real runtime, factory, Harness,
// orchestrator, Warden and journal; controlled providers only.

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
const CONSUMED = 'trigger: consumed)';
async function until(predicate: () => boolean, label: string, ms = 2000) {
  const end = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > end) throw Error(`deadline: ${label}`);
    await Bun.sleep(2);
  }
}

const POINTER =
  'Look over here: createLock (packages/db/src/lock/createLock.ts; CONCURRENCY.md § Distributed Lock) — the ticket asks for exclusion across instances.';
const LESS_LIKELY =
  'Less likely: makeSerializedQueue (QUEUES.md § Serialized) — ordering of jobs, not exclusion.';

interface Call {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
}

function fixture(opts: { consumed?: ConsumedSettings; answer?: string; domains?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'consumed-'));
  mkdirSync(join(root, 'tickets'), { recursive: true });
  writeFileSync(
    join(root, 'tickets', 'ENG-12.md'),
    'ENG-12: Add a new table `job_locks` and write a lock so two workers never run the same export.',
  );
  writeFileSync(join(root, 'notes.md'), 'Nothing to see.');
  const config = starterConfig('controlled', 'controlled');
  config.projects = {
    P: {
      id: 'P',
      name: 'P',
      path: root,
      ...(opts.consumed ? { chorus: { consumed: opts.consumed } } : {}),
    } as (typeof config.projects)[string],
  };
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
  const layer = new ContextLayer({ id: 'concurrency', segment: 'domain-knowledge' });
  layer.set('createLock is the distributed lock; makeSerializedQueue orders jobs.');
  const stack = new ContextStack([layer]);
  const events = new EventStream();
  const consumedCalls: LLMMessage[][] = [];
  const auxiliary: LLMProvider = {
    id: 'controlled-aux',
    async complete(messages) {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes(CONSUMED)) {
        consumedCalls.push(structuredClone(messages));
        return {
          model: 'controlled',
          content:
            opts.answer ??
            JSON.stringify({ layers: [], snippets: [POINTER, LESS_LIKELY], confidence: 0.9 }),
        };
      }
      return { model: 'controlled', content: 'NO_COMMENT' };
    },
  };
  const manager = new ThreadRuntimeManager({
    config,
    log() {},
    warn() {},
    eventStream: events,
    domains:
      opts.domains === false
        ? []
        : [{ domain: 'concurrency', layerId: 'concurrency', guardTriggers: [] }],
    learning: { enabled: false },
    llm: auxiliary,
  });
  const central: LLMMessage[][] = [];
  const factory = new ThreadFactory({
    stack,
    runtime: manager,
    agents: buildAgents(config, stack, {
      provider: {
        id: 'central',
        async complete(messages) {
          central.push(structuredClone(messages));
          return { model: 'central', content: 'COMPLETED' };
        },
      },
    }),
  });
  const store = new LocalSessionStore(':memory:');
  new KnowledgePersistence(manager, store, events, []);
  const thread = factory.create('consumed', { projectId: 'P', cwd: root });
  const runtime = manager.get(thread.id)!;
  closes.push(() => {
    manager.disposeAll();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  let tools = 0;
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
  const rows = (turnId?: string) =>
    store
      .phaseHistory(thread.id, turnId ? { turnId } : undefined)
      .filter((r) => r.phase !== 'middleware-reduced');
  const consumedRows = () =>
    rows().filter((r) => r.phase === 'advice' && r.record.trigger === 'consumed');
  return { root, thread, runtime, store, consumedCalls, central, turn, rows, consumedRows };
}

test('consumed: a ticket file the thread reads is asked about once; the pointer is journalled and rides with the next turn', async () => {
  const f = fixture({ consumed: { enabled: true } });
  await f.turn('turn-1', 'Do ENG-12', [
    {
      tool: 'Read',
      input: { file_path: join(f.root, 'tickets', 'ENG-12.md') },
      output: '1→ENG-12',
    },
    { tool: 'Read', input: { file_path: join(f.root, 'notes.md') } },
  ]);
  await until(() => f.consumedRows().length === 1, 'work item journalled');
  // One moment: the ticket, read from disk (the observed output is only a summary); notes.md is no work item.
  expect(f.consumedCalls).toHaveLength(1);
  const asked = f.consumedCalls[0]!.map((m) => m.content).join('\n');
  expect(asked).toContain('## Work item the agent took in');
  expect(asked).toContain('(Read: tickets/ENG-12.md)');
  expect(asked).toContain('Add a new table `job_locks` and write a lock');
  expect(asked).toContain('## Response protocol (advice phase, trigger: consumed)');
  expect(asked).toContain('whatever it says to build or not to use');
  expect(asked).not.toContain('Nothing to see.');
  const row = f.consumedRows()[0]!;
  expect(row.dispatchId).toBeNull();
  expect(row.record).toMatchObject({
    wraps: 'Read:tickets/ENG-12.md',
    workItem: { itemId: 'Read:tickets/ENG-12.md', name: 'tickets/ENG-12.md', tool: 'Read' },
    participants: [
      { domain: 'concurrency', decision: 'contribute', snippets: [POINTER, LESS_LIKELY] },
    ],
  });
  // The chime is the pointer as the Warden wrote it: no question, no verdict added by Foundry.
  const flow = f.runtime.flowOrchestrator;
  expect(flow.pendingNotes).toHaveLength(1);
  expect(flow.pendingNotes[0]).toMatchObject({
    id: 'consumed:Read:tickets/ENG-12.md:concurrency',
    source: 'concurrency',
    placement: 'after-message',
  });
  expect(flow.pendingNotes[0]!.text).toBe(
    `The concurrency Warden chimed in on the work item tickets/ENG-12.md:\n- ${POINTER}\n- ${LESS_LIKELY}`,
  );
  await f.turn('turn-2', 'Go on');
  expect(flow.pendingNotes).toHaveLength(0);
  const user = f.central
    .at(-1)!
    .filter((m) => m.role === 'user')
    .at(-1)!.content;
  expect(user).toContain('The concurrency Warden chimed in on the work item tickets/ENG-12.md:');
  // The same file read again (a chunk of it, unchanged on disk) is one item: not asked again.
  await f.turn('turn-3', 'Read it again', [
    {
      tool: 'Read',
      input: { file_path: join(f.root, 'tickets', 'ENG-12.md'), offset: 1, limit: 1 },
    },
  ]);
  await Bun.sleep(20);
  expect(f.consumedCalls).toHaveLength(1);
  // A subagent's read is not asked: its notes would reach the parent's next turn, not the subagent.
  writeFileSync(join(f.root, 'tickets', 'ENG-99.md'), 'ENG-99: write a new mutex.');
  await f.thread.signals.emit({
    id: 'sig-sub-read',
    kind: 'tool_observation',
    source: 'subagent:sub_child',
    timestamp: Date.now(),
    content: {
      threadId: f.thread.id,
      tool: 'Read',
      input: { file_path: join(f.root, 'tickets', 'ENG-99.md') },
      callId: 'sub-call-1',
      agentId: 'subagent',
      subagent: { node: { id: 'sub_child', meta: f.thread.meta }, turnId: 'sub-turn' },
    },
  });
  await Bun.sleep(20);
  expect(f.consumedCalls).toHaveLength(1);
  // Reduced for Archive: it wraps the item.
  const reduced = reduceMiddleware([
    { id: row.id, turnId: row.turnId, phase: row.phase, record: row.record, storedAt: 1 },
  ]);
  expect(reduced[0]).toMatchObject({
    role: 'concurrency',
    trigger: 'consumed',
    wraps: 'Read:tickets/ENG-12.md',
  });
});

test('consumed: a fetched Linear issue is a work item; a silent chorus is journalled and queues nothing', async () => {
  const f = fixture({ consumed: { enabled: true }, answer: 'NO_COMMENT' });
  await f.turn('turn-1', 'Pick up the issue', [
    {
      tool: 'mcp__plugin_linear_linear__get_issue',
      input: { id: 'ENG-40' },
      output: 'ENG-40: add an emoji picker to the composer.',
    },
    { tool: 'mcp__plugin_linear_linear__list_issues', input: {}, output: 'ENG-40, ENG-41' },
  ]);
  await until(() => f.consumedRows().length === 1, 'work item journalled');
  expect(f.consumedCalls).toHaveLength(1);
  expect(f.consumedCalls[0]!.map((m) => m.content).join('\n')).toContain(
    '(mcp__plugin_linear_linear__get_issue: ENG-40)',
  );
  expect(f.consumedRows()[0]!.record).toMatchObject({
    participants: [{ domain: 'concurrency', decision: 'no-comment', snippets: [] }],
  });
  expect(f.runtime.flowOrchestrator.pendingNotes).toHaveLength(0);
});

test('consumed is off by default: a ticket read asks nothing', async () => {
  const f = fixture();
  await f.turn('turn-1', 'Do ENG-12', [
    { tool: 'Read', input: { file_path: join(f.root, 'tickets', 'ENG-12.md') } },
  ]);
  await Bun.sleep(30);
  expect(f.consumedCalls).toHaveLength(0);
  expect(f.consumedRows()).toHaveLength(0);
});

test('a thread with Wardens holds the reception charter once; a thread with none does not', () => {
  expect(fixture().thread.stack.getLayer(CHORUS_RECEPTION_LAYER)?.content).toBe(CHORUS_RECEPTION);
  expect(fixture({ domains: false }).thread.stack.getLayer(CHORUS_RECEPTION_LAYER)).toBeUndefined();
});

test('the reception charter says how to read each pointer shape and carries the acknowledgement rule', () => {
  expect(CHORUS_RECEPTION).toContain('not advice and not a decision');
  expect(CHORUS_RECEPTION).toContain('follow the top one first');
  expect(CHORUS_RECEPTION).toContain(`Choose one: ${CHOOSE_ONE_CAVEAT}`);
  expect(CHORUS_RECEPTION).toContain('say which you picked and why');
  expect(CHORUS_RECEPTION).toContain("This doesn't match what we have");
  expect(CHORUS_RECEPTION).toContain('A casual "do it this way" is not an acknowledgement');
  expect(CHORUS_RECEPTION).toContain('state the material difference in your plan');
  expect(CHORUS_RECEPTION).toContain('not applicable because');
  expect(CHORUS_RECEPTION).toContain('Silence** is not evidence that nothing exists');
});

test('the work-item matcher: tool globs, project-relative path globs, defaults, clipping, failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'work-items-'));
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'design', 'locks.md'),
    'x'.repeat(DEFAULT_CONSUMED_MAX_CHARS + 50),
  );
  expect(consumedMatcher(undefined)).toBeUndefined();
  expect(consumedMatcher({})).toBeUndefined();
  expect(consumedMatcher({ enabled: false })).toBeUndefined();
  const m = consumedMatcher({ enabled: true })!;
  // A read under docs/design, by absolute or relative path: read from disk and clipped.
  const abs = workItemOf(
    { tool: 'Read', input: { file_path: join(root, 'docs', 'design', 'locks.md') } },
    m,
    root,
  )!;
  expect(abs).toMatchObject({ itemId: 'Read:docs/design/locks.md', clipped: 50 });
  expect(abs.text).toHaveLength(DEFAULT_CONSUMED_MAX_CHARS);
  expect(
    workItemOf({ tool: 'Read', input: { file_path: 'docs/design/locks.md' } }, m, root)?.name,
  ).toBe('docs/design/locks.md');
  // Not a work item: an unmatched path, a failed call, a write, a tool no glob names.
  expect(workItemOf({ tool: 'Read', input: { file_path: 'src/a.ts' } }, m, root)).toBeUndefined();
  expect(
    workItemOf({ tool: 'Read', input: { file_path: 'docs/design/locks.md' }, ok: false }, m, root),
  ).toBeUndefined();
  expect(
    workItemOf({ tool: 'Write', input: { file_path: 'docs/design/locks.md' } }, m, root),
  ).toBeUndefined();
  expect(
    workItemOf({ tool: 'mcp__github__get_issue', input: { id: '1' }, output: 'x' }, m, root),
  ).toBeUndefined();
  // The installed tool names, matched case-insensitively.
  expect(
    workItemOf(
      { tool: 'mcp__claude_ai_Linear__get_issue', input: { id: 'ENG-1' }, output: 'x' },
      m,
      root,
    )?.name,
  ).toBe('ENG-1');
  // Test specs and code under a specs directory are not work items; prose is.
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'specs', 'locks.spec.ts'), 'test');
  writeFileSync(join(root, 'specs', 'locks.md'), 'The lock spec');
  expect(
    workItemOf({ tool: 'Read', input: { file_path: 'specs/locks.spec.ts' } }, m, root),
  ).toBeUndefined();
  expect(workItemOf({ tool: 'Read', input: { file_path: 'specs/locks.md' } }, m, root)?.text).toBe(
    'The lock spec',
  );
  // Notion pages by the default glob; a fetch with no text is nothing.
  expect(
    workItemOf(
      { tool: 'mcp__claude_ai_Notion__notion-fetch', input: { id: 'page-1' }, output: 'Spec' },
      m,
      root,
    ),
  ).toMatchObject({ name: 'page-1', text: 'Spec' });
  expect(
    workItemOf({ tool: 'mcp__claude_ai_Notion__notion-fetch', input: {}, output: ' ' }, m, root),
  ).toBeUndefined();
  // A fetch with no id field is keyed by what it returned: two different pages are two items.
  const a = workItemOf({ tool: 'mcp__notion__fetch', input: {}, output: 'Page A' }, m, root)!;
  const b = workItemOf({ tool: 'mcp__notion__fetch', input: {}, output: 'Page B' }, m, root)!;
  expect(a.key).not.toBe(b.key);
  expect(
    workItemOf({ tool: 'mcp__notion__fetch', input: { id: 'p' }, output: 'x' }, m, root)!.key,
  ).toBe('mcp__notion__fetch:p');
  // Configured globs replace the defaults; maxChars clips.
  const custom = consumedMatcher({
    enabled: true,
    tools: ['mcp__jira__*'],
    paths: ['work/**'],
    maxChars: 300,
  })!;
  expect(
    workItemOf(
      { tool: 'mcp__jira__get', input: { url: 'J-1' }, output: 'y'.repeat(400) },
      custom,
      root,
    ),
  ).toMatchObject({ name: 'J-1', clipped: 100 });
  expect(
    workItemOf({ tool: 'Read', input: { file_path: 'docs/design/locks.md' } }, custom, root),
  ).toBeUndefined();
});

test('chorus.consumed is validated, and the machine settings win over the repository key by key', () => {
  const config = starterConfig('controlled', 'controlled');
  const root = mkdtempSync(join(tmpdir(), 'consumed-settings-'));
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.foundry'), { recursive: true });
  writeFileSync(
    join(root, '.foundry', 'project.json'),
    JSON.stringify({
      chorus: { consumed: { enabled: true, paths: ['tickets/**'], maxChars: 5000 } },
    }),
  );
  const project = { id: 'P', name: 'P', path: root } as (typeof config.projects)[string];
  expect(projectChorus(project).chorus.consumed).toEqual({
    enabled: true,
    paths: ['tickets/**'],
    maxChars: 5000,
  });
  expect(
    projectChorus({ ...project, chorus: { consumed: { maxChars: 800 } } }).chorus.consumed,
  ).toEqual({ enabled: true, paths: ['tickets/**'], maxChars: 800 });
  // The view reports whether the trigger is on, so its provenance is the `enabled` key's.
  expect(projectChorus({ ...project, chorus: { consumed: { maxChars: 800 } } }).consumedFrom).toBe(
    'repository',
  );
  config.projects = { P: { ...project, chorus: { consumed: { enabled: false } } } };
  expect(resolveProjectView(config, 'P')!.config.projects.P!.chorus).toEqual({
    enabled: false,
    consumed: { enabled: false, paths: ['tickets/**'], maxChars: 5000 },
  });
  const bad = (consumed: unknown) =>
    validateConfig({ ...config, projects: { P: { ...project, chorus: { consumed } as never } } });
  expect(() => bad({ enabled: 'yes' })).toThrow('consumed.enabled must be true or false');
  expect(() => bad({ tools: 'mcp__*' })).toThrow('consumed.tools must be a list of globs');
  expect(() => bad({ maxChars: 10 })).toThrow('consumed.maxChars must be a whole number');
  expect(() => bad({ when: 1 })).toThrow('consumed.when is not a consumed setting');
});
