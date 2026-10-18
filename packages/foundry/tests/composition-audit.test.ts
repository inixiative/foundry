// Spec B (docs/THREAD-TREE.md): an audit trail for composed instructions and domain knowledge.
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CompletionOpts,
  type ContextSource,
  ContextStack,
  EventStream,
  type LLMMessage,
  type LLMProvider,
  segmentsText,
} from '@inixiative/foundry-core';
import { regionInstructions, regionSourceId } from '../src/agents/region-roster';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { AuditLog } from '../src/audit/audit-log';
import { type CallVersions, CompositionAuditor } from '../src/audit/compositions';
import { chartered, WARDEN_CHARTER } from '../src/classify';
import { contentHash } from '../src/persistence/journal-content';
import { KnowledgePersistence } from '../src/persistence/knowledge-persistence';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { instructionStackSource } from '../src/prompts/instruction-stack';
import { ConfigStore, type FoundryConfig, starterConfig } from '../src/viewer/config';
import { writeRegions } from './helpers/regions';

const REGION = {
  id: 'conventions',
  title: 'Conventions',
  routing: 'Is this about how this repo works?',
  knowledge: 'KNOWLEDGE: look for what exists first.',
};
/** The region Warden's settings prompt, as `regionWardens` generates it. */
const RULES = regionInstructions(REGION);
/** Its knowledge source, and the subject that source's text is versioned under in project P. */
const SOURCE = regionSourceId(REGION.id);
const SUBJECT = `source-content:${SOURCE}@project:P`;

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
  c.layers = {};
  c.composition = { preset: 'none' };
  c.sources = {};
  c.projects.P = { id: 'P', path: project };
  return c;
}

interface Call {
  phase: 'central' | 'pre' | 'post' | 'route';
  messages: LLMMessage[];
}

const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `foundry-${name}-`)));
  dirs.push(dir);
  return dir;
};

/** A thread whose Warden calls are journalled through the auditor, as the viewer wires it. */
async function setup(options: { retrieved?: () => string } = {}) {
  const dir = tempDir('composition-audit');
  const project = tempDir('composition-project');
  writeRegions(project, [REGION]);
  const configStore = new ConfigStore(dir);
  await configStore.save(config(project));
  const c = structuredClone(configStore.config);
  const calls: Call[] = [];
  const provider = (id: string): LLMProvider => ({
    id,
    async complete(messages: LLMMessage[], opts: CompletionOpts = {}) {
      const phase: Call['phase'] = opts.threadId?.endsWith(':cartographer')
        ? 'route'
        : opts.threadId?.includes(':review:')
          ? 'post'
          : opts.threadId?.includes(':aux:')
            ? 'pre'
            : 'central';
      calls.push({ phase, messages: structuredClone(messages) });
      return {
        model: 'controlled',
        content:
          phase === 'central'
            ? 'done'
            : phase === 'route'
              ? JSON.stringify({ layers: [], domains: [], confidence: 1 })
              : phase === 'pre'
                ? JSON.stringify({ layers: [], snippets: [], confidence: 1 })
                : 'NO_COMMENT',
      };
    },
  });
  const central = provider('central');
  const flow = provider('flow');
  const providers = new Map([central, flow].map((p) => [p.id, p]));
  const sourceResolver: SourceResolver = (id, cfg) => {
    const configured = cfg.sources[id];
    if (!configured) return null;
    if (options.retrieved && id === SOURCE) {
      const source: ContextSource = {
        id,
        focusable: true,
        load: async () => options.retrieved!(),
      };
      return source;
    }
    return {
      id,
      load: async () =>
        configured.type === 'markdown' ? Bun.file(configured.uri).text() : configured.uri,
    };
  };
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: flow,
    providers,
    log() {},
    warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
  });
  const store = new LocalSessionStore(':memory:');
  const auditor = new CompositionAuditor(configStore.audit, store, {
    settingsRevision: () => configStore.revision,
  });
  new KnowledgePersistence(manager, store, new EventStream(), [], auditor);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  configStore.onChange((next) => factory.reconfigure(next));
  cleanups.push(async () => {
    for (const runtime of manager.runtimes.values()) await runtime.learningSettled();
    manager.disposeAll();
    store.close();
  });
  const advice = (threadId: string) =>
    store
      .phaseHistory(threadId, { limit: 200 })
      .filter((p) => p.phase === 'advice')
      .map(
        (p) =>
          (
            p.record as {
              participants: Array<{
                domain: string;
                request: { versions?: CallVersions; composition?: unknown };
              }>;
            }
          ).participants.find((x) => x.domain === 'conventions')!.request,
      );
  return { dir, project, configStore, factory, store, auditor, calls, advice };
}

