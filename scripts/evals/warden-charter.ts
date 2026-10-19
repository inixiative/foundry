#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:evals
 */
/**
 * Score the Warden chorus against real-session probes (scripts/evals/warden-probes.ts).
 *
 *   bun scripts/evals/warden-charter.ts --probes ~/.foundry/evals/warden-probes.jsonl \
 *     [--foundry-dir ~/code/inixiative/foundry/.foundry] [--classify <run.json>] [--per-kind 40] \
 *     [--ctx inixiative | --projects template,zealot] [--period test] \
 *     [--triggers user-message,agent-action] [--concurrency 16] [--out <dir>] [--resume] \
 *     [--knowledge <alternate knowledge dir>] [--rejudge <earlier run dir>] \
 *     [--roles librarian-reuse] [--session <key>] [--budget <chars>] [--input-cap <chars>] \
 *     [--no-judge] [--regions <dir>] [--primed-sessions <n>] [--pause-at <percent>] [--model <id>] [--effort <level>]
 *     [--experiment <design.md>] [--subagents <processes>] [--stop-at-points <n>] [--stop-seven-day <percent>]
 *
 * Each Warden is composed exactly as a live thread composes it: the daemon's settings and the
 * composition view (`buildRoleLayers`), bound to the probe's project and working directory. A Warden
 * whose domain knowledge composes empty is cold there and is left out, as live. Each probe runs as
 * one turn per trigger point it recorded (`user-message` advises on the ask, `agent-action` guards the
 * agent's turn): every Warden asked at once on Haiku over the subscription, with --concurrency
 * decisions in flight; remarks are judged by Opus. Prints the primary measure (positives some Warden
 * said first), wrong remarks, silence and speak precision, scope violations and per-turn load; writes
 * every answer under --out as it lands.
 *
 * --roles asks only those Wardens. --session runs each Warden under one logical session, as a live
 * thread does, so its knowledge is primed once and read from the prompt cache. --budget and
 * --input-cap lift the role budget and the decision input cap for this run only (the size test);
 * shipped defaults never change. A probe's `threadKnowledge` reaches the Warden as live supplies it.
 * --no-judge leaves remarks unjudged for a caller that grades them its own way (warden-size.ts).
 * --primed-sessions sizes the primed pool (default under --session: the largest roster + 8, so no
 * Warden is evicted between turns). --pause-at waits out the Claude login's five-hour window while
 * it is at or above that percent; every window probe lands in <out>/quota.jsonl. --model runs the
 * Wardens on another Claude model for this run only (the model round: does a stronger model recognise
 * a domain better?); the shipped decision model stays Haiku 5.5 and the judges stay on Opus. --effort
 * sets the Wardens' reasoning effort (low | medium | high | xhigh | max, or `default` for the model's
 * own); omitted, the subscription policy's decision default applies, as live.
 *
 * --cells <file> names, per probe, the Wardens asked on it (see wardensFor).
 * --in-order runs every eligible probe in the file's order instead of the per-kind hash sample.
 * --subagents <n> serves the Wardens as subagents of n Claude side processes (agent-session
 * ClaudeSubagentSessions), each holding its share of the roster, instead of one primed process per
 * Warden: memory stays at n processes for a 70-region chorus. The composed prompts are unchanged, but
 * it is not the shipped path: agent-session gives the dispatcher process --effort, not its subagents
 * (2026-10-17 tiny test: 11 yeses vs the primed pool's 7 on the same 210 cells).
 * --stop-at-points / --stop-seven-day stop taking turns once the run's summed five-hour growth or the
 * seven-day window reaches the bound (see quotaGate); --resume continues.
 *
 * --regions <dir> scores a chorus of regions: the --projects project runs a one-layer chorus from that
 * regions directory (`<dir>/<region id>/{region.json,knowledge.md}`), so its Wardens, their
 * instructions, knowledge and charter are generated and composed exactly as a live thread of that
 * project composes them (`resolveProjectView`, `buildRoleLayers`, `WARDEN_CHARTER`). The daemon's
 * settings file is read, never written. Requires exactly one --projects entry.
 *
 * --experiment <design.md>: a run of more than three moments, or of more than one stage, refuses to start without
 * a reviewed pre-registration (foundry-core `feedback/experiment-gate.ts`, `.claude/skills/experiment/SKILL.md`);
 * the design's path and hash land in <out>/experiment.json.
 * --classify <run.json> runs the chorus under a classify configuration (packages/foundry/src/classify,
 * read by feedback/classify-run.ts): `{ "stages": [ { model?, effort?, doc?, outcomes?, reason?,
 * task?, pointer?, escalate?, deadline?, sections? } ], "members"?: "<regions dir>", "debug"?: true |
 * { "cells": "<file>" } }`, the same stages a project's `chorus.wardens.stages` takes. Eval only:
 * `sections` sets the stage's prompt language by name (its charter's sections and
 * `region-instructions`): `false`, `true`, `{ "text" }` or `{ "file" }` (relative to run.json), with
 * `"place": "before" | "after"` to inject beside the default; `debug` gives every call (or the cells
 * named) two more readings, the why inline and the why after its real answer, into debug.jsonl.
 * Every stage runs through the live call path (DomainLibrarian), each on its
 * own host (one per model and effort; a stage without either takes --model / --effort), each region
 * reading its stage's doc as a live thread composes it; a region without that doc stops the run
 * before any call, named. `members` makes --regions a grouped chorus: each region.json there names
 * its `members`, its first stage asks the group once, and every member it names goes on as that
 * region (`<members>/<id>/`) from the next stage, carrying its line; ids outside the group are
 * counted, never followed. answers.jsonl holds one row per region with its stage trace (`stages`,
 * `outcome`, each call's `systemHash`); score.json's `classify` names what each stage ran: charter
 * version, every section's source and sha256, and each region's full system-prompt hashes. A run of more than three moments,
 * or of more than one stage, needs --experiment. Live defaults are untouched.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  computeHash,
  requireExperiment,
  scoreCharterRun,
  TINY_MOMENTS,
  type WardenProbe,
  type WardenProbeAnswer,
  type WardenProbeTrigger,
  type WardenProbeTurn,
} from '../../packages/core/src';
import { FileMemory } from '../../packages/core/src/adapters/file-memory';
import { configuredExperts } from '../../packages/foundry/src/agents/configured-experts';
import {
  describeChorus,
  readRegions,
  regionDocSourceId,
  regionInstructions,
} from '../../packages/foundry/src/agents/region-roster';
import {
  buildRoleLayers,
  buildStageKnowledge,
} from '../../packages/foundry/src/agents/role-layers';
import { createSourceResolver } from '../../packages/foundry/src/agents/thread-factory';
import {
  chartered,
  charterFor,
  charterVersion,
  DEFAULT_STAGES,
  KNOWLEDGE_DOC,
  type StageConfig,
  WARDEN_CHARTER_VERSION,
  withRegionInstructions,
} from '../../packages/foundry/src/classify';
import {
  type EvalWarden,
  judge,
  markEvalRun,
  runCharterEval,
  type WardenDebug,
} from '../../packages/foundry/src/feedback/charter-eval';
import { readClassifyRun } from '../../packages/foundry/src/feedback/classify-run';
import { roleComposition } from '../../packages/foundry/src/prompts/instruction-settings';
import {
  claudeUsageWindows,
  decisionHost,
  privateDirectory,
} from '../../packages/foundry/src/providers/decision-host';
import { ConfigStore, type FoundryConfig } from '../../packages/foundry/src/viewer/config';
import { resolveProjectView } from '../../packages/foundry/src/viewer/config-resolve';
import { kindWeighted, MODEL_COST_WEIGHTS, POINTS_PER_WEIGHTED_TOKEN } from './cost-weights';

const { values } = parseArgs({
  options: {
    probes: { type: 'string' },
    'foundry-dir': { type: 'string' },
    classify: { type: 'string' },
    'per-kind': { type: 'string' },
    ctx: { type: 'string' },
    projects: { type: 'string' },
    period: { type: 'string' },
    triggers: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string' },
    resume: { type: 'boolean' },
    knowledge: { type: 'string' },
    rejudge: { type: 'string' },
    roles: { type: 'string' },
    session: { type: 'string' },
    budget: { type: 'string' },
    'input-cap': { type: 'string' },
    'no-judge': { type: 'boolean' },
    regions: { type: 'string' },
    'primed-sessions': { type: 'string' },
    subagents: { type: 'string' },
    'in-order': { type: 'boolean' },
    cells: { type: 'string' },
    'stop-at-points': { type: 'string' },
    'stop-seven-day': { type: 'string' },
    'pause-at': { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    experiment: { type: 'string' },
  },
  strict: true,
});
const positive = (flag: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw Error(`--${flag} must be a positive whole number`);
  return n;
};
const budgetOverride = positive('budget', values.budget);
const inputCap = positive('input-cap', values['input-cap']);
const primedSessionsOverride = positive('primed-sessions', values['primed-sessions']);
const pauseAt = positive('pause-at', values['pause-at']);
const subagentProcesses = positive('subagents', values.subagents);
const stopAtPoints = positive('stop-at-points', values['stop-at-points']);
const stopSevenDay = positive('stop-seven-day', values['stop-seven-day']);
const wardenModel = values.model ?? 'claude-haiku-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const;
const wardenEffort = values.effort as (typeof EFFORTS)[number] | undefined;
if (wardenEffort !== undefined && !EFFORTS.includes(wardenEffort))
  throw Error(`--effort must be one of ${EFFORTS.join(', ')}`);
/** --classify: the run's stages, each stage's charter as its sections set it, and debug. */
const runConfig = values.classify ? readClassifyRun(values.classify) : undefined;
const stages: readonly StageConfig[] = runConfig?.stages ?? DEFAULT_STAGES;
/** The stages as a project's settings write them: the eval-only `sections` left out. */
const settingsStages = runConfig?.settingsStages;
const charters: readonly (string | undefined)[] = runConfig?.charters ?? [];
const debug = runConfig?.debug ?? false;
const membersDir = runConfig?.members;
if ((stages.length > 1 || membersDir) && !values.regions)
  throw Error(
    '--classify with more than one stage, or with members, runs a regions chorus: pass --regions',
  );
