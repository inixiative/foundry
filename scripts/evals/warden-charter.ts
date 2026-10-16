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
 *     [--experiment <design.md>]
 *     [--pipeline --recognise-charter <file> --pick-charter <file> [--pick-model <id>] [--pick-effort <level>]]
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
 * --regions <dir> scores a chorus of regions: the --projects project runs a one-layer chorus from that
 * regions directory (`<dir>/<region id>/{region.json,knowledge.md}`), so its Wardens, their
 * instructions, knowledge and charter are generated and composed exactly as a live thread of that
 * project composes them (`resolveProjectView`, `buildRoleLayers`, `wardenCharter`). The daemon's
 * settings file is read, never written. Requires exactly one --projects entry.
 *
 * --experiment <design.md>: a run of more than three moments, or --pipeline, refuses to start without
 * a reviewed pre-registration (`scripts/evals/experiment-gate.ts`, `.claude/skills/experiment/SKILL.md`);
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
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  computeHash,
  scoreCharterRun,
  type WardenProbe,
  type WardenProbeAnswer,
  type WardenProbeTrigger,
  type WardenProbeTurn,
} from '../../packages/core/src';
import { FileMemory } from '../../packages/core/src/adapters/file-memory';
import { configuredExperts } from '../../packages/foundry/src/agents/configured-experts';
import { describeChorus } from '../../packages/foundry/src/agents/region-roster';
import { buildRoleLayers } from '../../packages/foundry/src/agents/role-layers';
import { createSourceResolver } from '../../packages/foundry/src/agents/thread-factory';
import { chorusSource, wardenCharter } from '../../packages/foundry/src/agents/warden-charter';
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
import { requireExperiment, TINY_MOMENTS } from './experiment-gate';

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
    'pause-at': { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    experiment: { type: 'string' },
    pipeline: { type: 'boolean' },
    'recognise-charter': { type: 'string' },
    'pick-charter': { type: 'string' },
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

/** One region a recogniser named for a moment, with its line why (the experiment's stage-1 contract). */
interface Recognition {
  readonly regionId: string;
  readonly why: string;
}
const RECOGNITION_LINE =
  /^\s*(?:in my domain:\s*)?(?:region\s+)?`?([A-Za-z0-9][A-Za-z0-9_.-]{0,199})`?\s*:\s*(.+?)\s*$/i;
/** Parse a stage-1 remark: one `region <id>: <why>` per line; lines in no shape are errors, counted. */
function parseRecognition(remark: string): { regions: Recognition[]; errors: string[] } {
  const regions: Recognition[] = [];
  const errors: string[] = [];
  for (const line of remark.split('\n')) {
    if (!line.trim()) continue;
    const m = RECOGNITION_LINE.exec(line);
    if (m) regions.push({ regionId: m[1]!, why: m[2]! });
    else errors.push(line.trim());
  }
  return { regions, errors };
}
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
      : 'charter-roster';
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
const probes = (projects ?? [undefined]).flatMap((project) => [
  ...pick('positive', project),
  ...pick('negative', project),
]);
const experiment = requireExperiment(
  values.experiment,
  probes.length > TINY_MOMENTS || process.argv.includes('--pipeline'),
);
if (experiment) writeFileSync(join(out, 'experiment.json'), JSON.stringify(experiment, null, 1));

// The roster, composed as live from the daemon's settings and composition view.
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
  entry[1].chorus = { source: 'regions', regions: resolve(values.regions) };
  const view = resolveProjectView(config, entry[0])!;
  if (view.chorus.source !== 'regions') throw Error(`--regions: ${view.chorus.reason}`);
  console.error(describeChorus(projects![0]!, view.chorus));
}
/** The config a thread of `projectId` composes under: its project view (generated roster included), else the global settings. */
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
/**
 * The charter the run scores: an explicit wording, else the one the scored roster runs under live (one
 * run, one charter: with --regions that project's; otherwise the roster's, which every place shares).
 */
const scoredProject = projects?.length === 1 ? projectEntry(projects[0])?.[0] : undefined;
const charter =
  explicitCharter ??
  recogniseCharter ??
  wardenCharter(chorusSource(viewOf(scoredProject), scoredProject)).text;
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
const wardensFor = (probe: WardenProbe): EvalWarden[] => composed.get(placeKey(probe)) ?? [];
const pickersFor = (probe: WardenProbe): EvalWarden[] => composedPick.get(placeKey(probe)) ?? [];
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
const wardens = decisionHost(wardenModel, 'claude', concurrency, state, {
  ...(inputCap !== undefined ? { inputCap } : {}),
  ...(primedSessions !== undefined ? { primedSessions } : {}),
  ...(wardenEffort !== undefined ? { effort: wardenEffort } : {}),
});
if (primedSessions !== undefined) console.error(`primed sessions: ${primedSessions}`);
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
const quotaGate = async () => {
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
await recordWindow('start');
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
    done: (probeId, trigger) => finished.has(turnKey(probeId, trigger)),
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
    // Stage 1's remark names regions: `region <id>: <why>` per line. Each named region that exists in the
    // chorus gets a picker; lines in no shape and unknown ids are counted, never guessed at.
    const fired = new Map<string, { domain: string; why: string }[]>();
    const parse = {
      remarks: 0,
      regionsNamed: 0,
      parseErrorLines: 0,
      remarksWithErrors: 0,
      unknownRegions: 0,
    };
    for (const a of answers)
      if (!a.noComment && !a.error && a.text) {
        parse.remarks++;
        const k = turnKey(a.probeId, a.trigger);
        const { regions, errors } = parseRecognition(a.text);
        parse.parseErrorLines += errors.length;
        if (errors.length) parse.remarksWithErrors++;
        const probe = probes.find((p) => p.id === a.probeId);
        const known = new Set(probe ? pickersFor(probe).map((w) => w.domain) : []);
        for (const r of regions) {
          parse.regionsNamed++;
          if (!known.has(r.regionId)) {
            parse.unknownRegions++;
            continue;
          }
          const list = fired.get(k) ?? [];
          if (!list.some((x) => x.domain === r.regionId))
            list.push({ domain: r.regionId, why: r.why });
          fired.set(k, list);
        }
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
            const picker = pickersFor(probe).find((w) => w.domain === domain);
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
  await recordWindow('end');
}