test('a Warden call journals the versions it was composed from, and they recompose its exact text', async () => {
  const f = await setup();
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'First turn');

  const [request] = f.advice(thread.id);
  expect(request!.composition).toBeUndefined();
  const versions = request!.versions!;
  expect(versions.instructions).toStartWith('cv_');
  expect(versions.domainKnowledge).toStartWith('cv_');

  const pre = f.calls.filter((call) => call.phase === 'pre').at(-1)!;
  expect(pre.messages[0]!.content).toBe(chartered(f.auditor.recompose(versions.instructions)));
  const knowledge = f.auditor.recompose(versions.domainKnowledge);
  expect(knowledge).toContain('## Conventions (region knowledge)');
  expect(knowledge).toContain(REGION.knowledge);
  expect(pre.messages[1]!.content).toContain(knowledge);

  // The charter is a version too: written once, by a release.
  const charter = f.configStore.audit.get(versions.charter!)!;
  expect(charter).toMatchObject({ subject: 'charter', actor: { kind: 'release' } });
  expect(f.configStore.audit.text(charter.id)).toBe(WARDEN_CHARTER);
  expect(versions.composedHash.instructions).toBe(
    contentHash(f.auditor.recompose(versions.instructions)),
  );
});

test('unchanged sources write nothing: every call names the same composition versions', async () => {
  const f = await setup();
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'one');
  const rows = f.configStore.audit.rows().length;
  await thread.dispatch('worker', 'two');
  await thread.dispatch('worker', 'three');
  const requests = f.advice(thread.id);
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map((r) => r.versions!.instructions)).size).toBe(1);
  expect(new Set(requests.map((r) => r.versions!.domainKnowledge)).size).toBe(1);
  expect(f.configStore.audit.rows()).toHaveLength(rows);
});

test("an edit to a region's knowledge is a new version: later calls name it, earlier calls keep theirs", async () => {
  const f = await setup();
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'before');
  writeFileSync(
    join(f.project, '.foundry', 'regions', REGION.id, 'knowledge.md'),
    'EDITED_KNOWLEDGE: the debounce wrapper exists.',
  );
  // A new thread composes the region as it now reads.
  const later = f.factory.create('p-later', { projectId: 'P' });
  await later.dispatch('worker', 'after');

  const [first] = f.advice(thread.id);
  const [second] = f.advice(later.id);
  expect(first!.versions!.domainKnowledge).not.toBe(second!.versions!.domainKnowledge);
  expect(f.auditor.recompose(first!.versions!.domainKnowledge)).toContain(REGION.knowledge);
  expect(f.auditor.recompose(second!.versions!.domainKnowledge)).toContain('EDITED_KNOWLEDGE');
  // The instructions did not change: one version, the generated region prompt.
  expect(first!.versions!.instructions).toBe(second!.versions!.instructions);
  expect(f.auditor.recompose(first!.versions!.instructions)).toBe(RULES);
  // The region text's versions are what was read, each detected on read.
  const rows = f.configStore.audit.rows(SUBJECT);
  expect(rows.map((row) => f.configStore.audit.text(row.id))).toEqual([
    REGION.knowledge,
    'EDITED_KNOWLEDGE: the debounce wrapper exists.',
  ]);
});