/** A stage's model and effort: its own, else the run's (--model / --effort). */
const modelOf = (stage: StageConfig) => stage.model ?? wardenModel;
const effortOf = (stage: StageConfig) => stage.effort ?? wardenEffort;

const onlyRoles = values.roles?.split(',').filter(Boolean);
if (!values.probes) {
  console.error('usage: warden-charter.ts --probes <jsonl> [--foundry-dir <daemon .foundry dir>]');
  process.exit(2);
}
const ctx = values.ctx ?? 'inixiative';
const projects = values.projects?.split(',').filter(Boolean);
const perKind = Number(values['per-kind'] ?? 40);
const triggers = (values.triggers ?? 'agent-action').split(',') as WardenProbeTrigger[];
for (const t of triggers)
  if (t !== 'user-message' && t !== 'agent-action') throw Error(`unknown trigger ${t}`);
if (values.regions && projects?.length !== 1)
  throw Error('--regions needs exactly one --projects entry: the project whose regions these are');
const label = runConfig
  ? `charter-classify-${runConfig.hash}`
  : values.regions
    ? 'charter-regions'
    : 'charter-shipped';
const out = values.out ?? join(homedir(), '.foundry', 'evals', `charter-${label}-${Date.now()}`);
if (resolve(out).startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) {
  console.error('--out must be outside the repository: answers hold session text');
  process.exit(2);
}
privateDirectory(out);

