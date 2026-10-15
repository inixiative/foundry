#!/usr/bin/env bun
/**
 * Score the Warden chorus against real-session probes (scripts/evals/warden-probes.ts).
 *
 *   bun scripts/evals/warden-charter.ts --probes ~/.foundry/evals/warden-probes.jsonl \
 *     [--foundry-dir ~/code/inixiative/foundry/.foundry] [--charter <file>] [--per-kind 40] \
 *     [--ctx inixiative | --projects template,zealot] [--period test] \
 *     [--triggers user-message,agent-action] [--concurrency 16] [--out <dir>]
 *
 * Each Warden is composed exactly as a live thread composes it: the daemon's settings and the
 * composition view (`buildRoleLayers`), bound to the probe's project and working directory. A Warden
 * whose domain knowledge composes empty is cold there and is left out, as live. Each probe runs as
 * one turn per trigger point it recorded (`user-message` advises on the ask, `agent-action` guards the
 * agent's turn): every Warden asked at once on Haiku over the subscription, with --concurrency
 * decisions in flight; remarks are judged by Opus. Prints the primary measure (positives some Warden
 * said first), wrong remarks, silence and speak precision, scope violations and per-turn load; writes
 * every answer under --out as it lands.
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
import { buildRoleLayers } from '../../packages/foundry/src/agents/role-layers';
import { createSourceResolver } from '../../packages/foundry/src/agents/thread-factory';
import {
  WARDEN_CHARTER,
  WARDEN_CHARTER_VERSION,
} from '../../packages/foundry/src/agents/warden-charter';
import {
  type EvalWarden,
  markEvalRun,
  runCharterEval,
} from '../../packages/foundry/src/feedback/charter-eval';
import { roleComposition } from '../../packages/foundry/src/prompts/instruction-settings';
import { decisionHost, privateDirectory } from '../../packages/foundry/src/providers/decision-host';
import { ConfigStore } from '../../packages/foundry/src/viewer/config';

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
  },
});
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
const charter = values.charter ? readFileSync(values.charter, 'utf8').trim() : WARDEN_CHARTER;
const label = values.charter
  ? `charter-${computeHash(charter).slice(0, 12)}`
  : WARDEN_CHARTER_VERSION;
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

// The roster, composed as live from the daemon's settings and composition view.
const foundryDir = resolve(
  values['foundry-dir'] ?? join(homedir(), 'code', 'inixiative', 'foundry', '.foundry'),
);
const config = await new ConfigStore(foundryDir).load();
const resolveSource = createSourceResolver({ memory: new FileMemory(join(foundryDir, 'memory')) });
const roster = configuredExperts(config).experts;
/** The project and working directory a probe's thread would have run in. */
const placeOf = (probe: WardenProbe): { projectId?: string; cwd: string } => {
  const entry = Object.entries(config.projects ?? {}).find(
    ([, p]) => probe.project && basename(p.path ?? '') === probe.project,
  );
  if (entry?.[1].path) return { projectId: entry[0], cwd: entry[1].path };
  return {
    cwd:
      probe.ctx === 'userevidence'
        ? join(homedir(), 'code', 'zealot')
        : join(homedir(), 'code', 'inixiative'),
  };
};
const composed = new Map<string, EvalWarden[]>();
const cold = new Map<string, string[]>();
for (const probe of probes) {
  const place = placeOf(probe);
  const key = `${place.projectId ?? ''}|${place.cwd}`;
  if (composed.has(key)) continue;
  const wardens: EvalWarden[] = [];
  for (const { agentId, domain } of roster) {
    const slots = buildRoleLayers(config, agentId, { resolveSource, scope: place });
    await Promise.all([slots.instructions.warm(), slots.domainKnowledge.warm()]);
    if (!slots.domainKnowledge.content.trim()) {
      cold.set(key, [...(cold.get(key) ?? []), domain]);
      continue;
    }
    wardens.push({
      domain,
      instructions: slots.instructions.content,
      domainKnowledge: slots.domainKnowledge.content,
      budget: roleComposition(config.composition, agentId).budget,
    });
  }
  composed.set(key, wardens);
}
const wardensFor = (probe: WardenProbe): EvalWarden[] => {
  const place = placeOf(probe);
  return composed.get(`${place.projectId ?? ''}|${place.cwd}`) ?? [];
};

const concurrency = Number(values.concurrency ?? 16);
// An eval run, not work: Archive and the repeat report leave its sessions out.
const state = privateDirectory(join(homedir(), '.foundry', 'evals'));
markEvalRun(state);
const wardens = decisionHost(
  'claude-haiku-5-5',
  'claude',
  concurrency,
  join(homedir(), '.foundry', 'evals'),
);
const judges = decisionHost('claude-opus-5-5', 'claude', 4, state);
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
    judge: judges.provider,
    charter,
    concurrency,
    triggers,
    done: (probeId, trigger) => finished.has(turnKey(probeId, trigger)),
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
  const byProject = Object.fromEntries(
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
        roster: roster.map((r) => r.domain),
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
  console.log(JSON.stringify({ charter: label, ...score, byProject }, null, 1));
  console.log(`answers: ${out}`);
} finally {
  await wardens.shutdown();
  await judges.shutdown();
}
