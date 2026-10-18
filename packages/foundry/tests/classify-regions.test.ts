// classify meets the chorus: a region declares its role, each stage reads a doc every region of its
// role must hold, and each doc is its own source, version and warm key.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LLMProvider, SignalBus } from '@inixiative/foundry-core';
import { FileMemory } from '../../core/src/adapters/file-memory';
import { DomainLibrarian } from '../src/agents/domain-librarian';
import {
  readRegions,
  regionDocOfSubject,
  regionDocSourceId,
  regionKey,
  regionSourceId,
} from '../src/agents/region-roster';
import { buildRoleLayers, buildStageKnowledge } from '../src/agents/role-layers';
import { createSourceResolver } from '../src/agents/thread-factory';
import { AuditLog } from '../src/audit/audit-log';
import { CompositionAuditor } from '../src/audit/compositions';
import { RECOGNISE_CHARTER, validateStages, WARDEN_CHARTER } from '../src/classify';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import {
  type FoundryConfig,
  type StageSettings,
  starterConfig,
  validateChorusSettings,
  validateConfig,
} from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { writeRegions } from './helpers/regions';

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)));
  dirs.push(d);
  return d;
};

const TWO_STAGES: StageSettings[] = [
  { task: 'recognise', doc: 'recognise.md', outcomes: 'ternary', escalate: ['yes', 'unsure'] },
  { model: 'claude-sonnet-5-5', effort: 'low' },
];

function project(chorus: Record<string, unknown> = { enabled: true }) {
  const path = temp('classify-project');
  const regions = writeRegions(path, [
    { id: 'locks', knowledge: '# Locks\n\n- createLock (CONCURRENCY.md)\n' },
    { id: 'queues', knowledge: '# Queues\n\n- makeSerializedQueue (QUEUES.md)\n' },
  ]);
  writeFileSync(join(path, '.foundry', 'project.json'), JSON.stringify({ chorus }));
  const c = starterConfig('central', 'central-model');
  c.agents = {};
  c.layers = {};
  c.sources = {};
  c.composition = { preset: 'none' };
  c.projects.P = { id: 'P', path };
  return { path, regions, config: c };
}
const recognise = (regions: string, id: string, text: string) =>
  writeFileSync(join(regions, id, 'recognise.md'), text);

test('a region declares its role (warden by default) and lists its docs; stages and charters are refused by name', () => {
  const { regions } = project();
  recognise(regions, 'locks', '# Locks\nMutual exclusion.\n');
  const [locks, queues] = readRegions(regions);
  expect(locks).toMatchObject({ id: 'locks', role: 'warden' });
  expect(Object.keys(locks!.docs).sort()).toEqual(['knowledge.md', 'recognise.md']);
  expect(Object.keys(queues!.docs)).toEqual(['knowledge.md']);
  for (const [key, value] of [
    ['stages', [{ task: 'recognise' }]],
    ['charter', 'my charter'],
  ] as const) {
    writeFileSync(
      join(regions, 'queues', 'region.json'),
      JSON.stringify({ id: 'queues', title: 'Queues', routing: 'Queues?', [key]: value }),
    );
    expect(() => readRegions(regions)).toThrow(
      `region queues at ${regions}: region.json "${key}" is not a region setting; a chorus sets its stages per role (chorus.wardens.stages), and charters are Foundry's`,
    );
  }
  writeFileSync(
    join(regions, 'queues', 'region.json'),
    JSON.stringify({ id: 'queues', title: 'Queues', routing: 'Queues?', role: 'oracle' }),
  );
  expect(() => readRegions(regions)).toThrow(/"role" must be "warden" or "herald"/);
});