/** A stable sample: the same probes for every charter, so runs compare. */
const rank = (id: string) => Number(BigInt(Bun.hash(id)) % 1_000_000n);
const all = readFileSync(values.probes, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as WardenProbe);
const eligible = all.filter(
  (p) =>
    (!values.period || p.period === values.period) &&
    (projects
      ? !!p.project && projects.includes(p.project)
      : p.ctx === ctx || (ctx === 'inixiative' && p.ctx === 'personal')),
);
const pick = (kind: string, project?: string) =>
  eligible
    .filter((p) => p.kind === kind && (!project || p.project === project))
    .sort((a, b) => rank(a.id) - rank(b.id))
    .slice(0, perKind);
// --in-order: every eligible probe in the file's order (a caller's own sample, e.g. Oracle's slices),
// so a run stopped early on quota is a prefix of that order rather than all positives first.
const probes = values['in-order']
  ? eligible
  : (projects ?? [undefined]).flatMap((project) => [
      ...pick('positive', project),
      ...pick('negative', project),
    ]);
const experiment = requireExperiment(
  values.experiment,
  probes.length > TINY_MOMENTS || stages.length > 1,
);
if (experiment) writeFileSync(join(out, 'experiment.json'), JSON.stringify(experiment, null, 1));

// The chorus, composed as live from the daemon's settings and composition view.
const foundryDir = resolve(
  values['foundry-dir'] ?? join(homedir(), 'code', 'inixiative', 'foundry', '.foundry'),
);
const config = await new ConfigStore(foundryDir).load();
const resolveSource = createSourceResolver({ memory: new FileMemory(join(foundryDir, 'memory')) });
/** The registered project a probe's project name (its directory's basename) refers to. */
const projectEntry = (name: string | undefined) =>
  Object.entries(config.projects ?? {}).find(([, p]) => name && basename(p.path ?? '') === name);
if (values.regions) {
  const entry = projectEntry(projects![0]);
  if (!entry) throw Error(`--regions: project ${projects![0]} is not registered in ${foundryDir}`);
  // In memory only: this run's view of the project runs a one-layer chorus from --regions, under the
  // run's stages (a grouped chorus checks only its first stage's doc: later stages read the members).
  const first = settingsStages?.[0];
  const roleStages = membersDir
    ? first
      ? [(({ escalate: _e, deadline: _d, ...stage }) => stage)(first)]
      : undefined
    : settingsStages;
  entry[1].chorus = {
    enabled: true,
    regions: resolve(values.regions),
    ...(roleStages ? { wardens: { stages: roleStages } } : {}),
  };
  const view = resolveProjectView(config, entry[0])!;
  if (!view.chorus.on) throw Error(`--regions: ${view.chorus.reason}`);
  console.error(describeChorus(projects![0]!, view.chorus));
}
/** The config a thread of `projectId` composes under: its project view (its region Wardens included), else the global settings (no Wardens). */
const viewOf = (projectId: string | undefined): FoundryConfig =>
  (projectId ? resolveProjectView(config, projectId)?.config : undefined) ?? config;
