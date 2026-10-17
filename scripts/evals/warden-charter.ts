#!/usr/bin/env bun
/**
 * Score the Warden chorus against real-session probes (scripts/evals/warden-probes.ts).
 *
 *   bun scripts/evals/warden-charter.ts --probes ~/.foundry/evals/warden-probes.jsonl \
 *     [--foundry-dir ~/code/inixiative/foundry/.foundry] [--charter <file>] [--per-kind 40] \
 *     [--ctx inixiative | --projects template,zealot] [--period test] \
 *     [--triggers user-message,agent-action] [--concurrency 16] [--out <dir>] [--resume] \
 *     [--knowledge <alternate knowledge dir>] [--rejudge <earlier run dir>] \
 *     [--roles librarian-reuse] [--session <key>] [--budget <chars>] [--input-cap <chars>] \
 *     [--no-judge] [--regions <dir>] [--primed-sessions <n>] [--pause-at <percent>] [--model <id>] [--effort <level>]
 *     [--experiment <design.md>] [--subagents <processes>] [--stop-at-points <n>] [--stop-seven-day <percent>]
 *     [--pipeline --recognise-charter <file> --pick-charter <file> [--pick-regions <dir>] [--pick-model <id>] [--pick-effort <level>]]
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
 * --experiment <design.md>: a run of more than three moments, or --pipeline, refuses to start without
 * a reviewed pre-registration (foundry-core `feedback/experiment-gate.ts`, `.claude/skills/experiment/SKILL.md`);
 * the design's path and hash land in <out>/experiment.json.
 * --pipeline is the two-stage EXPERIMENT (not Foundry's design): stage 1, every region Warden on
 * --model/--effort (Haiku low) under the --recognise-charter file, holding the region's `recognise.md`
 * when the regions directory has one (else its knowledge.md; score.json names those); its remark names
 * regions, one `region <id>: <why>` per line, parsed here (unparsable lines and unknown ids are
 * counted, never guessed). Stage 2, once per named region, the same region on --pick-model/--pick-effort
 * (Sonnet low) under the --pick-charter file, holding knowledge.md, given the recogniser's line as
 * thread context. Stage 1 lands in answers.jsonl/turns.jsonl, stage 2 in answers.pick.jsonl/
 * turns.pick.jsonl; the report (warden-charter-report.ts) scores stage 1, stage 2 and the roll-up from
 * the one run. The charters live under ~/.foundry/evals/experiments/, not in Foundry; shipped defaults
 * are untouched.
 *
 * --pick-regions <dir> draws the stage-2 pickers from that regions directory by region id
 * (`<dir>/<id>/{region.json,knowledge.md}`), independent of the stage-1 chorus, so a grouped stage 1
 * (`warden-groups.ts build`) hands each named member to its own full-catalog picker. A stage-1 id is
 * valid when it is one of its recogniser's members (`members` in the group's region.json; a plain
 * region holds itself); others count as unknown, never guessed (`pipeline-dispatch.ts`). Without it,
 * the pickers are the stage-1 chorus's own regions holding their knowledge.md.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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
  regionInstructions,
} from '../../packages/foundry/src/agents/region-roster';
import { buildRoleLayers } from '../../packages/foundry/src/agents/role-layers';
import { createSourceResolver } from '../../packages/foundry/src/agents/thread-factory';
import { WARDEN_CHARTER } from '../../packages/foundry/src/agents/warden-charter';
import {
  type EvalWarden,
  judge,
  markEvalRun,
  runCharterEval,
} from '../../packages/foundry/src/feedback/charter-eval';
import { roleComposition } from '../../packages/foundry/src/prompts/instruction-settings';
import {
  claudeUsageWindows,
  decisionHost,
  privateDirectory,
} from '../../packages/foundry/src/providers/decision-host';
import { ConfigStore, type FoundryConfig } from '../../packages/foundry/src/viewer/config';
import { resolveProjectView } from '../../packages/foundry/src/viewer/config-resolve';
import { dispatch } from './pipeline-dispatch';

const { values } = parseArgs({
  options: {
    probes: { type: 'string' },
    'foundry-dir': { type: 'string' },
    charter: { type: 'string' },
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
    pipeline: { type: 'boolean' },
    'recognise-charter': { type: 'string' },
    'pick-charter': { type: 'string' },
    'pick-regions': { type: 'string' },
    'pick-model': { type: 'string' },
    'pick-effort': { type: 'string' },
  },
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
const pipeline = !!values.pipeline;
const pickModel = values['pick-model'] ?? 'claude-sonnet-5-5';
const pickEffort = (values['pick-effort'] ?? 'low') as (typeof EFFORTS)[number];
if (!EFFORTS.includes(pickEffort))
  throw Error(`--pick-effort must be one of ${EFFORTS.join(', ')}`);
if (pipeline && !values.regions) throw Error('--pipeline runs a regions chorus: pass --regions');
if (pipeline && values.charter)
  throw Error('--pipeline takes --recognise-charter and --pick-charter; drop --charter');
if (pipeline && (!values['recognise-charter'] || !values['pick-charter']))
  throw Error('--pipeline needs --recognise-charter <file> and --pick-charter <file>');
const recogniseCharter = pipeline
  ? readFileSync(resolve(values['recognise-charter']!), 'utf8').trim()
  : undefined;
const pickCharter = pipeline
  ? readFileSync(resolve(values['pick-charter']!), 'utf8').trim()
  : undefined;
const charterVersion = (text: string) => `charter-${computeHash(text).slice(0, 12)}`;

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
const explicitCharter = values.charter ? readFileSync(values.charter, 'utf8').trim() : undefined;
const label = explicitCharter
  ? `charter-${computeHash(explicitCharter).slice(0, 12)}`
  : pipeline
    ? 'charter-pipeline'
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
  probes.length > TINY_MOMENTS || process.argv.includes('--pipeline'),
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
  // In memory only: this run's view of the project runs a one-layer chorus from --regions.
  entry[1].chorus = { enabled: true, regions: resolve(values.regions) };
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
/** The charter the run scores: an explicit wording, else the shipped one every Warden runs under. */
const charter = explicitCharter ?? recogniseCharter ?? WARDEN_CHARTER;
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
const composed = new Map<string, EvalWarden[]>();
/** --pipeline: the stage-2 pickers, the same regions holding knowledge.md in full. */
const composedPick = new Map<string, EvalWarden[]>();
/** --pipeline: regions whose recogniser fell back to knowledge.md for want of a recognise.md. */
const recogniseFallback: string[] = [];
const cold = new Map<string, string[]>();
for (const probe of probes) {
  const place = placeOf(probe);
  const key = `${place.projectId ?? ''}|${place.cwd}`;
  if (composed.has(key)) continue;
  const wardens: EvalWarden[] = [];
  const pickers: EvalWarden[] = [];
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
    // The experiment's short description per region, read beside knowledge.md when the builder wrote one.
    const recognisePath = values.regions
      ? join(resolve(values.regions), agentId, 'recognise.md')
      : undefined;
    const recognise =
      pipeline && recognisePath && existsSync(recognisePath)
        ? readFileSync(recognisePath, 'utf8')
        : undefined;
    if (pipeline && !recognise?.trim()) recogniseFallback.push(domain);
    wardens.push({
      domain,
      instructions,
      domainKnowledge: recognise?.trim() ? recognise : knowledge,
      budget,
      ...(values.session ? { session: `${values.session}:${agentId}` } : {}),
    });
    if (pipeline)
      pickers.push({
        domain,
        instructions,
        domainKnowledge: knowledge,
        budget,
        ...(values.session ? { session: `${values.session}:pick:${agentId}` } : {}),
      });
  }
  composed.set(key, wardens);
  composedPick.set(key, pickers);
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
const pickersFor = (probe: WardenProbe): EvalWarden[] => composedPick.get(placeKey(probe)) ?? [];
/** --pick-regions: one picker per region id of that directory, its knowledge.md in full. */
const pickRegionsDir = values['pick-regions'] ? resolve(values['pick-regions']) : undefined;
if (pickRegionsDir && !pipeline) throw Error('--pick-regions is a --pipeline flag');
const pickRegions = new Map<string, EvalWarden>();
if (pickRegionsDir) {
  for (const region of readRegions(pickRegionsDir)) {
    pickRegions.set(region.id, {
      domain: region.id,
      instructions: regionInstructions(region),
      domainKnowledge: readFileSync(region.knowledgePath, 'utf8'),
      ...(budgetOverride !== undefined ? { budget: budgetOverride } : {}),
      ...(values.session ? { session: `${values.session}:pick:${region.id}` } : {}),
    });
  }
  if (!pickRegions.size) throw Error(`--pick-regions ${pickRegionsDir} holds no regions`);
}
/** The region ids a stage-1 recogniser holds: a group's `members`, else itself. */
const membersOf = (recogniser: string): string[] => {
  const meta = values.regions
    ? join(resolve(values.regions), recogniser, 'region.json')
    : undefined;
  if (meta && existsSync(meta)) {
    const members = (JSON.parse(readFileSync(meta, 'utf8')) as { members?: unknown }).members;
    if (Array.isArray(members) && members.every((m) => typeof m === 'string')) return members;
  }
  return [recogniser];
};
const pickerFor = (probe: WardenProbe, regionId: string): EvalWarden | undefined =>
  pickRegionsDir ? pickRegions.get(regionId) : pickersFor(probe).find((w) => w.domain === regionId);
