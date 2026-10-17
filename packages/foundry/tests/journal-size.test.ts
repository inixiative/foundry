import './helpers/isolate-archive';
import type { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  FileMemory,
  Harness,
  InterventionLog,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../src/agents/project';
import {
  buildAgents,
  buildLayers,
  createSourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { ConfigStore, type FoundryConfig, starterConfig } from '../src/viewer/config';
import { createViewer } from '../src/viewer/server';
import { writeRegions } from './helpers/regions';

/** Composed instructions every Warden shares (global CLAUDE.md and the like): about 60k chars. */
const SHARED = `SHARED_COMPOSED_INSTRUCTIONS\n${'Look for what already exists before building. '.repeat(1300)}`;
const KNOWLEDGE = `DOMAIN_KNOWLEDGE\n${'A configured domain fact. '.repeat(400)}`;

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The project's role files overlay its region Wardens: nothing from the machine running the tests. */
const ROLE_FILES: NonNullable<FoundryConfig['composition']> = {
  preset: 'none',
  nodes: {
    project: {
      scope: 'project',
      personal: false,
      sources: [
        {
          walk: [
            {
              path: '.foundry/roles/{role}/{slot}.md',
              when: { slots: ['instructions', 'domainKnowledge'] },
            },
          ],
          span: { within: ['{project}'] },
        },
      ],
    },
  },
} as NonNullable<FoundryConfig['composition']>;

function baseConfig(): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.setupComplete = true;
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: 'Work',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  c.composition = structuredClone(ROLE_FILES);
  c.layers = {};
  c.sources = {};
  return c;
}

/**
 * Project P with `wardens` region Wardens, each with large composed instructions: the shared text
 * (global CLAUDE.md and the like) through its role file, its region's knowledge whole.
 */
async function wardenConfig(wardens: number): Promise<FoundryConfig> {
  const project = await tempDir('foundry-journal-project-');
  const ids = Array.from({ length: wardens }, (_, i) => `w${i}`);
  writeRegions(
    project,
    ids.map((id) => ({ id, knowledge: KNOWLEDGE })),
  );
  for (const [i, id] of ids.entries()) {
    await mkdir(join(project, '.foundry', 'roles', id), { recursive: true });
    await writeFile(
      join(project, '.foundry', 'roles', id, 'instructions.md'),
      `${SHARED}\nWARDEN_${i}`,
    );
  }
  const c = baseConfig();
  c.composition!.roles = Object.fromEntries(ids.map((id) => [id, { budget: 200_000 }]));
  c.projects.P = { id: 'P', path: project };
  return c;
}

/** The production viewer, runtime and SQLite journal; only model answers are controlled. */
async function viewerWith(c: FoundryConfig) {
  const dir = await tempDir('foundry-journal-size-');
  const reply = (messages: LLMMessage[], threadId = '') =>
    threadId.endsWith(':cartographer')
      ? JSON.stringify({ layers: [], domains: [], confidence: 1 })
      : messages.some((m) => String(m.content).includes('## Completed work'))
        ? JSON.stringify({ knowledge: 'Learned a fact.', facts: ['A fact'] })
        : threadId.includes(':aux:')
          ? JSON.stringify({ layers: [], snippets: ['Mind the fact.'], confidence: 1 })
          : 'done';
  const provider = (id: string): LLMProvider => ({
    id,
    complete: async (messages, opts = {}) => ({
      model: 'controlled',
      content: reply(messages, opts.threadId),
    }),
  });
  const central = provider('central');
  const providers = new Map([central, provider('flow'), provider('expert')].map((p) => [p.id, p]));
  const sourceResolver = createSourceResolver({ memory: new FileMemory(join(dir, 'memory')) });
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const events = new EventStream();
  const runtime = new ThreadRuntimeManager({
    config: c,
    llm: providers.get('flow')!,
    providers,
    eventStream: events,
    log() {},
    warn() {},
    learning: { timeoutMs: 1000, hardTimeoutMs: 5000 },
  });
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  const main = factory.create('main', c.projects.P ? { projectId: 'P' } : {});
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const configStore = new ConfigStore(dir);
  await configStore.save(c);
  const projectRegistry = new ProjectRegistry();
  for (const [id, project] of Object.entries(c.projects))
    projectRegistry.register({
      id,
      path: project.path,
      label: id,
      tags: [],
      runtime: 'claude-code',
    });
  const viewer = createViewer({
    projectRegistry,
    harness,
    eventStream: events,
    interventions: new InterventionLog(),
    configDir: dir,
    configStore,
    threadFactory: factory,
  });
  cleanup.push(async () => {
    for (const r of runtime.runtimes.values()) await r.learningSettled();
    runtime.disposeAll();
    viewer.localStore?.close();
  });
  const send = (id: string) =>
    viewer.app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'main', id, message: 'Continue work' }),
    });
  return { viewer, runtime, factory, main, send };
}