test('a stage whose doc a region lacks fails the chorus build, naming the region and the doc', () => {
  const { regions, config } = project({ enabled: true, wardens: { stages: TWO_STAGES } });
  recognise(regions, 'locks', '# Locks\nMutual exclusion.\n');
  const off = resolveProjectView(config, 'P')!;
  expect(off.chorus.on).toBe(false);
  expect(off.chorus.missingDocs).toEqual([
    { region: 'queues', role: 'warden', doc: 'recognise.md', stages: [0] },
  ]);
  expect(off.chorus.reason).toStartWith(
    'the chorus is not built: region queues has no recognise.md (stage 1 of chorus.wardens.stages)',
  );
  expect(off.agents.map((a) => a.scope)).not.toContain('project-generated');

  recognise(regions, 'queues', '# Queues\nOrdering.\n');
  const on = resolveProjectView(config, 'P')!;
  expect(on.chorus).toMatchObject({
    on: true,
    roles: { warden: { from: 'repository', regions: 2 } },
  });
  expect(on.chorus.roles.warden.stages).toEqual(validateStages('s', TWO_STAGES));
  // Each doc a stage reads is its own project source; the first stage's is the Warden's knowledge.
  expect(on.config.agents.locks!.domainKnowledge).toEqual(['region:locks:recognise.md']);
  expect(Object.keys(on.config.sources).sort()).toEqual([
    'region:locks',
    'region:locks:recognise.md',
    'region:queues',
    'region:queues:recognise.md',
  ]);
  expect(on.config.projects.P!.chorus!.wardens).toEqual({ stages: TWO_STAGES });
});

test('settings resolve per role: the machine’s stages replace the repository’s whole; Herald regions do not run', () => {
  const { regions, config } = project({
    enabled: true,
    wardens: { stages: TWO_STAGES },
  });
  config.projects.P!.chorus = { wardens: { stages: [{ reason: 'inline' }] } };
  const view = resolveProjectView(config, 'P')!;
  expect(view.chorus.on).toBe(true);
  expect(view.chorus.roles.warden).toMatchObject({
    from: 'settings',
    stages: [{ reason: 'inline', doc: 'knowledge.md', task: 'point' }],
  });
  expect(view.chorus.roles.warden.stages).toHaveLength(1);
  expect(view.chorus.roles.herald).toMatchObject({ from: 'default', built: false, regions: 0 });

  writeFileSync(
    join(regions, 'queues', 'region.json'),
    JSON.stringify({ id: 'queues', title: 'Queues', routing: 'Queues?', role: 'herald' }),
  );
  const heralds = resolveProjectView(config, 'P')!;
  expect(heralds.chorus.on).toBe(true);
  expect(heralds.chorus.roles.herald).toMatchObject({ regions: 1, built: false });
  expect(heralds.chorus.reason).toBe('1 Herald region (queues) not run: Heralds are not built');
  expect(Object.keys(heralds.config.agents)).toEqual(['locks']);
});

test('project-level charter settings are refused by name; stage settings are checked where written', () => {
  expect(() => validateChorusSettings('chorus', { charter: 'mine' })).toThrow(
    /chorus.charter is not a chorus setting: charters are fixed per task and role, owned by Foundry/,
  );
  expect(() =>
    validateChorusSettings('chorus', { wardens: { stages: [{ charter: 'x' }] } }),
  ).toThrow(/chorus.wardens.stages\[0\].charter is not a setting/);
  expect(() => validateChorusSettings('chorus', { wardens: { model: 'x' } })).toThrow(
    'chorus.wardens.model is not a role setting (stages)',
  );
  expect(() =>
    validateChorusSettings('chorus', { heralds: { stages: [{ escalate: ['yes'] }] } }),
  ).toThrow(/the last stage has no next stage/);
  expect(() => validateChorusSettings('chorus', { wardens: { stages: TWO_STAGES } })).not.toThrow();
});