const rosterOf = (projectId: string | undefined) => {
  const roster = configuredExperts(viewOf(projectId)).experts.filter(
    (r) => !onlyRoles || onlyRoles.includes(r.agentId),
  );
  if (onlyRoles && roster.length !== onlyRoles.length)
    throw Error(`--roles names Wardens not in the roster: ${onlyRoles.join(', ')}`);
  return roster;
};
/** The project and working directory a probe's thread would have run in. */
const placeOf = (probe: WardenProbe): { projectId?: string; cwd: string } => {
  const entry = projectEntry(probe.project);
  if (entry?.[1].path) return { projectId: entry[0], cwd: entry[1].path };
  return {
    cwd:
      probe.ctx === 'userevidence'
        ? join(homedir(), 'code', 'zealot')
        : join(homedir(), 'code', 'inixiative'),
  };
};
/**
 * --knowledge <dir>: score another knowledge set (e.g. the catalog) against the same probes. A role's
 * `<dir>/<project>/<role>/domainKnowledge.md`, else `<dir>/<role>/domainKnowledge.md`, replaces its
 * composed domain knowledge; roles without a file keep the live composition. An `instructions.md`
 * beside it replaces the composed instructions the same way (e.g. a region Warden's).
 */
const alternate = (
  file: 'domainKnowledge.md' | 'instructions.md',
  role: string,
  project?: string,
): string | undefined => {
  if (!values.knowledge) return undefined;
  const dir = resolve(values.knowledge);
  for (const path of [...(project ? [join(dir, project, role, file)] : []), join(dir, role, file)])
    if (existsSync(path)) return readFileSync(path, 'utf8');
  return undefined;
};
/** --classify members: the region ids a group recogniser holds (its region.json `members`), else itself. */
const membersOf = (recogniser: string): string[] => {
  const meta = join(resolve(values.regions!), recogniser, 'region.json');
  const members = existsSync(meta)
    ? (JSON.parse(readFileSync(meta, 'utf8')) as { members?: unknown }).members
    : undefined;
  return Array.isArray(members) && members.every((m) => typeof m === 'string')
    ? members
    : [recogniser];
};
const composed = new Map<string, EvalWarden[]>();
const cold = new Map<string, string[]>();
/** The docs a region's later stages read: a grouped chorus's members hold them, not its groups. */
const laterDocs = stages.slice(1).map((s) => s.doc);
/** The docs a region's own stages read beside its knowledge.md, composed as live composes them. */
const ownDocs = [...new Set((membersDir ? stages.slice(0, 1) : stages).map((s) => s.doc))].filter(
  (doc) => doc !== KNOWLEDGE_DOC,
);
for (const probe of probes) {
  const place = placeOf(probe);
  const key = `${place.projectId ?? ''}|${place.cwd}`;
  if (composed.has(key)) continue;
  const wardens: EvalWarden[] = [];
  const view = viewOf(place.projectId);
  for (const { agentId, domain } of rosterOf(place.projectId)) {
    const slots = buildRoleLayers(view, agentId, { resolveSource, scope: place });
    await Promise.all([slots.instructions.warm(), slots.domainKnowledge.warm()]);
    const knowledge =
      alternate('domainKnowledge.md', agentId, probe.project) ?? slots.domainKnowledge.content;
    if (!knowledge.trim()) {
      cold.set(key, [...(cold.get(key) ?? []), domain]);
      continue;
    }
    const instructions =
      alternate('instructions.md', agentId, probe.project) ?? slots.instructions.content;
    const budget = budgetOverride ?? roleComposition(view.composition, agentId).budget;
    const docs: Record<string, string> = {};
    for (const doc of ownDocs) {
      const layer = buildStageKnowledge(view, agentId, doc, regionDocSourceId(agentId, doc), {
        resolveSource,
        scope: place,
      });
      await layer.warm();
      docs[doc] = layer.content;
    }
    const members = membersDir ? membersOf(agentId) : undefined;
    wardens.push({
      domain,
      instructions,
      domainKnowledge: knowledge,
      ...(Object.keys(docs).length ? { docs } : {}),
      ...(members ? { members } : {}),
      budget,
      ...(values.session ? { session: `${values.session}:${agentId}` } : {}),
    });
  }
  composed.set(key, wardens);
}
const placeKey = (probe: WardenProbe) => {
  const place = placeOf(probe);
  return `${place.projectId ?? ''}|${place.cwd}`;
};
/**
 * --cells <file>: `{ "<probe id>": ["<domain>", …] }`, the Wardens to ask on that probe (others are
 * not asked; a probe absent from the file asks every Warden). Each call is its own fresh decision,
 * so asking a subset changes no answer; it lets an eval spend calls where they are scored (Oracle's
 * per-region slices). Not routing: nothing here sees the moment.
 */
const cells = values.cells
  ? (JSON.parse(readFileSync(values.cells, 'utf8')) as Record<string, string[]>)
  : undefined;