/** Bytes a turn added to the journal: its rows plus any content stored for the first time. */
function journalRows(store: unknown) {
  // The store holds its file exclusively; read through its own connection.
  const db = (store as { db: Database }).db;
  {
    const rows = db
      .query(
        `SELECT 'phase' AS kind, phase AS name, length(record) AS bytes FROM session_phase
         UNION ALL SELECT 'learning', json_extract(record, '$.content.decision'), length(record) FROM session_learning
         UNION ALL SELECT 'trace', id, length(record) FROM session_traces
         UNION ALL SELECT 'message', actor, length(record) FROM session_messages`,
      )
      .all() as Array<{ kind: string; name: string; bytes: number }>;
    const content = (
      db.query('SELECT coalesce(sum(length(text)), 0) AS bytes FROM session_content').get() as {
        bytes: number;
      }
    ).bytes;
    return { rows, content };
  }
}

test('a thread with 24 large Wardens survives many turns and every journal row stays under its limit', async () => {
  const f = await viewerWith(await wardenConfig(24));
  for (const turn of ['first', 'second', 'third']) {
    const response = await f.send(turn);
    expect(response.status).toBe(200);
    await f.runtime.get('main')!.learningSettled();
  }
  expect(f.main.disposed).toBe(false);
  const state = (await (await f.viewer.app.request('/api/threads/main/knowledge')).json()) as {
    status: string;
    error?: string;
  };
  expect(state.error).toBeUndefined();
  expect(state.status).toBe('durable');

  const { rows } = journalRows(f.viewer.localStore);
  const advice = rows.filter((row) => row.kind === 'phase' && row.name === 'advice');
  expect(advice).toHaveLength(3);
  for (const row of rows) {
    const limit = row.kind === 'learning' ? 100_000 : 200_000;
    expect(row.bytes).toBeLessThan(limit);
  }
  expect(rows.filter((row) => row.kind === 'learning' && row.name === 'learned').length).toBe(72);
});

test('the advice record keeps every Warden’s full input, read back by reference', async () => {
  const f = await viewerWith(await wardenConfig(24));
  expect((await f.send('only')).status).toBe(200);
  await f.runtime.get('main')!.learningSettled();
  const [advice] = f.viewer
    .localStore!.phaseHistory('main', { turnId: 'only' })
    .filter((row) => row.phase === 'advice');
  const participants = advice!.record.participants as Array<{
    domain: string;
    segments: { instructions: string; domainKnowledge: string };
    request: { messages: LLMMessage[] };
  }>;
  expect(participants).toHaveLength(24);
  for (const p of participants) {
    expect(p.segments.instructions).toContain(SHARED);
    expect(p.segments.instructions).toContain(`WARDEN_${p.domain.slice(1)}`);
    expect(p.segments.domainKnowledge).toContain(KNOWLEDGE.trim());
    expect(String(p.request.messages[0]!.content)).toContain(SHARED);
  }
});

test('repeated composed instructions are stored once, so a later turn adds little', async () => {
  const f = await viewerWith(await wardenConfig(24));
  expect((await f.send('first')).status).toBe(200);
  await f.runtime.get('main')!.learningSettled();
  const db = () => journalRows(f.viewer.localStore);
  const after1 = db();
  expect((await f.send('second')).status).toBe(200);
  await f.runtime.get('main')!.learningSettled();
  const after2 = db();
  const added =
    after2.rows.reduce((sum, row) => sum + row.bytes, 0) -
    after1.rows.reduce((sum, row) => sum + row.bytes, 0) +
    (after2.content - after1.content);
  // 24 Wardens x 60k of shared instructions would be ~1.5MB per copy; a turn stores it zero times.
  expect(added).toBeLessThan(400_000);
});

test('a relative docs source reads the thread’s own project, never the daemon’s directory', async () => {
  const root = await tempDir('foundry-docs-scope-');
  const projects: Record<string, string> = {};
  for (const id of ['P', 'Q']) {
    projects[id] = join(root, id);
    await mkdir(join(projects[id]!, 'docs'), { recursive: true });
    await writeFile(join(projects[id]!, 'docs', 'guide.md'), `# DOCS_${id}\n\n## Section ${id}\n`);
  }
  const loose = join(root, 'loose');
  await mkdir(join(loose, 'docs'), { recursive: true });
  await writeFile(join(loose, 'docs', 'notes.md'), '# DOCS_LOOSE\n');
  const bare = join(root, 'bare');
  await mkdir(bare, { recursive: true });
  const c = starterConfig('central', 'central-model');
  c.sources = {
    'docs-src': { id: 'docs-src', label: 'Docs', type: 'markdown', uri: 'docs/', enabled: true },
  };
  c.projects = {
    P: { id: 'P', path: projects.P! },
    Q: { id: 'Q', path: projects.Q! },
    Bare: { id: 'Bare', path: bare },
  };
  const source = createSourceResolver({ memory: new FileMemory(join(root, 'memory')) })(
    'docs-src',
    c,
  )!;
  // The test runs in the Foundry checkout, whose own docs/ exists: an unbound source never reads it.
  expect(await source.load()).toBe('');
  const p = await source.bind!({ threadId: 'p', projectId: 'P', cwd: loose }).load();
  expect(p).toContain('DOCS_P');
  expect(p).not.toContain('DOCS_Q');
  expect(p).not.toContain('DOCS_LOOSE');
  const q = await source.bind!({ threadId: 'q', projectId: 'Q' }).load();
  expect(q).toContain('DOCS_Q');
  expect(q).not.toContain('DOCS_P');
  // No project: the thread's working directory. A project without docs/: nothing.
  expect(await source.bind!({ threadId: 'l', cwd: loose }).load()).toContain('DOCS_LOOSE');
  expect(await source.bind!({ threadId: 'b', projectId: 'Bare' }).load()).toBe('');
});