if (pipeline)
  console.error(
    `pipeline: stage 1 ${wardenModel} ${wardenEffort ?? 'low'} RECOGNISE (${recogniseFallback.length} regions without recognise.md fall back to knowledge.md); stage 2 ${pickModel} ${pickEffort} PICK`,
  );

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
const wardens = decisionHost(wardenModel, 'claude', concurrency, state, {
  ...(inputCap !== undefined ? { inputCap } : {}),
  ...(subagents ? { subagents } : primedSessions !== undefined ? { primedSessions } : {}),
  ...(wardenEffort !== undefined ? { effort: wardenEffort } : {}),
});
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
 * --stop-at-points <n> / --stop-seven-day <percent>: the five-hour window's growth is summed in code
 * from the run's first reading (a reset adds the new window's reading), and the run stops taking new
 * turns once the sum reaches n points or the seven-day window reaches the percent. Read before every
 * turn, at most every 30 s, failing closed when the window cannot be read twice running; a turn the
 * stop lands on is not asked. --resume continues a stopped run.
 */
let stopped: string | undefined;
let spentPoints = 0;
let lastFiveHour: number | undefined;
let unreadable = 0;
const spend = (windows: Record<string, number> | undefined) => {
  if (stopAtPoints === undefined && stopSevenDay === undefined) return;
  const now = windows?.five_hour;
  // Fail closed: a bound that cannot be read twice running stops the run.
  if (now === undefined) {
    if (++unreadable >= 2) stopped ??= 'the five-hour window could not be read twice running';
  } else {
    unreadable = 0;
    spentPoints += lastFiveHour === undefined ? 0 : now >= lastFiveHour ? now - lastFiveHour : now;
    lastFiveHour = now;
  }
  if (stopAtPoints !== undefined && spentPoints >= stopAtPoints)
    stopped ??= `five-hour spend ${spentPoints} >= ${stopAtPoints} points`;
  const sevenDay = windows?.seven_day;
  if (stopSevenDay !== undefined && sevenDay !== undefined && sevenDay >= stopSevenDay)
    stopped ??= `seven-day window ${sevenDay}% >= ${stopSevenDay}%`;
};
const quotaGate = async () => {
  if (
    (stopAtPoints !== undefined || stopSevenDay !== undefined) &&
    Date.now() - lastWindowCheck >= 30_000
  ) {
    spend(await recordWindow('spend'));
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
if (values.resume) console.error(`resuming: ${finished.size} turns already done`);
let done = 0;
try {
  const run = await runCharterEval({
    probes,
    wardensFor,
    warden: wardens.provider,
    ...(judges ? { judge: judges.provider } : {}),
    charter,
    concurrency,
    triggers,
    done: (probeId, trigger) => !!stopped || finished.has(turnKey(probeId, trigger)),
    beforeTurn: quotaGate,
    onTurn: (turn) => appendFileSync(turnsFile, `${JSON.stringify(turn)}\n`),
    onAnswer: (answer) => {
      appendFileSync(answersFile, `${JSON.stringify(answer)}\n`);
      if (++done % 50 === 0)
        console.error(`  ${done} answers (${Math.round((Date.now() - started) / 1000)}s)`);
    },
  });
  const answers = [...kept, ...run.answers];
  const turns = [...keptTurns, ...run.turns];
  const score = scoreCharterRun(probes, answers, turns);
  const byProject = scoreByProject(answers, turns);
  // --pipeline stage 2: the picker, asked only where the recogniser said yes, with its line as context.
  let pick: Record<string, unknown> | undefined;
  if (pipeline) {
    // Stage 1's remark names regions, one `<id>: <why>` per line; ids are checked against the
    // recogniser's members and handed to the picker of that id (pipeline-dispatch.ts).
    const probeById = new Map(probes.map((p) => [p.id, p]));
    const { fired, counts: parse } = dispatch(answers, membersOf, (id) =>
      pickRegionsDir ? pickRegions.has(id) : true,
    );
    // Without --pick-regions a named id needs a picker in the probe's own chorus.
    if (!pickRegionsDir)
      for (const [key, list] of fired) {
        const probe = probeById.get(key.slice(0, key.lastIndexOf('|')));
        const kept = list.filter((x) => probe && pickerFor(probe, x.domain));
        parse.missingPickers += list.length - kept.length;
        parse.dispatched -= list.length - kept.length;
        if (kept.length) fired.set(key, kept);
        else fired.delete(key);
      }
    const pickAnswersFile = join(out, 'answers.pick.jsonl');
    const pickTurnsFile = join(out, 'turns.pick.jsonl');
    const keptPickTurns = readRows<WardenProbeTurn>(pickTurnsFile);
    const finishedPick = new Set(keptPickTurns.map((t) => turnKey(t.probeId, t.trigger)));
    const keptPick = readRows<WardenProbeAnswer>(pickAnswersFile).filter((a) =>
      finishedPick.has(turnKey(a.probeId, a.trigger)),
    );
    writeRows(pickAnswersFile, keptPick);
    writeRows(pickTurnsFile, keptPickTurns);
    await recordWindow('pick-start');
    const pickers = decisionHost(pickModel, 'claude', concurrency, state, {
      ...(inputCap !== undefined ? { inputCap } : {}),
      ...(primedSessions !== undefined ? { primedSessions } : {}),
      effort: pickEffort,
    });
    const pickStarted = Date.now();
    try {
      const run2 = await runCharterEval({
        probes: probes.filter((p) => [...fired.keys()].some((k) => k.startsWith(`${p.id}|`))),
        wardensFor: (probe, trigger) =>
          (fired.get(turnKey(probe.id, trigger)) ?? []).flatMap(({ domain, why }) => {
            const picker = pickerFor(probe, domain);
            return picker
              ? [
                  {
                    ...picker,
                    context: `The recogniser (stage 1, ${wardenModel}, holding this region's short description) named your region for this moment: ${why}`,
                  },
                ]
              : [];
          }),
        warden: pickers.provider,
        ...(judges ? { judge: judges.provider } : {}),
        charter: pickCharter!,
        concurrency,
        triggers,
        done: (probeId, trigger) =>
          finishedPick.has(turnKey(probeId, trigger)) || !fired.has(turnKey(probeId, trigger)),
        beforeTurn: quotaGate,
        onTurn: (turn) => appendFileSync(pickTurnsFile, `${JSON.stringify(turn)}\n`),
        onAnswer: (answer) => appendFileSync(pickAnswersFile, `${JSON.stringify(answer)}\n`),
      });
      const pickAnswers = [...keptPick, ...run2.answers];
      const pickTurns = [...keptPickTurns, ...run2.turns];
      pick = {
        recognise: {
          model: wardenModel,
          effort: wardenEffort ?? 'low',
          charter: charterVersion(recogniseCharter!),
          charterFile: resolve(values['recognise-charter']!),
          knowledge: 'recognise.md',
          fallbackToKnowledge: recogniseFallback,
          output: 'region <id>: <why> per line',
          pickRegions: pickRegionsDir ?? null,
          parse,
        },
        pick: {
          model: pickModel,
          effort: pickEffort,
          charter: charterVersion(pickCharter!),
          charterFile: resolve(values['pick-charter']!),
          knowledge: 'knowledge.md',
          answers: 'answers.pick.jsonl',
          turns: 'turns.pick.jsonl',
          calls: pickAnswers.length,
          firedMoments: pickTurns.length,
          score: scoreCharterRun(probes, pickAnswers, pickTurns),
          elapsedMs: Date.now() - pickStarted,
        },
      };
    } finally {
      await pickers.shutdown();
      await recordWindow('pick-end');
    }
  }
  writeFileSync(
    join(out, 'score.json'),
    JSON.stringify(
      {
        charter: label,
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
        pipeline: pick,
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
      { charter: label, ...score, byProject, ...(pick ? { pipeline: pick } : {}) },
      null,
      1,
    ),
  );
  console.log(`answers: ${out}`);
} finally {
  await wardens.shutdown();
  await judges?.shutdown();
  spend(await recordWindow('end'));
  if (stopAtPoints !== undefined || stopSevenDay !== undefined)
    console.error(
      `five-hour spend: ${spentPoints} points${stopped ? `; stopped early (${stopped}), --resume continues` : ''}`,
    );
}