const wardensFor = (probe: WardenProbe): EvalWarden[] => {
  const all = composed.get(placeKey(probe)) ?? [];
  const only = cells?.[probe.id];
  return only ? all.filter((w) => only.includes(w.domain)) : all;
};
/**
 * --classify members: the member regions a grouped chorus fans out to, by id, each reading its later
 * stages' docs from its own folder. A member missing a doc a later stage reads stops the run, named.
 */
const memberWardens = new Map<string, EvalWarden>();
if (membersDir) {
  for (const region of readRegions(membersDir)) {
    const docs: Record<string, string> = {};
    for (const doc of new Set(laterDocs)) {
      const path = doc === KNOWLEDGE_DOC ? region.knowledgePath : region.docs[doc]?.path;
      if (!path) throw Error(`--classify members: region ${region.id} has no ${doc}`);
      docs[doc] = readFileSync(path, 'utf8');
    }
    memberWardens.set(region.id, {
      domain: region.id,
      instructions: regionInstructions(region),
      domainKnowledge: readFileSync(region.knowledgePath, 'utf8'),
      docs,
      ...(budgetOverride !== undefined ? { budget: budgetOverride } : {}),
      ...(values.session ? { session: `${values.session}:member:${region.id}` } : {}),
    });
  }
  if (!memberWardens.size) throw Error(`--classify members ${membersDir} holds no regions`);
}
// A stage that sets the region line needs every Warden's instructions to open with it: checked here,
// before any call, so a mismatch stops the run instead of failing every call.
for (const [i, line] of (runConfig?.regionInstructions ?? []).entries()) {
  if (line === undefined) continue;
  for (const w of [...[...composed.values()].flat(), ...memberWardens.values()])
    try {
      withRegionInstructions(w.instructions, line);
    } catch (err) {
      throw Error(
        `--classify stages[${i}].sections.region-instructions: ${w.domain}: ${(err as Error).message}`,
      );
    }
}
const describeStages = stages
  .map((s, i) => {
    const charter = runConfig?.charterSources[i];
    const line = runConfig?.regionInstructionSources[i];
    const changed = [...(charter?.sections ?? []), ...(line ? [line] : [])].filter(
      (c) => c.source !== 'default',
    );
    return `stage ${i + 1} ${modelOf(s)} ${effortOf(s) ?? 'low'} ${s.task} ${s.doc} ${s.outcomes} reason:${s.reason} charter ${charter?.version ?? charterVersion(charterFor(s.task, 'warden', s.pointer).text)}${changed.length ? ` (sections ${changed.map((c) => `${c.name}:${c.source}${c.place ? `-${c.place}` : ''}`).join(', ')})` : ''}`;
  })
  .join('; ');
if (runConfig)
  console.error(
    `classify: ${describeStages}${membersDir ? `; members ${membersDir}` : ''}${debug ? `; debug: two more readings per call${debug === true ? '' : ` on the cells in ${debug.file}`}` : ''}`,
  );

/**
 * Per Warden and stage, sha256 of the full system message the run sends, as DomainLibrarian builds
 * it (the stage's charter above the Warden's instructions, its region line set): the same hash each
 * staged call's trace carries (`systemHash`). A grouped chorus's groups send stage 1, members the rest.
 */
const systemPrompts = () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const of = (w: EvalWarden, indices: readonly number[]) =>
    Object.fromEntries(
      indices.map((i) => {
        const s = stages[i]!;
        const line = runConfig?.regionInstructions[i];
        const system =
          line === undefined ? w.instructions : withRegionInstructions(w.instructions, line);
        return [
          i,
          hash(chartered(system, charters[i] ?? charterFor(s.task, 'warden', s.pointer).text)),
        ];
      }),
    );
  const all = stages.map((_s, i) => i);
  const prompts: Record<string, Record<number, string>> = {};
  for (const w of [...composed.values()].flat())
    prompts[w.domain] ??= of(w, membersDir ? [0] : all);
  for (const w of memberWardens.values()) prompts[w.domain] ??= of(w, all.slice(1));
  return prompts;
};

const scoreByProject = (answers: readonly WardenProbeAnswer[], turns: readonly WardenProbeTurn[]) =>
  Object.fromEntries(
    (projects ?? []).map((project) => {
      const mine = probes.filter((p) => p.project === project);
      const ids = new Set(mine.map((p) => p.id));
      return [
        project,
        scoreCharterRun(
          mine,
          answers.filter((a) => ids.has(a.probeId)),
          turns.filter((t) => ids.has(t.probeId)),
        ),
      ];
    }),
  );

/**
 * --rejudge <run dir>: judge an earlier run's remarks again against the probes as they are now (e.g.
 * once targets are labelled), without asking any Warden again. Writes answers.rejudged.jsonl and
 * score.rejudged.json there.
 */