test('each stage composes its own doc, journals its own versions, and recomposes to its exact text', async () => {
  const { regions, config } = project({ enabled: true, wardens: { stages: TWO_STAGES } });
  recognise(regions, 'locks', '# Locks\nMutual exclusion across instances.\n');
  recognise(regions, 'queues', '# Queues\nOrdering.\n');
  const view = resolveProjectView(config, 'P')!.config as FoundryConfig;
  const memory = temp('memory');
  mkdirSync(memory, { recursive: true });
  const resolveSource = createSourceResolver({ memory: new FileMemory(memory) });
  const scope = { projectId: 'P', cwd: config.projects.P!.path };
  const slots = buildRoleLayers(view, 'locks', { resolveSource, scope });
  const second = buildStageKnowledge(
    view,
    'locks',
    'knowledge.md',
    regionDocSourceId('locks', 'knowledge.md'),
    {
      resolveSource,
      scope,
    },
  );
  await Promise.all([slots.instructions.warm(), slots.domainKnowledge.warm(), second.warm()]);
  expect(slots.domainKnowledge.content).toContain('Mutual exclusion across instances.');
  expect(second.content).toContain('- createLock (CONCURRENCY.md)');
  expect(second.id).toBe('role:locks:domainKnowledge:knowledge.md');

  const answers = [
    '{"snippets":["locks: YES — a lock"],"layers":[],"confidence":0.8}',
    'NO_COMMENT',
  ];
  const llm: LLMProvider = {
    id: 'stub',
    async complete() {
      return { content: answers.shift()!, model: 'stub' };
    },
  };
  const stages = validateStages('s', TWO_STAGES);
  const lib = new DomainLibrarian({
    domain: 'locks',
    role: 'locks',
    cache: slots.domainKnowledge,
    instructions: slots.instructions,
    signals: new SignalBus(0),
    llm,
    stages: [{ config: stages[0]! }, { config: stages[1]!, llm, cache: second }],
  });
  const requests: Array<{
    stage?: number;
    messages: readonly { content: string }[];
    composition?: unknown;
  }> = [];
  const advice = await lib.advise('Add a nightly job that never overlaps.', undefined, {
    observeRequest: (r) => requests.push(r),
  });
  // The first stage's request reaches the observer; later stages' ride on the result.
  requests.push(...(advice.stageRequests ?? []));
  expect(requests.map((r) => r.stage)).toEqual([0, 1]);
  expect(requests[0]!.messages[0]!.content).toStartWith(RECOGNISE_CHARTER);
  expect(requests[1]!.messages[0]!.content).toStartWith(WARDEN_CHARTER);

  const store = new LocalSessionStore(':memory:');
  cleanups.push(() => store.close());
  const audit = AuditLog.for(temp('classify-audit'));
  const auditor = new CompositionAuditor(audit, store);
  const versions = requests.map((r) =>
    auditor.versions('locks', r.composition as Parameters<CompositionAuditor['versions']>[1]),
  );
  // One composition per doc, each recomposing to exactly the text that stage read.
  expect(versions[0]!.domainKnowledge).not.toBe(versions[1]!.domainKnowledge);
  expect(auditor.recompose(versions[0]!.domainKnowledge)).toBe(slots.domainKnowledge.content);
  expect(auditor.recompose(versions[1]!.domainKnowledge)).toBe(second.content);
  expect(versions[0]!.instructions).toBe(versions[1]!.instructions);
  // Each stage's charter is its own version; the Warden charter keeps the auditor's own subject.
  expect(versions[0]!.charter).not.toBe(versions[1]!.charter);
  expect(versions[1]!.charter).toBe(auditor.charter());
  expect(audit.latest('charter:recognise.warden')).toBeDefined();
  // The warm key is per doc: the region, its doc, and the doc's own content hash.
  const [locks] = readRegions(regions);
  expect(versions[0]!.chorus).toEqual({
    region: 'locks',
    doc: 'recognise.md',
    key: await regionKey(locks!, 'recognise.md'),
  });
  expect(versions[1]!.chorus).toEqual({ region: 'locks', key: await regionKey(locks!) });
  expect(await regionKey(locks!, 'recognise.md')).not.toBe(await regionKey(locks!));
});

test('a doc source id names its region and doc; knowledge.md keeps the bare id', () => {
  expect(regionDocSourceId('locks', 'knowledge.md')).toBe(regionSourceId('locks'));
  expect(regionDocSourceId('locks', 'recognise.md')).toBe('region:locks:recognise.md');
  expect(regionDocOfSubject('source-content:region:locks@project:P')).toEqual({
    region: 'locks',
    doc: 'knowledge.md',
  });
  expect(regionDocOfSubject('source-content:region:locks:recognise.md@project:P')).toEqual({
    region: 'locks',
    doc: 'recognise.md',
  });
});

test('a stage list in settings is validated where it is written: refused in settings.json, reported from the repository', () => {
  const { path, config } = project();
  config.projects.P!.chorus = {
    wardens: { stages: [{ task: 'recognise', pointer: { any: false } }] },
  };
  expect(() => validateConfig(config)).toThrow(
    'projects.P.chorus.wardens.stages[0].pointer is for point stages; this one recognises',
  );
  delete config.projects.P!.chorus;
  writeFileSync(
    join(path, '.foundry', 'project.json'),
    JSON.stringify({ chorus: { enabled: true, wardens: { stages: [{ charter: 'mine' }] } } }),
  );
  const view = resolveProjectView(config, 'P')!;
  // A repository's checkout never stops the daemon: its malformed setting is reported, and ignored.
  expect(view.chorus.repository?.error).toContain(
    'chorus.wardens.stages[0].charter is not a setting',
  );
  expect(view.chorus.on).toBe(false);
});