test('a docs Warden in each project reads only that project’s docs', async () => {
  const root = await tempDir('foundry-docs-warden-');
  const c = baseConfig();
  for (const id of ['P', 'Q']) {
    const path = join(root, id);
    // Each project's region is its own: a Warden's knowledge is that project's regions, never another's.
    writeRegions(path, [{ id: 'docs', knowledge: `# DOCS_${id}\n` }]);
    c.projects[id] = { id, path };
  }
  const f = await viewerWith(c);
  const seen: Record<string, string> = {};
  for (const id of ['P', 'Q']) {
    const created = await f.viewer.app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `t-${id}`, projectId: id }),
    });
    expect(created.status).toBe(201);
    const response = await f.viewer.app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: `t-${id}`, id: `turn-${id}`, message: 'Read the docs' }),
    });
    expect(response.status).toBe(200);
    await f.runtime.get(`t-${id}`)!.learningSettled();
    const [advice] = f.viewer
      .localStore!.phaseHistory(`t-${id}`, { turnId: `turn-${id}` })
      .filter((row) => row.phase === 'advice');
    const [docs] = advice!.record.participants as Array<{ segments: { domainKnowledge: string } }>;
    seen[id] = docs!.segments.domainKnowledge;
  }
  expect(seen.P).toContain('DOCS_P');
  expect(seen.P).not.toContain('DOCS_Q');
  expect(seen.Q).toContain('DOCS_Q');
  expect(seen.Q).not.toContain('DOCS_P');
  // Never the Foundry checkout's own docs (the daemon's working directory).
  for (const text of Object.values(seen)) expect(text).not.toContain('FLOW.md');
});

test('feedback exposure finds a rule marker inside referenced composed input', async () => {
  const dir = await tempDir('foundry-journal-marker-');
  const { LocalSessionStore } = await import('../src/persistence/local-session-store');
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  cleanup.push(() => store.close());
  const thread = {
    id: 't',
    meta: { description: '', tags: [], status: 'idle' as const, createdAt: 1, lastActiveAt: 1 },
  };
  const since = Date.now();
  const marker = '<!-- feedback:item-1 -->';
  const instructions = `# Rules\n${'Keep it simple. '.repeat(200)}\n## Applied\n${marker} Never pad.\n## More\n${'Other. '.repeat(200)}`;
  store.appendPhase(thread, {
    id: 'advice-1',
    turnId: 'turn-1',
    dispatchId: null,
    phase: 'advice',
    record: {
      participants: [
        {
          domain: 'conventions',
          segments: { instructions, domainKnowledge: '', threadKnowledge: '' },
        },
        {
          domain: 'docs',
          segments: { instructions: 'Docs.', domainKnowledge: '', threadKnowledge: '' },
        },
      ],
    },
  });
  expect(store.phasesContaining(marker, since).map((row) => row.roles)).toEqual([['conventions']]);
  expect(store.phasesContaining('<!-- feedback:absent -->', since)).toEqual([]);
});

test('feedback exposure after a rule is re-applied still finds composed input stored before it', async () => {
  const dir = await tempDir('foundry-journal-reapply-');
  const { LocalSessionStore } = await import('../src/persistence/local-session-store');
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  cleanup.push(() => store.close());
  const thread = {
    id: 't',
    meta: { description: '', tags: [], status: 'idle' as const, createdAt: 1, lastActiveAt: 1 },
  };
  const marker = '<!-- feedback:item-2 -->';
  const instructions = `# Rules\n${'Keep it simple. '.repeat(200)}\n## Applied\n${marker} Never pad.\n`;
  const advice = (id: string) =>
    store.appendPhase(thread, {
      id,
      turnId: id,
      dispatchId: null,
      phase: 'advice',
      record: {
        participants: [
          {
            domain: 'conventions',
            segments: { instructions, domainKnowledge: '', threadKnowledge: '' },
          },
        ],
      },
    });
  advice('first-apply');
  // Reverted, then re-applied: the same composed text, already stored long before `since`.
  await Bun.sleep(5);
  const reapplied = Date.now() + 1;
  await Bun.sleep(5);
  advice('after-reapply');
  const rows = store.phasesContaining(marker, reapplied);
  expect(rows.map((row) => row.turnId)).toEqual(['after-reapply']);
});