if (values.rejudge) {
  const run = resolve(values.rejudge);
  const rows = <T>(file: string): T[] =>
    readFileSync(join(run, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  const earlier = rows<WardenProbeAnswer>('answers.jsonl');
  const turns = rows<WardenProbeTurn>('turns.jsonl');
  const byId = new Map(all.map((p) => [p.id, p]));
  const judges = decisionHost(
    'claude-opus-5-5',
    'claude',
    4,
    privateDirectory(join(homedir(), '.foundry', 'evals')),
  );
  markEvalRun(join(homedir(), '.foundry', 'evals'));
  try {
    const answers: WardenProbeAnswer[] = [];
    for (const a of earlier) {
      const probe = byId.get(a.probeId);
      if (!probe || a.noComment || a.error || !a.text) {
        answers.push(a);
        continue;
      }
      const warden = wardensFor(probe).find((w) => w.domain === a.domain);
      const judged = await judge(judges.provider, {
        domain: a.domain,
        domainDescription: warden?.instructions.slice(0, 1200) ?? '',
        moment: probe.moment,
        ...(probe.ask ? { ask: probe.ask } : {}),
        trigger: a.trigger ?? 'agent-action',
        ...(probe.gold?.target ? { target: probe.gold.target } : {}),
        remark: a.text,
        hidden: probe.hidden ?? '',
      });
      const { judged: _old, ...rest } = a;
      answers.push(judged ? { ...rest, judged } : rest);
    }
    const asked = probes.filter((p) => turns.some((t) => t.probeId === p.id));
    const score = scoreCharterRun(asked, answers, turns);
    writeFileSync(
      join(run, 'answers.rejudged.jsonl'),
      answers.map((a) => `${JSON.stringify(a)}\n`).join(''),
      { mode: 0o600 },
    );
    writeFileSync(
      join(run, 'score.rejudged.json'),
      JSON.stringify(
        { probesFile: values.probes, score, byProject: scoreByProject(answers, turns) },
        null,
        1,
      ),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ ...score, byProject: scoreByProject(answers, turns) }, null, 1));
  } finally {
    await judges.shutdown();
  }
  process.exit(0);
}

const concurrency = Number(values.concurrency ?? 16);
// An eval run, not work: Archive and the repeat report leave its sessions out.
const state = privateDirectory(join(homedir(), '.foundry', 'evals'));
markEvalRun(state);
/**
 * Under --session every Warden holds one primed key; a pool smaller than the roster evicts and
 * re-primes cold every turn. Sized as the daemon sizes its pool for its largest roster.
 */
const largestComposed = Math.max(0, ...[...composed.values()].map((w) => w.length));
const primedSessions =
  primedSessionsOverride ?? (values.session ? Math.max(16, largestComposed + 8) : undefined);
// --subagents <n>: the roster's Wardens as subagents of n side processes, each holding its share.
const subagents = subagentProcesses
  ? {
      processes: subagentProcesses,
      membersPerProcess: Math.max(1, Math.ceil(largestComposed / subagentProcesses)),
    }
  : undefined;