test('per-message knowledge is stored raw with each call; the composition version stays the same', async () => {
  let n = 0;
  const f = await setup({ retrieved: () => `RETRIEVED_${++n}` });
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'one');
  await thread.dispatch('worker', 'two');
  const [a, b] = f.advice(thread.id);
  expect(a!.versions!.domainKnowledge).toBe(b!.versions!.domainKnowledge);
  const texts = [a!, b!].map((r) => {
    const retrieved = r.versions!.retrieved!;
    expect(retrieved.map((x) => [x.slot, x.subject])).toEqual([['domainKnowledge', SUBJECT]]);
    return f.auditor.recompose(r.versions!.domainKnowledge, retrieved);
  });
  expect(texts[0]).toContain('RETRIEVED_');
  expect(texts[0]).not.toBe(texts[1]);
  expect(f.configStore.audit.rows(SUBJECT)).toHaveLength(0);
});

test('ladder files are attributed per file with their rung; the composed text is the file without its comments', async () => {
  const root = tempDir('composition-ladder');
  const repo = join(root, 'org', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const file = join(repo, 'CLAUDE.md');
  writeFileSync(file, 'REPO_RULES\n<!-- a note to self -->\nMORE_RULES\n');
  const source = instructionStackSource(
    'instructions',
    {
      harness: 'claude',
      home: join(root, 'home'),
      claudeConfigDir: join(root, 'home', '.claude'),
      codexHome: join(root, 'home', '.codex'),
    },
    { threadId: 't', cwd: repo },
  );
  const text = await source.load();
  const segments = source.segments!()!;
  expect(segmentsText(segments)).toBe(text);
  const part = segments.find((s) => typeof s !== 'string' && s.subject === `file:${file}`);
  expect(part).toMatchObject({ text: expect.stringContaining('MORE_RULES'), node: 'project' });
  expect(typeof part !== 'string' && part!.raw).toContain('a note to self');

  const store = new LocalSessionStore(':memory:');
  cleanups.push(() => store.close());
  const audit = AuditLog.for(tempDir('composition-ladder-audit'));
  const auditor = new CompositionAuditor(audit, store);
  // A fresh read: bun's toMatchObject writes asymmetric matchers back into the object it checked.
  const cv = auditor.record('main', 'instructions', source.segments!()!);
  expect(auditor.recompose(cv)).toBe(text);
  // The file's version is its text as read, and a change nobody reported is detected on read.
  const version = audit.latest(`file:${file}`)!;
  expect(audit.text(version.id)).toBe(readFileSync(file, 'utf8'));
  expect(version).toMatchObject({
    actor: { kind: 'external' },
    cause: { detected: 'on-read' },
    node: 'project',
  });
});

test('a committed, clean file records its commit when it changes outside Foundry', async () => {
  const repo = tempDir('composition-git');
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q');
  const file = join(repo, 'CLAUDE.md');
  writeFileSync(file, 'COMMITTED');
  git('add', 'CLAUDE.md');
  git('commit', '-qm', 'rules');
  const head = git('rev-parse', 'HEAD').stdout.toString().trim();
  const audit = AuditLog.for(tempDir('composition-git-audit'));
  expect(audit.observe(`file:${file}`, 'COMMITTED').cause).toEqual({
    detected: 'on-read',
    gitCommit: head,
  });
  writeFileSync(file, 'EDITED, NOT COMMITTED');
  expect(audit.observe(`file:${file}`, 'EDITED, NOT COMMITTED').cause).toEqual({
    detected: 'on-read',
  });
});

test('feedback exposure is found from the versions a call names, without its text', async () => {
  const store = new LocalSessionStore(':memory:');
  cleanups.push(() => store.close());
  const audit = AuditLog.for(tempDir('composition-exposure'));
  const auditor = new CompositionAuditor(audit, store);
  const exposed = auditor.record('conventions-warden', 'instructions', [
    { subject: 'file:/rules.md', text: '- merge yourself once green (fb_abc)' },
  ]);
  const other = auditor.record('conventions-warden', 'instructions', [
    { subject: 'file:/rules.md', text: '- something else' },
  ]);
  expect(store.compositionsHolding('(fb_abc)')).toEqual(new Set([exposed]));
  const thread = { id: 't1', meta: {} } as Parameters<LocalSessionStore['appendPhase']>[0];
  const row = (id: string, cv: string) =>
    store.appendPhase(thread, {
      id,
      turnId: null,
      dispatchId: null,
      phase: 'advice',
      record: {
        participants: [
          {
            domain: 'conventions',
            request: { versions: { instructions: cv, domainKnowledge: other } },
          },
        ],
      },
    });
  row('p1', exposed);
  row('p2', other);
  expect(store.phasesContaining('(fb_abc)', 0).map((r) => r.threadId)).toEqual(['t1']);
});

test('rows another process appends are read on the next lookup', () => {
  const dir = tempDir('composition-shared');
  const audit = AuditLog.for(dir);
  audit.observe('source:a', 'one');
  const line = {
    id: Bun.randomUUIDv7(),
    subject: 'source:a',
    action: 'update',
    beforeHash: null,
    afterHash: 'x',
    actor: { kind: 'user' },
    cause: {},
    createdAt: Date.now(),
    content: 'two',
  };
  writeFileSync(
    join(dir, 'audit.jsonl'),
    `${readFileSync(join(dir, 'audit.jsonl'), 'utf8')}${JSON.stringify(line)}\n`,
  );
  expect(audit.text(audit.latest('source:a')!.id)).toBe('two');
  expect(dirname(audit.path)).toBe(dir);
});

test('a snapshot read before a later change reuses the version it read: no revert rows', () => {
  const audit = AuditLog.for(tempDir('composition-late'));
  const v1 = audit.observe('file:/rules.md', 'V1');
  const v2 = audit.observe('file:/rules.md', 'V2', {
    record: true,
    actor: { kind: 'feedback', id: 'fb_1' },
    cause: { feedbackItemId: 'fb_1', changeId: 'chg_1' },
  });
  // A review admitted before the feedback line is journalled after it.
  expect(audit.observe('file:/rules.md', 'V1').id).toBe(v1.id);
  expect(audit.observe('file:/rules.md', 'V2').id).toBe(v2.id);
  expect(audit.rows('file:/rules.md')).toHaveLength(2);
  // An undo is a reported change: a row of its own even though the text is V1 again.
  const undo = audit.observe('file:/rules.md', 'V1', {
    record: true,
    actor: { kind: 'feedback', id: 'fb_1' },
  });
  expect(undo.id).not.toBe(v1.id);
  expect(undo).toMatchObject({ action: 'update', beforeHash: v2.afterHash });
});

test('a torn last line from a crashed writer never swallows the next row', () => {
  const dir = tempDir('composition-torn');
  const audit = AuditLog.for(dir);
  audit.observe('source:a', 'one');
  writeFileSync(
    join(dir, 'audit.jsonl'),
    `${readFileSync(join(dir, 'audit.jsonl'), 'utf8')}{"id":"torn`,
  );
  const next = audit.observe('source:a', 'two');
  expect(audit.get(next.id)).toBeDefined();
  expect(audit.text(next.id)).toBe('two');
});

test('the settings history file Foundry kept before is not read (hard cut)', async () => {
  const dir = tempDir('composition-legacy');
  writeFileSync(
    join(dir, 'settings-history.jsonl'),
    '{"subject":"agent:x","revision":1,"entry":{}}\n',
  );
  const store = new ConfigStore(dir);
  expect(await store.history('agent:x')).toEqual([]);
});

test('an audit failure never blocks a Warden: the call is journalled without versions', async () => {
  const f = await setup();
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  chmodSync(join(f.dir, 'audit.jsonl'), 0o400);
  try {
    await thread.dispatch('worker', 'audit is read-only');
  } finally {
    chmodSync(join(f.dir, 'audit.jsonl'), 0o600);
  }
  const [request] = f.advice(thread.id);
  expect(request).toBeDefined();
  expect(request!.versions).toBeUndefined();
  expect(request!.composition).toBeUndefined();
});