/** One decision host per model and effort, shared by the stages that name the same pair. */
const hosts = new Map<string, ReturnType<typeof decisionHost>>();
const hostOf = (model: string, effort: (typeof EFFORTS)[number] | undefined) => {
  const key = `${model}|${effort ?? ''}`;
  let host = hosts.get(key);
  if (!host) {
    host = decisionHost(model, 'claude', concurrency, state, {
      ...(inputCap !== undefined ? { inputCap } : {}),
      ...(subagents ? { subagents } : primedSessions !== undefined ? { primedSessions } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
    hosts.set(key, host);
  }
  return host;
};
const wardens = hostOf(modelOf(stages[0]!), effortOf(stages[0]!));
const stageProviders = stages.map((s) => hostOf(modelOf(s), effortOf(s)).provider);
if (subagents)
  console.error(
    `subagent pool: ${subagents.processes} processes x ${subagents.membersPerProcess} Wardens`,
  );
else if (primedSessions !== undefined) console.error(`primed sessions: ${primedSessions}`);
console.error(`warden model: ${wardenModel}, effort: ${wardenEffort ?? 'policy default (low)'}`);
/**
 * --pause-at <percent>: before a turn, while the Claude login's five-hour window is at or above it,
 * wait (10 min between checks; the window is probed at most every 2 min). Every probe of the window
 * is appended to <out>/quota.jsonl with the machine's load, so the run's quota cost can be read off.
 */
const quotaFile = join(out, 'quota.jsonl');
let lastWindowCheck = 0;
const recordWindow = async (phase: string) => {
  const windows = await claudeUsageWindows(state);
  lastWindowCheck = Date.now();
  appendFileSync(
    quotaFile,
    `${JSON.stringify({ at: new Date().toISOString(), phase, windows, load: Bun.spawnSync(['uptime']).stdout.toString().trim() })}\n`,
    { mode: 0o600 },
  );
  return windows;
};
/**
 * --stop-at-points <n> / --stop-seven-day <percent>. The run's spend is counted two ways, in code:
 * its own tokens, weighted by kind and model and converted with the calibrated coefficient
 * (`cost-weights.ts`), checked before every turn; and the five-hour window's growth from the run's
 * first reading (a reset adds the new window's reading), read at most every 30 s. The run stops
 * taking turns once its tokens reach n points, or the window's growth reaches n + WINDOW_SLACK (the
 * window reads in whole points and counts every session on the login, so it is a backstop, not the
 * meter), or the seven-day window reaches the percent. It fails closed when the window cannot be read
 * twice running; a turn the stop lands on is not asked. --resume continues a stopped run.
 */
const WINDOW_SLACK = 2;
let stopped: string | undefined;
let spentPoints = 0;
let tokenPoints = 0;
let lastFiveHour: number | undefined;
let unreadable = 0;
const bounded = () => stopAtPoints !== undefined || stopSevenDay !== undefined;
/** A row's tokens at its model's weight: a staged row per stage, at each stage's model. */
const countTokens = (answer: WardenProbeAnswer) => {
  if (answer.stages?.length) {
    for (const trace of answer.stages)
      if (trace.tokens)
        weigh(trace.tokens, trace.model ?? modelOf(stages[trace.stage] ?? stages[0]!));
    return;
  }
  if (answer.tokens) weigh(answer.tokens, wardenModel);
};
/** A debug row's two readings at the stage's model: the live call is already counted with its answer. */
const countDebugTokens = (row: WardenDebug) => {
  const model = modelOf(stages[row.stage] ?? stages[0]!);
  for (const reading of [row.inline, row.after]) if (reading.tokens) weigh(reading.tokens, model);
};
const weigh = (t: NonNullable<WardenProbeAnswer['tokens']>, model: string) => {
  const kinds = {
    input: t.input ?? 0,
    cacheRead: t.cacheRead ?? 0,
    cacheWrite: t.cacheWrite ?? 0,
    output: t.output ?? 0,
    thinking: t.thinking ?? 0,
  };
  tokenPoints += kindWeighted(kinds) * (MODEL_COST_WEIGHTS[model] ?? 1) * POINTS_PER_WEIGHTED_TOKEN;
};
const checkSpend = () => {
  if (stopAtPoints !== undefined && tokenPoints >= stopAtPoints)
    stopped ??= `token spend ${tokenPoints.toFixed(2)} >= ${stopAtPoints} points`;
  if (stopAtPoints !== undefined && spentPoints >= stopAtPoints + WINDOW_SLACK)
    stopped ??= `five-hour window growth ${spentPoints} >= ${stopAtPoints} + ${WINDOW_SLACK} points`;
};
const spend = (windows: Record<string, number> | undefined) => {
  if (!bounded()) return;
  const now = windows?.five_hour;
  // Fail closed: a bound that cannot be read twice running stops the run.
  if (now === undefined) {
    if (++unreadable >= 2) stopped ??= 'the five-hour window could not be read twice running';
  } else {
    unreadable = 0;
    spentPoints += lastFiveHour === undefined ? 0 : now >= lastFiveHour ? now - lastFiveHour : now;
    lastFiveHour = now;
  }
  checkSpend();
  const sevenDay = windows?.seven_day;
  if (stopSevenDay !== undefined && sevenDay !== undefined && sevenDay >= stopSevenDay)
    stopped ??= `seven-day window ${sevenDay}% >= ${stopSevenDay}%`;
};
const quotaGate = async () => {
  if (bounded()) {
    checkSpend();
    if (!stopped && Date.now() - lastWindowCheck >= 30_000) spend(await recordWindow('spend'));
    if (stopped) console.error(`${new Date().toISOString()} stopping: ${stopped}`);
  }
  if (pauseAt === undefined) return;
  if (Date.now() - lastWindowCheck < 120_000) return;
  for (;;) {
    const windows = await recordWindow('gate');
    const used = windows?.five_hour;
    if (used === undefined || used < pauseAt) return;
    console.error(`${new Date().toISOString()} five-hour window at ${used}%: pausing 10 min`);
    await Bun.sleep(600_000);
  }
};
spend(await recordWindow('start'));
const judges = values['no-judge'] ? undefined : decisionHost('claude-opus-5-5', 'claude', 4, state);
const started = Date.now();
const answersFile = join(out, 'answers.jsonl');
const turnsFile = join(out, 'turns.jsonl');
const debugFile = join(out, 'debug.jsonl');
const readRows = <T>(path: string): T[] =>
  values.resume && existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
// --resume keeps the turns an earlier run finished (recorded in turns.jsonl once judged) and redoes the rest.
const turnKey = (probeId: string, trigger: WardenProbeTrigger = 'agent-action') =>
  `${probeId}|${trigger}`;
const keptTurns = readRows<WardenProbeTurn>(turnsFile);
const finished = new Set(keptTurns.map((t) => turnKey(t.probeId, t.trigger)));
const kept = readRows<WardenProbeAnswer>(answersFile).filter((a) =>
  finished.has(turnKey(a.probeId, a.trigger)),
);
const writeRows = (path: string, rows: readonly unknown[]) => {
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  chmodSync(path, 0o600);
};
writeRows(answersFile, kept);
writeRows(turnsFile, keptTurns);
if (debug)
  writeRows(
    debugFile,
    readRows<WardenDebug>(debugFile).filter((d) => finished.has(turnKey(d.probeId, d.trigger))),
  );
if (values.resume) console.error(`resuming: ${finished.size} turns already done`);
let done = 0;
try {
  const run = await runCharterEval({
    probes,
    wardensFor,
    warden: wardens.provider,
    stageProviders,
    stages,
    charters,
    ...(runConfig ? { regionInstructions: runConfig.regionInstructions } : {}),
    ...(membersDir
      ? { memberWarden: (_probe: WardenProbe, id: string) => memberWardens.get(id) }
      : {}),
    ...(judges ? { judge: judges.provider } : {}),
    concurrency,
    triggers,
    done: (probeId, trigger) => !!stopped || finished.has(turnKey(probeId, trigger)),
    beforeTurn: quotaGate,
    onTurn: (turn) => appendFileSync(turnsFile, `${JSON.stringify(turn)}\n`),
    ...(debug
      ? {
          onDebug: (row: WardenDebug) => {
            appendFileSync(debugFile, `${JSON.stringify(row)}\n`);
            countDebugTokens(row);
          },
          ...(debug !== true
            ? {
                debugCell: (probeId: string, domain: string) =>
                  !!debug.cells[probeId]?.includes(domain),
              }
            : {}),
        }
      : {}),
    onAnswer: (answer) => {
      appendFileSync(answersFile, `${JSON.stringify(answer)}\n`);
      countTokens(answer);
      if (++done % 50 === 0)
        console.error(`  ${done} answers (${Math.round((Date.now() - started) / 1000)}s)`);
    },
  });
  const answers = [...kept, ...run.answers];
  const turns = [...keptTurns, ...run.turns];
  const score = scoreCharterRun(probes, answers, turns);
  const byProject = scoreByProject(answers, turns);
  // --classify: what each stage ran, and how the stages' answers went (malformed, fallbacks, ids).
  const classify = runConfig
    ? {
        config: runConfig.path,
        configHash: runConfig.hash,
        members: membersDir ?? null,
        debug: debug === false || debug === true ? debug : { cells: debug.file },
        // Per (region, stage): sha256 of the full system message the run sends (charter above
        // instructions), so arms that change any section, the region line included, are told apart.
        systemPrompts: systemPrompts(),
        stages: stages.map((s, i) => ({
          index: i,
          model: modelOf(s),
          effort: effortOf(s) ?? 'low',
          task: s.task,
          doc: s.doc,
          outcomes: s.outcomes,
          reason: s.reason,
          ...(s.pointer ? { pointer: s.pointer } : {}),
          ...(s.escalate ? { escalate: s.escalate } : {}),
          ...(s.deadline !== undefined ? { deadline: s.deadline } : {}),
          charter: runConfig.charterSources[i]!.changed
            ? runConfig.charterSources[i]!.version
            : null,
          charterVersion: runConfig.charterSources[i]!.version,
          sections: runConfig.charterSources[i]!.sections,
          regionInstructions: runConfig.regionInstructionSources[i]!,
          asked: answers.filter((a) => a.stages?.[i]).length,
          malformed: answers.filter((a) => a.stages?.[i]?.malformed).length,
          timedOut: answers.filter((a) => a.stages?.[i]?.timedOut).length,
          unknownRegions: answers.reduce(
            (n, a) => n + (a.stages?.[i]?.unknownRegions?.length ?? 0),
            0,
          ),
        })),
        fallbacks: answers.filter(
          (a) => a.stages?.length && a.stages.some((t) => t.timedOut || (t.stage > 0 && t.error)),
        ).length,
        unsure: score.unsure,
      }
    : undefined;
  writeFileSync(
    join(out, 'score.json'),
    JSON.stringify(
      {
        charter: label,
        charterVersion: runConfig ? null : WARDEN_CHARTER_VERSION,
        probesFile: values.probes,
        ctx: projects ? undefined : ctx,
        projects,
        period: values.period,
        triggers,
        perKind,
        foundryDir,
        knowledge: values.knowledge,
        session: values.session,
        model: wardenModel,
        effort: wardenEffort ?? 'low',
        thinkingTokens: process.env.MAX_THINKING_TOKENS,
        classify,
        budget: budgetOverride,
        inputCap,
        roster: [...new Set([...composed.values()].flat().map((w) => w.domain))],
        cold: Object.fromEntries(cold),
        score,
        byProject,
        elapsedMs: Date.now() - started,
      },
      null,
      1,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      { charter: label, ...score, byProject, ...(classify ? { classify } : {}) },
      null,
      1,
    ),
  );
  console.log(`answers: ${out}`);
} finally {
  for (const host of hosts.values()) await host.shutdown();
  await judges?.shutdown();
  spend(await recordWindow('end'));
  if (bounded())
    console.error(
      `five-hour spend: ${spentPoints} points (window), ${tokenPoints.toFixed(2)} points (tokens)${stopped ? `; stopped early (${stopped}), --resume continues` : ''}`,
    );
}
