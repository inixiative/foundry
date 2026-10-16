#!/usr/bin/env bun
/**
 * The Warden eval report: one `report.json` (schema `warden-eval-report/2`) and one rendered `REPORT.md`
 * per run of the charter eval (scripts/evals/warden-charter.ts), organised by stage. The schema is
 * documented in docs/EVAL-REPORTING.md.
 *
 *   bun scripts/evals/warden-charter-report.ts --run <run dir> --probes <probes.jsonl> \
 *     [--labels <labels.json>] [--recognise <stage-1 run dir>] [--baseline <run dir>] \
 *     [--judge-pointers] [--routing <scores.jsonl>] [--window <before,after>] \
 *     [--trigger-rates 17,60] [--finding <file> --experiment <name> --layer <layer> --change <text>] \
 *     [--out <report.json>]
 *
 * Stages. Stage 1 "recognise" is a chorus asked every region (Haiku live). Stage 2 "confirm+pick" is a
 * stronger model asked only the (moment, region) pairs stage 1 said yes to: pass the stage-1 run as
 * --recognise and the --run is scored as stage 2 over it. Stage 3 "deliver" (what reaches the main
 * thread and whether it changes what it builds) is a placeholder until the intervention test. The
 * chorus roll-up is the system as the main thread sees it: stage 1 alone, or stage 1 → stage 2.
 *
 * Every stage carries the same blocks, named as INVENTORY.md G names the gauges: goal (coverage, correctness, pointer ladder,
 * majority-correct), cost (exact tokens, shared-window points, per moment, projected per hour),
 * time (per call warm and cold, per moment, added only when fired), per-Warden individual error
 * (miss rate, false-positive rate), accumulated error (moments with a miss or a wrong chime, the
 * compounding line) and provenance. Every rate carries n, d and a Wilson 95% interval.
 *
 * Truth is multi-region: `--labels` (warden-prefilter.ts label-regions) names, per probe, the regions
 * that hold or are expected for its target; a yes from one of them is right. Without labels, a
 * positive probe with a target needs every region that was asked (the size test's single-Warden
 * cells). A correction with no labelled target is left out of scoring; negatives count every yes as
 * wrong. A moment is one turn (probe × trigger), as live triggers are.
 *
 * --judge-pointers grades every remark on a targeted positive on the pointer ladder (Opus), cached
 * in the run's pointer-ladder.jsonl. --baseline names the run the deltas are against. --window gives
 * the shared five-hour window before and after when quota.jsonl did not record it. --finding writes
 * a finding record (findings/README.md schema) generated from the report. --routing keeps the
 * routed-at-k view. Reads the run; writes only the pointer cache, report.json, REPORT.md and the
 * finding record.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  POINTER_LEVELS,
  type PointerLevel,
  parseWardenPointerJudgement,
  WARDEN_POINTER_JUDGE_PROMPT,
  type WardenPointerJudgement,
  type WardenProbe,
  type WardenProbeAnswer,
  type WardenProbeTrigger,
  type WardenProbeTurn,
  wardenPointerJudgeMessage,
  wilsonInterval,
} from '../../packages/core/src';
import {
  WARDEN_CHARTER_CLASSIFY_VERSION,
  WARDEN_CHARTER_VERSION,
} from '../../packages/foundry/src/agents/warden-charter';
import { markEvalRun } from '../../packages/foundry/src/feedback/charter-eval';
import { decisionHost, privateDirectory } from '../../packages/foundry/src/providers/decision-host';

export const REPORT_SCHEMA = 'warden-eval-report/2';

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    probes: { type: 'string' },
    labels: { type: 'string' },
    recognise: { type: 'string' },
    baseline: { type: 'string' },
    'judge-pointers': { type: 'boolean' },
    routing: { type: 'string' },
    window: { type: 'string' },
    'trigger-rates': { type: 'string' },
    repeat: { type: 'string' },
    finding: { type: 'string' },
    experiment: { type: 'string' },
    layer: { type: 'string' },
    change: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.run || !values.probes) {
  console.error(
    'usage: warden-charter-report.ts --run <dir> --probes <jsonl> [--labels <json>] ...',
  );
  process.exit(2);
}
const run = resolve(values.run);
const triggerRates = (values['trigger-rates'] ?? '17,60').split(',').map(Number);
if (triggerRates.length !== 2 || triggerRates.some((r) => !(r > 0)))
  throw Error('--trigger-rates takes two positive numbers: typical,busy moments per hour');

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
const probesById = new Map(
  readJsonl<WardenProbe>(resolve(values.probes)).map((p) => [p.id, p] as const),
);
type Labels = {
  probes: Record<string, { expected?: string[]; held?: string[] }>;
  /** INVENTORY.md H, kind of knowledge: the target's concept cluster → coding | system-domain | process | convention-style. */
  kindOfKnowledge?: { version: number; map: Record<string, string> };
};
const labels = values.labels ? readJson<Labels>(resolve(values.labels)) : undefined;
/** What a run of the charter eval recorded about itself. */
interface ScoreFile {
  charter?: string;
  session?: string;
  model?: string;
  effort?: string;
  thinkingTokens?: string;
  regions?: string;
  knowledge?: string;
  projects?: string[];
  period?: string;
  roster?: string[];
  foundryDir?: string;
  /** --pipeline: what each stage ran (model, effort, charter version, knowledge file, fallbacks). */
  pipeline?: {
    recognise: {
      model: string;
      effort: string;
      charter: string;
      knowledge: string;
      fallbackToKnowledge: string[];
      parse?: {
        remarks: number;
        regionsNamed: number;
        parseErrorLines: number;
        remarksWithErrors: number;
        unknownRegions: number;
      };
    };
    pick: {
      model: string;
      effort: string;
      charter: string;
      knowledge: string;
      calls: number;
      firedMoments: number;
    };
  };
}
interface QuotaRow {
  at: string;
  phase: string;
  windows?: Record<string, number>;
  load?: string;
}
interface Run {
  dir: string;
  turns: WardenProbeTurn[];
  answers: WardenProbeAnswer[];
  probes: WardenProbe[];
  answersFile: string;
  score?: ScoreFile;
  quota: QuotaRow[];
}
const turnKey = (probeId: string, trigger: WardenProbeTrigger | undefined) =>
  `${probeId}|${trigger ?? 'agent-action'}`;
/** A run directory's answers; `stage: 'pick'` reads a --pipeline run's stage-2 files beside its stage-1 ones. */
const loadRun = (dir: string, stage?: 'pick'): Run => {
  const turns = readJsonl<WardenProbeTurn>(join(dir, stage ? 'turns.pick.jsonl' : 'turns.jsonl'));
  const answersFile = stage
    ? 'answers.pick.jsonl'
    : existsSync(join(dir, 'answers.rejudged.jsonl'))
      ? 'answers.rejudged.jsonl'
      : 'answers.jsonl';
  const finished = new Set(turns.map((t) => turnKey(t.probeId, t.trigger)));
  const answers = readJsonl<WardenProbeAnswer>(join(dir, answersFile)).filter((a) =>
    finished.has(turnKey(a.probeId, a.trigger)),
  );
  const probes = [...new Set(turns.map((t) => t.probeId))]
    .map((id) => probesById.get(id))
    .filter((p): p is WardenProbe => !!p);
  return {
    dir,
    turns,
    answers,
    probes,
    answersFile,
    score: readJson<ScoreFile>(join(dir, 'score.json')),
    quota: readJsonl<QuotaRow>(join(dir, 'quota.jsonl')),
  };
};
const main = loadRun(run);
// A --pipeline run carries both stages; an offline-derived stage 2 names its stage-1 run with --recognise.
const pipelineRun = !values.recognise && existsSync(join(run, 'answers.pick.jsonl'));
const recognise = values.recognise
  ? loadRun(resolve(values.recognise))
  : pipelineRun
    ? main
    : undefined;
const stage2 = values.recognise ? main : pipelineRun ? loadRun(run, 'pick') : undefined;

// ---------------------------------------------------------------------------
// Pointer ladder: every remark on a positive probe with a target, judged once and cached.
// ---------------------------------------------------------------------------
const pointerKey = (probeId: string, text: string) =>
  createHash('sha256').update(`${probeId}\0${text}`).digest('hex').slice(0, 24);
const ladderFile = join(run, 'pointer-ladder.jsonl');
const ladder = new Map(
  readJsonl<{ key: string; judged: WardenPointerJudgement }>(ladderFile).map((r) => [
    r.key,
    r.judged,
  ]),
);
// A stage-1 run's own ladder is read from its directory, so a mixed report grades both stages.
const ladderOf = (r: Run) =>
  r.dir === run
    ? ladder
    : new Map(
        readJsonl<{ key: string; judged: WardenPointerJudgement }>(
          join(r.dir, 'pointer-ladder.jsonl'),
        ).map((x) => [x.key, x.judged]),
      );
const momentOf = (p: WardenProbe) =>
  [p.ask ? `User message:\n${p.ask}` : '', p.moment ? `Agent turn:\n${p.moment}` : '']
    .filter(Boolean)
    .join('\n\n');
const yes = (a: WardenProbeAnswer) => !a.noComment && !a.error;
if (values['judge-pointers']) {
  const pending = [...main.answers, ...(stage2 && stage2 !== main ? stage2.answers : [])].filter(
    (a) => {
      const p = probesById.get(a.probeId);
      return (
        p?.kind === 'positive' &&
        p.gold?.target &&
        yes(a) &&
        a.text &&
        !ladder.has(pointerKey(a.probeId, a.text))
      );
    },
  );
  console.error(`judging ${pending.length} pointers`);
  if (pending.length) {
    const state = privateDirectory(join(homedir(), '.foundry', 'evals'));
    markEvalRun(state);
    const judges = decisionHost('claude-opus-5-5', 'claude', 4, state);
    try {
      let next = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < pending.length) {
            const a = pending[next++]!;
            const p = probesById.get(a.probeId)!;
            const key = pointerKey(a.probeId, a.text!);
            if (ladder.has(key)) continue;
            let judged: WardenPointerJudgement | undefined;
            for (let attempt = 0; attempt < 3 && !judged; attempt++) {
              try {
                const result = await judges.provider.complete(
                  [
                    { role: 'system', content: WARDEN_POINTER_JUDGE_PROMPT },
                    {
                      role: 'user',
                      content: wardenPointerJudgeMessage({
                        moment: momentOf(p),
                        target: p.gold!.target!,
                        pointer: a.text!,
                      }),
                    },
                  ],
                  { maxTokens: 300, temperature: 0, tools: false, maxTurns: 1 },
                );
                judged = parseWardenPointerJudgement(result.content);
              } catch {
                await Bun.sleep(5_000 * (attempt + 1));
              }
            }
            if (!judged) continue;
            ladder.set(key, judged);
            appendFileSync(ladderFile, `${JSON.stringify({ key, judged })}\n`, { mode: 0o600 });
          }
        }),
      );
    } finally {
      await judges.shutdown();
    }
  }
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------
export interface Rate {
  n: number;
  d: number;
  rate: number | null;
  ci: [number, number] | null;
}
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const asRate = (n: number, d: number): Rate => ({
  n,
  d,
  rate: rate(n, d),
  ci: wilsonInterval(n, d),
});
const pct = (sorted: readonly number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
    : null;
const mean = (xs: readonly number[]) =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
const quantiles = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s.at(-1) ?? null };
};
const RANK: Record<PointerLevel, number> = { exact: 0, candidates: 1, class: 2, wrong: 3 };

/** The regions a moment needs: its labelled regions, else (no labels) every region asked on a targeted positive. */
const needed = (probe: WardenProbe, asked: ReadonlySet<string>): Set<string> => {
  if (probe.kind !== 'positive' || !probe.gold?.target) return new Set();
  if (!labels) return new Set(asked);
  const l = labels.probes[probe.id];
  return new Set([...(l?.expected ?? []), ...(l?.held ?? [])]);
};
/** Truth is known on negatives and on positives with a labelled target. */
const scorable = (probe: WardenProbe, asked: ReadonlySet<string>) =>
  probe.kind === 'negative' || needed(probe, asked).size > 0;

interface Moment {
  key: string;
  probe: WardenProbe;
  trigger: WardenProbeTrigger;
  turn: WardenProbeTurn | undefined;
  answers: WardenProbeAnswer[];
  asked: Set<string>;
  shown: Set<string>;
  needed: Set<string>;
  scorable: boolean;
}

/**
 * The moments a stage saw. For stage 1 every turn is a moment. For stage 2 the moments are the stage-1
 * moments: those stage 1 was silent on reach stage 2 as "not fired" (no calls, no yeses).
 */
function moments(r: Run, base?: Run): Moment[] {
  const source = base ?? r;
  const byTurn = new Map<string, WardenProbeAnswer[]>();
  for (const a of r.answers) {
    const k = turnKey(a.probeId, a.trigger);
    byTurn.set(k, [...(byTurn.get(k) ?? []), a]);
  }
  const ownTurns = new Map(r.turns.map((t) => [turnKey(t.probeId, t.trigger), t]));
  const out: Moment[] = [];
  for (const t of source.turns) {
    const probe = probesById.get(t.probeId);
    if (!probe) continue;
    const key = turnKey(t.probeId, t.trigger);
    const answers = byTurn.get(key) ?? [];
    const asked = new Set(answers.map((a) => a.domain));
    const needs = needed(
      probe,
      base
        ? new Set(
            base.answers.filter((a) => turnKey(a.probeId, a.trigger) === key).map((a) => a.domain),
          )
        : asked,
    );
    out.push({
      key,
      probe,
      trigger: t.trigger ?? 'agent-action',
      turn: ownTurns.get(key),
      answers,
      asked,
      shown: new Set(answers.filter(yes).map((a) => a.domain)),
      needed: needs,
      scorable: scorable(probe, asked),
    });
  }
  return out;
}

/** Tokens a call used, by kind. */
const tokensOf = (answers: readonly WardenProbeAnswer[]) => {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, total: 0 };
  for (const a of answers) {
    if (!a.tokens) continue;
    t.input += a.tokens.input;
    t.cacheRead += a.tokens.cacheRead ?? 0;
    t.cacheWrite += a.tokens.cacheWrite ?? 0;
    t.output += a.tokens.output;
    t.thinking += a.tokens.thinking ?? 0;
  }
  t.total = t.input + t.cacheRead + t.cacheWrite + t.output;
  return t;
};
/** A call that wrote more cache than it read primed its session: cold. */
const cold = (a: WardenProbeAnswer) =>
  !!a.tokens && (a.tokens.cacheWrite ?? 0) > (a.tokens.cacheRead ?? 0);

/** The shared five-hour window's growth over a run's quota probes; a drop is the window rolling. */
function windowGrowth(rows: readonly QuotaRow[]): number | null {
  const w = rows.filter((r) => r.windows?.five_hour !== undefined);
  if (w.length < 2) return null;
  let growth = 0;
  for (let i = 1; i < w.length; i++) {
    const before = w[i - 1]!.windows!.five_hour!;
    const after = w[i]!.windows!.five_hour!;
    growth += after >= before ? after - before : after;
  }
  return growth;
}
const loadOf = (rows: readonly QuotaRow[]) => {
  const loads = rows
    .map((r) => /load averages?: ([\d.]+)/.exec(r.load ?? '')?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
  return loads.length
    ? { min: Math.min(...loads), max: Math.max(...loads), mean: mean(loads) }
    : null;
};

export interface StageReport {
  stage: 'recognise' | 'confirm' | 'deliver' | 'chorus';
  status: 'measured' | 'not-run' | 'placeholder';
  note?: string;
  /** INVENTORY.md G "Coverage" and "Correctness" (+ majority-correct), stratified by the H axes. */
  goal?: ReturnType<typeof split>['goal'];
  /** G "Pointer ladder". */
  pointer?: ReturnType<typeof split>['pointer'];
  /** G "Cost": tokens by kind, weighted, window points per moment and per hour. */
  cost?: ReturnType<typeof cost>;
  /** G "Time". */
  time?: ReturnType<typeof time>;
  /** G "Per-Warden miss rate" and "Per-Warden false-positive rate", in `recognition.perRegion`. */
  recognition?: ReturnType<typeof wardens>;
  /** G "Accumulated error". */
  accumulated?: ReturnType<typeof accumulated>;
  /** G "Quota state": the shared windows at the stage's first and last probe. */
  quota?: ReturnType<typeof quotaState>;
  /** G "Memory": host RSS; measured by the tiny tests, not by a run. */
  memory?: typeof MEMORY_UNMEASURED;
  provenance?: ReturnType<typeof provenance>;
}

const MEMORY_UNMEASURED = {
  rssPerWarmSessionMb: null as number | null,
  rssPerThreadMb: null as number | null,
  note: 'not measured by a charter run: the tiny tests and spec C runs record RSS',
};

/** G "Quota state": five-hour and seven-day window % at the first and last probe of a run. */
function quotaState(rows: readonly QuotaRow[]) {
  const w = rows.filter((r) => r.windows);
  const first = w[0]?.windows;
  const last = w.at(-1)?.windows;
  return {
    fiveHour: { start: first?.five_hour ?? null, end: last?.five_hour ?? null },
    sevenDay: { start: first?.seven_day ?? null, end: last?.seven_day ?? null },
    probes: w.length,
    shared: true as const,
  };
}

/** Cells of an H axis with fewer moments than this are reported as too few, never as a rate. */
const AXIS_MIN_N = 5;
/** The H axes a targeted moment sits on (INVENTORY.md H). */
function axesOf(m: Moment): Record<string, string> {
  const l = labels?.probes[m.probe.id];
  const target = m.probe.gold?.target;
  const concept = target?.concept;
  return {
    kindOfMoment: m.trigger === 'user-message' ? 'user ask' : 'agent action',
    kindOfMiss: target?.miss ?? 'unknown',
    whereTheAnswerLives: l?.held?.length ? 'held' : l?.expected?.length ? 'class-only' : 'gap',
    project: m.probe.project ?? 'unknown',
    authorship: m.probe.authorship?.by ?? 'human',
    kindOfKnowledge: concept ? (labels?.kindOfKnowledge?.map[concept] ?? 'unmapped') : 'unknown',
  };
}
const AXES = [
  'kindOfMoment',
  'kindOfMiss',
  'whereTheAnswerLives',
  'project',
  'authorship',
  'kindOfKnowledge',
] as const;
type AxisCell =
  | { n: number; tooFew: true }
  | {
      n: number;
      tooFew: false;
      coverage: number | null;
      correctness: number | null;
      majorityCorrect: Rate;
      anticipated: Rate;
      pointerLeads: Rate;
    };
function stratify(
  ms: readonly Moment[],
  lad: Map<string, WardenPointerJudgement>,
): Record<string, Record<string, AxisCell>> {
  const targeted = ms.filter((m) => m.needed.size > 0);
  return Object.fromEntries(
    AXES.map((axis) => {
      const cells = new Map<string, Moment[]>();
      for (const m of targeted) {
        const v = axesOf(m)[axis]!;
        cells.set(v, [...(cells.get(v) ?? []), m]);
      }
      return [
        axis,
        Object.fromEntries(
          [...cells]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([value, cell]) => {
              if (cell.length < AXIS_MIN_N)
                return [value, { n: cell.length, tooFew: true as const }];
              const e = effectiveness(cell, lad);
              return [
                value,
                {
                  n: cell.length,
                  tooFew: false as const,
                  coverage: e.coverage.mean,
                  correctness: e.correctness.meanOverAll,
                  majorityCorrect: e.majorityCorrect,
                  anticipated: e.anticipated,
                  pointerLeads: e.pointerLadder.leads,
                },
              ];
            }),
        ),
      ];
    }),
  );
}
/** Effectiveness split as INVENTORY.md G names it: `goal` (coverage, correctness, majority-correct) and `pointer`. */
function split(ms: readonly Moment[], lad: Map<string, WardenPointerJudgement>) {
  const { pointerLadder, ...goal } = effectiveness(ms, lad);
  return { goal: { ...goal, byAxis: stratify(ms, lad) }, pointer: pointerLadder };
}

function effectiveness(ms: readonly Moment[], lad: Map<string, WardenPointerJudgement>) {
  const targeted = ms.filter((m) => m.needed.size > 0);
  const per = targeted.map((m) => {
    const both = [...m.needed].filter((r) => m.shown.has(r)).length;
    return {
      coverage: both / m.needed.size,
      correctness: m.shown.size ? both / m.shown.size : null,
    };
  });
  const spoken = per.filter((x) => x.correctness !== null);
  const bestRung = (m: Moment): PointerLevel | 'silent' | 'unjudged' => {
    const mine = m.answers.filter((a) => yes(a) && a.text);
    if (!mine.length) return 'silent';
    const levels = mine
      .map((a) => lad.get(pointerKey(a.probeId, a.text!))?.level)
      .filter((l): l is PointerLevel => !!l);
    if (!levels.length) return 'unjudged';
    return levels.sort((a, b) => RANK[a] - RANK[b])[0]!;
  };
  const rungs = targeted.map(bestRung);
  const leads = rungs.filter((r) => r === 'exact' || r === 'candidates' || r === 'class').length;
  const matched = targeted.filter((m) => m.answers.some((a) => yes(a) && a.judged?.matches)).length;
  return {
    moments: targeted.length,
    excludedPositives: ms.filter((m) => m.probe.kind === 'positive' && !m.needed.size).length,
    negatives: ms.filter((m) => m.probe.kind === 'negative').length,
    coverage: {
      mean: mean(per.map((x) => x.coverage)),
      full: asRate(per.filter((x) => x.coverage === 1).length, per.length),
    },
    correctness: {
      meanOverAll: mean(per.map((x) => x.correctness ?? 0)),
      meanOverSpoken: mean(spoken.map((x) => x.correctness!)),
      silentMoments: asRate(per.length - spoken.length, per.length),
    },
    majorityCorrect: asRate(spoken.filter((x) => x.correctness! > 0.5).length, per.length),
    anticipated: asRate(matched, targeted.length),
    pointerLadder: {
      byMomentBestRung: Object.fromEntries(
        [...POINTER_LEVELS, 'silent', 'unjudged'].map((l) => [
          l,
          rungs.filter((r) => r === l).length,
        ]),
      ),
      leads: asRate(leads, targeted.length),
      exact: asRate(rungs.filter((r) => r === 'exact').length, targeted.length),
    },
    goalMet:
      (mean(per.map((x) => x.coverage)) ?? 0) > 0.5 &&
      (mean(per.map((x) => x.correctness ?? 0)) ?? 0) > 0.5,
  };
}

/** Token weights by kind for the weighted cost: cache reads cheap, writes and generated tokens dear. */
const COST_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 5, thinking: 5 } as const;
/** Window points per weighted token: 0.11 pt/moment ÷ 224,661 weighted tokens/moment (after-sub30-20261015). */
const POINTS_PER_WEIGHTED_TOKEN = 0.11 / 224_661;

function cost(
  ms: readonly Moment[],
  answers: readonly WardenProbeAnswer[],
  windowPoints: number | null,
) {
  const t = tokensOf(answers);
  const n = ms.length;
  const perMoment = {
    calls: rate(answers.length, n),
    tokens: n ? Math.round(t.total / n) : null,
    windowPoints: windowPoints === null ? null : rate(windowPoints, n),
  };
  const project = (perHour: number) => ({
    momentsPerHour: perHour,
    calls: perMoment.calls === null ? null : Math.round(perMoment.calls * perHour),
    tokens: perMoment.tokens === null ? null : Math.round(perMoment.tokens * perHour),
    windowPoints:
      perMoment.windowPoints === null
        ? null
        : Math.round(perMoment.windowPoints * perHour * 100) / 100,
  });
  const weightedTokens =
    t.input * COST_WEIGHTS.input +
    t.cacheRead * COST_WEIGHTS.cacheRead +
    t.cacheWrite * COST_WEIGHTS.cacheWrite +
    t.output * COST_WEIGHTS.output +
    t.thinking * COST_WEIGHTS.thinking;
  const weightedPerMoment = n ? weightedTokens / n : null;
  const toPoints = (w: number | null) =>
    w === null ? null : Math.round(w * POINTS_PER_WEIGHTED_TOKEN * 10000) / 10000;
  return {
    calls: answers.length,
    errors: answers.filter((a) => a.error).length,
    tokens: t,
    tokensPerCall: answers.length ? Math.round(t.total / answers.length) : null,
    cacheReadShare: rate(t.cacheRead, t.total),
    weighted: {
      weights: COST_WEIGHTS,
      tokens: Math.round(weightedTokens),
      perMoment: weightedPerMoment === null ? null : Math.round(weightedPerMoment),
      coefficientPointsPerWeightedToken: POINTS_PER_WEIGHTED_TOKEN,
      pointsPerMoment: toPoints(weightedPerMoment),
      pointsPerHour: {
        typical: toPoints(weightedPerMoment === null ? null : weightedPerMoment * triggerRates[0]!),
        busy: toPoints(weightedPerMoment === null ? null : weightedPerMoment * triggerRates[1]!),
      },
      note: 'exact tokens weighted by kind, converted with one coefficient fixed from the after-run (0.11 window points per moment over 224,661 weighted tokens per moment); the shared-window growth is the bound',
    },
    windowPoints: {
      growth: windowPoints,
      shared: true as const,
      note: "five-hour window of the shared Claude login; other sessions' spend included: an upper bound",
    },
    perMoment,
    projectedPerHour: { typical: project(triggerRates[0]!), busy: project(triggerRates[1]!) },
  };
}

function time(
  ms: readonly Moment[],
  answers: readonly WardenProbeAnswer[],
  firedOf?: readonly Moment[],
) {
  const ok = answers.filter((a) => !a.error && a.elapsedMs !== undefined);
  const warm = quantiles(ok.filter((a) => !cold(a)).map((a) => a.elapsedMs!));
  const coldQ = quantiles(ok.filter(cold).map((a) => a.elapsedMs!));
  const turns = ms.filter((m) => m.turn).map((m) => m.turn!.wallMs);
  const fired = firedOf ?? ms.filter((m) => m.answers.length > 0);
  return {
    call: { all: quantiles(ok.map((a) => a.elapsedMs!)), warm, cold: coldQ },
    moment: quantiles(turns),
    addedWhenFired: {
      momentsFired: asRate(fired.filter((m) => m.answers.length > 0).length, ms.length),
      wall: quantiles(fired.filter((m) => m.turn).map((m) => m.turn!.wallMs)),
    },
  };
}

function wardens(ms: readonly Moment[]) {
  const regions = [...new Set(ms.flatMap((m) => [...m.asked]))].sort();
  const rows = regions.map((region) => {
    const own = ms.filter((m) => m.needed.has(region));
    const ownAsked = own.filter((m) => m.asked.has(region));
    const misses = ownAsked.filter((m) => !m.shown.has(region));
    const notOwn = ms.filter((m) => m.scorable && !m.needed.has(region) && m.asked.has(region));
    const wrong = notOwn.filter((m) => m.shown.has(region));
    const spoke = ms.filter((m) => m.scorable && m.shown.has(region));
    const right = spoke.filter((m) => m.needed.has(region));
    return [
      region,
      {
        calls: ms.filter((m) => m.asked.has(region)).length,
        yes: ms.filter((m) => m.shown.has(region)).length,
        ownMoments: own.length,
        miss: asRate(misses.length, ownAsked.length),
        falsePositive: asRate(wrong.length, notOwn.length),
        rightYes: right.length,
        wrongYes: spoke.length - right.length,
        precision: asRate(right.length, spoke.length),
        recall: asRate(ownAsked.length - misses.length, own.length),
      },
    ] as const;
  });
  const speaking = rows.filter(([, r]) => r.yes > 0);
  const owning = rows.filter(([, r]) => r.ownMoments > 0);
  return {
    regions: regions.length,
    neverFired: rows.filter(([, r]) => r.yes === 0).length,
    speaking: speaking.length,
    macroPrecision: mean(
      speaking.filter(([, r]) => r.precision.rate !== null).map(([, r]) => r.precision.rate!),
    ),
    macroRecall: mean(
      owning.filter(([, r]) => r.recall.rate !== null).map(([, r]) => r.recall.rate!),
    ),
    precisionAtLeast80: asRate(
      speaking.filter(([, r]) => (r.precision.rate ?? 0) >= 0.8).length,
      speaking.length,
    ),
    meanMissRate: mean(owning.filter(([, r]) => r.miss.rate !== null).map(([, r]) => r.miss.rate!)),
    meanFalsePositiveRate: mean(
      rows.filter(([, r]) => r.falsePositive.rate !== null).map(([, r]) => r.falsePositive.rate!),
    ),
    perRegion: Object.fromEntries(
      rows.sort((a, b) => b[1].ownMoments - a[1].ownMoments || b[1].wrongYes - a[1].wrongYes),
    ),
  };
}

function accumulated(ms: readonly Moment[], w: ReturnType<typeof wardens>) {
  const scored = ms.filter((m) => m.scorable);
  const targeted = scored.filter((m) => m.needed.size > 0);
  const withMiss = targeted.filter((m) => ![...m.needed].some((r) => m.shown.has(r)));
  const wrongChimes = (m: Moment) => [...m.shown].filter((r) => !m.needed.has(r)).length;
  const withWrong = scored.filter((m) => wrongChimes(m) > 0);
  const regionsPerMoment = mean(scored.map((m) => m.asked.size));
  return {
    momentsWithMiss: asRate(withMiss.length, targeted.length),
    momentsWithWrongChime: asRate(withWrong.length, scored.length),
    wrongChimesPerMoment: mean(scored.map(wrongChimes)),
    regionsAskedPerMoment: regionsPerMoment,
    meanWardenFalsePositiveRate: w.meanFalsePositiveRate,
    expectedWrongChimesPerMoment:
      regionsPerMoment !== null && w.meanFalsePositiveRate !== null
        ? Math.round(regionsPerMoment * w.meanFalsePositiveRate * 1000) / 1000
        : null,
    compounding:
      'N regions asked per moment × mean per-Warden false-positive rate = expected wrong chimes per moment (independent errors); compare with the measured wrong chimes per moment',
  };
}

function provenance(
  r: Run,
  stageModel?: {
    model?: string;
    effort?: string;
    charter?: string;
    knowledge?: string;
    fallback?: string[];
  },
) {
  const s = r.score ?? {};
  const charterVersion =
    s.charter === 'charter-regions'
      ? WARDEN_CHARTER_CLASSIFY_VERSION
      : s.charter === 'charter-roster'
        ? WARDEN_CHARTER_VERSION
        : s.charter;
  const regions = s.regions ? basename(s.regions).replace(/^regions-/, '') : undefined;
  return {
    run: r.dir,
    answers: r.answersFile,
    model: stageModel?.model ?? s.model ?? 'claude-haiku-5-5',
    effort: stageModel?.effort ?? s.effort ?? 'low',
    thinkingTokens: s.thinkingTokens ?? null,
    charter: stageModel?.charter ?? charterVersion ?? null,
    charterLabel: s.charter ?? null,
    knowledgeFile: stageModel?.knowledge ?? (s.regions ? 'knowledge.md' : null),
    recogniseFallback: stageModel?.fallback ?? null,
    regions: regions ?? null,
    regionsDir: s.regions ?? null,
    knowledge: s.knowledge ?? null,
    roster: s.roster?.length ?? null,
    session: s.session ?? null,
    load: loadOf(r.quota),
    sharedWindow: true as const,
  };
}

/** Stage 1 "recognise": the run's own turns, every region it asked. */
function recogniseStage(
  r: Run,
  lad: Map<string, WardenPointerJudgement>,
  windowPoints: number | null,
): StageReport & { moments: Moment[] } {
  const ms = moments(r);
  const w = wardens(ms);
  const pl = r.score?.pipeline?.recognise;
  return {
    stage: 'recognise',
    status: 'measured',
    ...(pl
      ? {
          note: `--pipeline stage 1: ${pl.model} ${pl.effort} under ${pl.charter}, holding recognise.md${pl.fallbackToKnowledge.length ? ` (${pl.fallbackToKnowledge.length} regions fell back to knowledge.md: ${pl.fallbackToKnowledge.join(', ')})` : ''}${pl.parse ? `; stage-1 output parsed: ${pl.parse.regionsNamed} regions named in ${pl.parse.remarks} remarks, parse errors ${pl.parse.parseErrorLines} lines in ${pl.parse.remarksWithErrors} remarks (${pl.parse.remarks ? Math.round((pl.parse.remarksWithErrors / pl.parse.remarks) * 1000) / 10 : 0}%), unknown region ids ${pl.parse.unknownRegions}` : ''}`,
        }
      : {}),
    moments: ms,
    ...split(ms, lad),
    cost: cost(ms, r.answers, windowPoints),
    time: time(ms, r.answers),
    recognition: w,
    accumulated: accumulated(ms, w),
    quota: quotaState(r.quota),
    memory: MEMORY_UNMEASURED,
    provenance: provenance(
      r,
      pl
        ? {
            model: pl.model,
            effort: pl.effort,
            charter: pl.charter,
            knowledge: pl.knowledge,
            fallback: pl.fallbackToKnowledge,
          }
        : undefined,
    ),
  };
}

/** Stage 2 "confirm+pick": the run's answers over the stage-1 run's moments; unfired moments reach it silent. */
function confirmStage(
  r: Run,
  base: Run,
  lad: Map<string, WardenPointerJudgement>,
  windowPoints: number | null,
): StageReport & { moments: Moment[] } {
  const ms = moments(r, base);
  const w = wardens(ms);
  const pl = base.score?.pipeline?.pick;
  return {
    stage: 'confirm',
    status: 'measured',
    note: pl
      ? `--pipeline stage 2: ${pl.model} ${pl.effort} under ${pl.charter}, holding knowledge.md, given the recogniser's line; asked only where stage 1 said yes`
      : `asked only the (moment, region) pairs stage 1 (${base.dir}) said yes to`,
    moments: ms,
    ...split(ms, lad),
    cost: cost(ms, r.answers, windowPoints),
    time: time(
      ms,
      r.answers,
      ms.filter((m) => m.answers.length > 0),
    ),
    recognition: w,
    accumulated: accumulated(ms, w),
    quota: quotaState(r.quota),
    memory: MEMORY_UNMEASURED,
    provenance: provenance(
      r,
      pl
        ? { model: pl.model, effort: pl.effort, charter: pl.charter, knowledge: pl.knowledge }
        : undefined,
    ),
  };
}

/** The chorus as the main thread sees it: stage 1 alone, or stage 1's recognition handed to stage 2's answers. */
function chorusStage(
  s1: StageReport & { moments: Moment[] },
  s2?: StageReport & { moments: Moment[] },
  r1?: Run,
  r2?: Run,
): StageReport {
  if (!s2) return { ...s1, stage: 'chorus', note: 'stage 1 alone' };
  const ms = s2.moments;
  const w = wardens(ms);
  const answers = [...(r1?.answers ?? []), ...(r2?.answers ?? [])];
  const win1 = s1.cost?.windowPoints.growth ?? null;
  const win2 = s2.cost?.windowPoints.growth ?? null;
  const c = cost(ms, answers, win1 === null && win2 === null ? null : (win1 ?? 0) + (win2 ?? 0));
  const t1 = s1.time!;
  const t2 = s2.time!;
  return {
    stage: 'chorus',
    status: 'measured',
    note: "stage 1 recognises (every region), stage 2 confirms and picks on its yeses; the main thread sees stage 2's remarks",
    goal: s2.goal,
    pointer: s2.pointer,
    cost: c,
    time: {
      call: t2.call,
      moment: {
        n: t1.moment.n,
        p50:
          t1.moment.p50 !== null && t2.addedWhenFired.wall.p50 !== null
            ? t1.moment.p50 + t2.addedWhenFired.wall.p50
            : t1.moment.p50,
        p95:
          t1.moment.p95 !== null && t2.addedWhenFired.wall.p95 !== null
            ? t1.moment.p95 + t2.addedWhenFired.wall.p95
            : t1.moment.p95,
        max:
          t1.moment.max !== null && t2.addedWhenFired.wall.max !== null
            ? t1.moment.max + t2.addedWhenFired.wall.max
            : t1.moment.max,
      },
      addedWhenFired: t2.addedWhenFired,
    },
    recognition: w,
    accumulated: accumulated(ms, w),
    quota: s2.quota,
    memory: MEMORY_UNMEASURED,
    provenance: {
      ...s2.provenance!,
      stage1: {
        model: s1.provenance!.model,
        effort: s1.provenance!.effort,
        run: s1.provenance!.run,
        tokensPerCall: s1.cost!.tokensPerCall,
      },
      stage2: {
        model: s2.provenance!.model,
        effort: s2.provenance!.effort,
        run: s2.provenance!.run,
        tokensPerCall: s2.cost!.tokensPerCall,
      },
    } as ReturnType<typeof provenance> & { stage1: object; stage2: object },
  };
}

/**
 * The paired diff against a baseline on the moments both runs saw: hit cells (region × moment where
 * the region is needed and said yes) lost and gained, per region and in all, regions whose baseline
 * hits fell to zero, and a moment-level paired bootstrap (resampling moments with replacement, 2000
 * draws, seeded) for gained − lost, Δcoverage, Δcorrectness and Δwrong chimes per moment.
 */
function pairedDiff(baseMoments: readonly Moment[], runMoments: readonly Moment[]) {
  const byKey = new Map(runMoments.map((m) => [m.key, m]));
  const pairs = baseMoments
    .filter((m) => byKey.has(m.key))
    .map((b) => ({ base: b, run: byKey.get(b.key)! }));
  const targeted = pairs.filter((p) => p.base.needed.size > 0);
  const scored = pairs.filter((p) => p.base.scorable);
  const hits = (m: Moment) => [...m.needed].filter((r) => m.shown.has(r));
  const perRegion = new Map<
    string,
    { baseHits: number; runHits: number; lost: number; gained: number }
  >();
  let lost = 0;
  let gained = 0;
  for (const p of targeted) {
    const b = new Set(hits(p.base));
    const r = new Set(hits(p.run));
    for (const region of p.base.needed) {
      const c = perRegion.get(region) ?? { baseHits: 0, runHits: 0, lost: 0, gained: 0 };
      if (b.has(region)) c.baseHits++;
      if (r.has(region)) c.runHits++;
      if (b.has(region) && !r.has(region)) {
        c.lost++;
        lost++;
      }
      if (!b.has(region) && r.has(region)) {
        c.gained++;
        gained++;
      }
      perRegion.set(region, c);
    }
  }
  const per = (m: Moment) => {
    const both = hits(m).length;
    return {
      coverage: m.needed.size ? both / m.needed.size : 0,
      correctness: m.shown.size ? both / m.shown.size : 0,
      wrong: [...m.shown].filter((r) => !m.needed.has(r)).length,
    };
  };
  // Per-moment paired differences; the bootstrap resamples these.
  const diffs = targeted.map((p) => {
    const b = per(p.base);
    const r = per(p.run);
    const bh = new Set(hits(p.base));
    const rh = new Set(hits(p.run));
    const needed = [...p.base.needed];
    return {
      net:
        needed.filter((x) => rh.has(x) && !bh.has(x)).length -
        needed.filter((x) => bh.has(x) && !rh.has(x)).length,
      coverage: r.coverage - b.coverage,
      correctness: r.correctness - b.correctness,
    };
  });
  const wrongDiffs = scored.map((p) => per(p.run).wrong - per(p.base).wrong);
  let seed = 20261015;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const bootstrap = (
    xs: readonly number[],
    draws = 2000,
  ): { mean: number | null; ci: [number, number] | null } => {
    if (!xs.length) return { mean: null, ci: null };
    const means: number[] = [];
    for (let d = 0; d < draws; d++) {
      let total = 0;
      for (let i = 0; i < xs.length; i++) total += xs[Math.floor(rand() * xs.length)]!;
      means.push(total / xs.length);
    }
    means.sort((a, b) => a - b);
    return {
      mean: round(xs.reduce((a, b) => a + b, 0) / xs.length),
      ci: [
        round(means[Math.floor(0.025 * draws)]!),
        round(means[Math.min(draws - 1, Math.floor(0.975 * draws))]!),
      ],
    };
  };
  const net = bootstrap(diffs.map((d) => d.net));
  const scale = (x: { mean: number | null; ci: [number, number] | null }, n: number) =>
    x.mean === null || !x.ci
      ? null
      : {
          mean: round(x.mean * n),
          ci: [round(x.ci[0] * n), round(x.ci[1] * n)] as [number, number],
        };
  return {
    sharedMoments: pairs.length,
    targetedMoments: targeted.length,
    hitCells: {
      baseline: [...perRegion.values()].reduce((n, c) => n + c.baseHits, 0),
      run: [...perRegion.values()].reduce((n, c) => n + c.runHits, 0),
      lost,
      gained,
      net: gained - lost,
    },
    regionsFallenToZero: [...perRegion]
      .filter(([, c]) => c.baseHits > 0 && c.runHits === 0)
      .map(([r]) => r),
    bootstrap: {
      draws: 2000,
      netHitsPerMoment: net,
      netHitsTotal: scale(net, targeted.length),
      coverage: bootstrap(diffs.map((d) => d.coverage)),
      correctness: bootstrap(diffs.map((d) => d.correctness)),
      wrongChimesPerMoment: bootstrap(wrongDiffs),
    },
    perRegion: Object.fromEntries(
      [...perRegion].sort((a, b) => b[1].baseHits - a[1].baseHits || a[0].localeCompare(b[0])),
    ),
  };
}

// ---------------------------------------------------------------------------
// Build the report
// ---------------------------------------------------------------------------
const explicitWindow = values.window?.split(',').map(Number);
if (explicitWindow && (explicitWindow.length !== 2 || explicitWindow.some(Number.isNaN)))
  throw Error('--window takes before,after percent');
const mainWindow = explicitWindow
  ? explicitWindow[1]! - explicitWindow[0]!
  : windowGrowth(main.quota);
// A --pipeline run's quota rows carry both stages: the pick phases are stage 2's window.
const pickPhase = (q: QuotaRow) => q.phase === 'pick-start' || q.phase === 'pick-end';
const pickWindow = pipelineRun ? windowGrowth(main.quota.filter(pickPhase)) : mainWindow;
const stage1Window = pipelineRun
  ? windowGrowth(main.quota.filter((q) => !pickPhase(q)))
  : mainWindow;
const s1 = recognise
  ? recogniseStage(
      recognise,
      ladderOf(recognise),
      recognise === main ? stage1Window : windowGrowth(recognise.quota),
    )
  : recogniseStage(main, ladder, mainWindow);
const s2 = recognise && stage2 ? confirmStage(stage2, recognise, ladder, pickWindow) : undefined;
const strip = <T extends { moments?: unknown }>(s: T): Omit<T, 'moments'> => {
  const { moments: _m, ...rest } = s;
  return rest;
};
const periods = [...new Set(main.probes.map((p) => p.period).filter(Boolean))];
const manifest = readJson<{ testFrom?: Record<string, string>; testShare?: number }>(
  join(dirname(resolve(values.probes)), 'manifest.json'),
);
const fixtures = {
  probesFile: resolve(values.probes),
  probes: main.probes.length,
  positives: main.probes.filter((p) => p.kind === 'positive').length,
  negatives: main.probes.filter((p) => p.kind === 'negative').length,
  targeted: main.probes.filter((p) => p.kind === 'positive' && p.gold?.target).length,
  moments: main.turns.length,
  periods,
  splitRule: manifest?.testFrom
    ? `train/test by date per project: test from ${Object.entries(manifest.testFrom)
        .map(([k, v]) => `${k} ${v.slice(0, 10)}`)
        .join(', ')} (testShare ${manifest.testShare ?? '?'})`
    : 'as sampled (no manifest beside the probes file)',
  labels: values.labels ? resolve(values.labels) : null,
  truth: values.labels
    ? 'multi-region: a yes is right when the region holds or is expected for the target'
    : 'no labels: a targeted positive needs every region asked (single-Warden cells)',
  projects: main.score?.projects ?? null,
  triggers: [...new Set(main.turns.map((t) => t.trigger ?? 'agent-action'))],
};
const report: Record<string, unknown> = {
  schema: REPORT_SCHEMA,
  generatedAt: new Date().toISOString(),
  run,
  kind: pipelineRun
    ? '--pipeline run: stage 1 recognise + stage 2 confirm and pick'
    : recognise
      ? 'stage-2 confirm over a stage-1 run (offline-derived)'
      : 'stage-1 recognise',
  fixtures,
  stages: {
    recognise: strip(s1),
    confirm: s2
      ? strip(s2)
      : {
          stage: 'confirm',
          status: 'not-run',
          note: 'no --recognise run: this run is stage 1 alone',
        },
    deliver: {
      stage: 'deliver',
      status: 'placeholder',
      note: 'what reaches the main thread and whether it changes what it builds: measured by the intervention test (Oracle replay), not yet run',
    },
    chorus: chorusStage(s1, s2, recognise, stage2),
  },
  triggerRates: { typical: triggerRates[0], busy: triggerRates[1], unit: 'moments per hour' },
};

// Baseline: the same measures on the baseline run, and deltas of the headline numbers.
type Headline = Record<string, number | null>;
const headline = (chorus: StageReport): Headline => ({
  coverage: chorus.goal?.coverage.mean ?? null,
  correctness: chorus.goal?.correctness.meanOverAll ?? null,
  majorityCorrect: chorus.goal?.majorityCorrect.rate ?? null,
  anticipated: chorus.goal?.anticipated.rate ?? null,
  pointerLeads: chorus.pointer?.leads.rate ?? null,
  pointerExact: chorus.pointer?.exact.rate ?? null,
  weightedPointsPerMoment: chorus.cost?.weighted.pointsPerMoment ?? null,
  momentsWithMiss: chorus.accumulated?.momentsWithMiss.rate ?? null,
  momentsWithWrongChime: chorus.accumulated?.momentsWithWrongChime.rate ?? null,
  wrongChimesPerMoment: chorus.accumulated?.wrongChimesPerMoment ?? null,
  tokensPerMoment: chorus.cost?.perMoment.tokens ?? null,
  windowPointsPerMoment: chorus.cost?.perMoment.windowPoints ?? null,
  callP50Ms: chorus.time?.call.all.p50 ?? null,
  momentP50Ms: chorus.time?.moment.p50 ?? null,
});
const afterHeadline = headline(
  report.stages ? (report.stages as { chorus: StageReport }).chorus : s1,
);
report.headline = afterHeadline;
// G "Run-to-run noise": the same arm run twice, paired; G "Impact" and "Recurrence": not measured yet.
if (values.repeat) {
  const again = loadRun(resolve(values.repeat));
  const againStage = recogniseStage(again, ladderOf(again), windowGrowth(again.quota));
  const againHead = headline(againStage);
  report.noise = {
    repeat: again.dir,
    headline: againHead,
    differences: Object.fromEntries(
      Object.keys(afterHeadline).map((key) => [
        key,
        afterHeadline[key] !== null && againHead[key] !== null
          ? Math.round((afterHeadline[key]! - againHead[key]!) * 1000) / 1000
          : null,
      ]),
    ),
    paired: pairedDiff(againStage.moments, s1.moments),
  };
} else report.noise = { repeat: null, note: 'no repeat of this arm given (--repeat <run>)' };
report.impact = {
  status: 'not measured',
  note: 'the intervention test: did the main thread use the pointed thing, and harm when a wrong chime lands',
};
report.recurrence = {
  status: 'not measured',
  note: 'the thesis metric: the same correction again after its rule existed and was exposed (FEEDBACK-LOG, Oracle)',
};
if (values.baseline) {
  const base = loadRun(resolve(values.baseline));
  const bs1 = recogniseStage(base, ladderOf(base), windowGrowth(base.quota));
  const baseHead = headline(bs1);
  const shared = main.probes.filter((p) => base.probes.some((b) => b.id === p.id)).length;
  report.baseline = {
    run: base.dir,
    sharedProbes: shared,
    headline: baseHead,
    deltas: Object.fromEntries(
      Object.keys(afterHeadline).map((k) => [
        k,
        afterHeadline[k] !== null && baseHead[k] !== null
          ? Math.round((afterHeadline[k]! - baseHead[k]!) * 1000) / 1000
          : null,
      ]),
    ),
    stages: { recognise: strip(bs1) },
    paired: pairedDiff(bs1.moments, (s2 ?? s1).moments),
  };
}

if (values.routing) {
  // Ranked regions per probe: those the router scored above zero, best first.
  const scores = new Map<string, { region: string; score: number }[]>();
  for (const row of readJsonl<{ fixtureId: string; wardenId: string; score: number }>(
    resolve(values.routing),
  )) {
    if (!(row.score > 0)) continue;
    scores.set(row.fixtureId, [
      ...(scores.get(row.fixtureId) ?? []),
      { region: row.wardenId, score: row.score },
    ]);
  }
  const ranked = (probeId: string) =>
    (scores.get(probeId) ?? [])
      .sort((a, b) => b.score - a.score || a.region.localeCompare(b.region))
      .map((r) => r.region);
  const routedIds = new Set(
    readJsonl<{ fixtureId: string }>(resolve(values.routing)).map((r) => r.fixtureId),
  );
  const probes = main.probes.filter((p) => routedIds.has(p.id));
  const positives = probes.filter((p) => p.kind === 'positive');
  const matched = (a: WardenProbeAnswer) => yes(a) && !!a.judged?.matches;
  const fullFanOut = new Set(main.answers.filter(matched).map((a) => a.probeId));
  report.routed = {
    scores: resolve(values.routing),
    probesWithRouting: probes.length,
    positivesWithRouting: positives.length,
    fullFanOutOnThese: asRate(
      positives.filter((p) => fullFanOut.has(p.id)).length,
      positives.length,
    ),
    atK: Object.fromEntries(
      [2, 4, 8].map((k) => {
        const routedFor = (probeId: string) => new Set(ranked(probeId).slice(0, k));
        const said = new Set(
          main.answers
            .filter((a) => matched(a) && routedFor(a.probeId).has(a.domain))
            .map((a) => a.probeId),
        );
        const turns = main.turns.filter((t) => routedIds.has(t.probeId));
        return [
          k,
          {
            anticipated: asRate(positives.filter((p) => said.has(p.id)).length, positives.length),
            askedPerMoment: rate(
              turns.reduce((n, t) => n + Math.min(k, ranked(t.probeId).length), 0),
              turns.length,
            ),
          },
        ];
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Render REPORT.md
// ---------------------------------------------------------------------------
const f = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined ? '–' : Number.isInteger(x) ? String(x) : x.toFixed(d);
const r = (x: Rate | undefined) =>
  x ? `${x.n}/${x.d} = ${f(x.rate)}${x.ci ? ` [${f(x.ci[0])}–${f(x.ci[1])}]` : ''}` : '–';
const s = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`;
const k = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '–'
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(n);
function renderStage(st: StageReport, title: string): string {
  const out: string[] = [`## ${title}`, ''];
  if (st.status !== 'measured') {
    out.push(`*${st.status}* — ${st.note ?? ''}`, '');
    return out.join('\n');
  }
  if (st.note) out.push(`_${st.note}_`, '');
  const e = st.goal!;
  const pl = st.pointer!;
  const c = st.cost!;
  const t = st.time!;
  const w = st.recognition!;
  const a = st.accumulated!;
  const p = st.provenance!;
  out.push(
    '### 1. Goal (coverage, correctness) and pointer',
    '',
    '| measure | value |',
    '|---|---|',
    `| targeted moments (negatives; positives excluded for no doc target) | ${e.moments} (${e.negatives}; ${e.excludedPositives}) |`,
    `| coverage, mean over moments (needed regions shown ÷ needed) | **${f(e.coverage.mean)}**; fully covered ${r(e.coverage.full)} |`,
    `| correctness, mean over all moments (needed shown ÷ shown; silent = 0) | **${f(e.correctness.meanOverAll)}**; over spoken moments ${f(e.correctness.meanOverSpoken)}; silent moments ${r(e.correctness.silentMoments)} |`,
    `| majority-correct (correctness > 0.5) | ${r(e.majorityCorrect)} |`,
    `| anticipated (a remark the judge matched to the correction) | ${r(e.anticipated)} |`,
    `| pointer ladder, best rung per moment (exact / candidates / class / wrong / silent / unjudged) | ${POINTER_LEVELS.map((l) => pl.byMomentBestRung[l]).join(' / ')} / ${pl.byMomentBestRung.silent} / ${pl.byMomentBestRung.unjudged}; leads ${r(pl.leads)}; exact ${r(pl.exact)} |`,
    `| goal (coverage and correctness both > 0.5) | ${e.goalMet ? 'MET' : 'not met'} |`,
    '',
    `By axis (INVENTORY.md H; cells under ${AXIS_MIN_N} moments are too few to rate):`,
    '',
    '| axis | value | n | coverage | correctness | majority-correct | pointer leads |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(e.byAxis).flatMap(([axis, cells]) =>
      Object.entries(cells).map(([value, c]) =>
        c.tooFew
          ? `| ${axis} | ${value} | ${c.n} | too few | | | |`
          : `| ${axis} | ${value} | ${c.n} | ${f(c.coverage)} | ${f(c.correctness)} | ${r(c.majorityCorrect)} | ${r(c.pointerLeads)} |`,
      ),
    ),
    '',
    '### 2. Cost',
    '',
    '| measure | value |',
    '|---|---|',
    `| calls (errors) | ${c.calls} (${c.errors}) |`,
    `| tokens: input / cache read / cache write / output / thinking | ${k(c.tokens.input)} / ${k(c.tokens.cacheRead)} / ${k(c.tokens.cacheWrite)} / ${k(c.tokens.output)} / ${k(c.tokens.thinking)} — total ${k(c.tokens.total)}, ${k(c.tokensPerCall)} per call, cache-read share ${f(c.cacheReadShare)} |`,
    `| shared five-hour window growth while running (upper bound; others' spend included) | ${f(c.windowPoints.growth)} points |`,
    `| per moment | ${f(c.perMoment.calls)} calls, ${k(c.perMoment.tokens)} tokens, ${f(c.perMoment.windowPoints, 3)} window points |`,
    `| projected per hour at ${c.projectedPerHour.typical.momentsPerHour} moments/h (typical) | ${c.projectedPerHour.typical.calls} calls, ${k(c.projectedPerHour.typical.tokens)} tokens, ${f(c.projectedPerHour.typical.windowPoints)} window points |`,
    `| projected per hour at ${c.projectedPerHour.busy.momentsPerHour} moments/h (busy) | ${c.projectedPerHour.busy.calls} calls, ${k(c.projectedPerHour.busy.tokens)} tokens, ${f(c.projectedPerHour.busy.windowPoints)} window points |`,
    `| weighted tokens (input 1, cache read 0.1, cache write 2, output 5, thinking 5) | ${k(c.weighted.tokens)}, ${k(c.weighted.perMoment)} per moment → ${f(c.weighted.pointsPerMoment, 4)} pts/moment; ${f(c.weighted.pointsPerHour.typical)} pts/h typical, ${f(c.weighted.pointsPerHour.busy)} busy (fixed coefficient) |`,
    '',
    '### 3. Time',
    '',
    '| measure | p50 | p95 | max | n |',
    '|---|---|---|---|---|',
    `| per call, all | ${s(t.call.all.p50)} | ${s(t.call.all.p95)} | ${s(t.call.all.max)} | ${t.call.all.n} |`,
    `| per call, warm (cache read ≥ write) | ${s(t.call.warm.p50)} | ${s(t.call.warm.p95)} | ${s(t.call.warm.max)} | ${t.call.warm.n} |`,
    `| per call, cold (priming) | ${s(t.call.cold.p50)} | ${s(t.call.cold.p95)} | ${s(t.call.cold.max)} | ${t.call.cold.n} |`,
    `| per moment (wall, every call in flight) | ${s(t.moment.p50)} | ${s(t.moment.p95)} | ${s(t.moment.max)} | ${t.moment.n} |`,
    `| added only when fired (moments fired ${r(t.addedWhenFired.momentsFired)}) | ${s(t.addedWhenFired.wall.p50)} | ${s(t.addedWhenFired.wall.p95)} | ${s(t.addedWhenFired.wall.max)} | ${t.addedWhenFired.wall.n} |`,
    '',
    '### 4. Per-Warden individual error',
    '',
    `regions ${w.regions}, speaking ${w.speaking}, never fired ${w.neverFired}; macro precision ${f(w.macroPrecision)} / recall ${f(w.macroRecall)}; regions at precision ≥ 0.8: ${r(w.precisionAtLeast80)}; mean miss rate ${f(w.meanMissRate)}; mean false-positive rate ${f(w.meanFalsePositiveRate, 3)}`,
    '',
    '| region | calls | own moments | miss (silent on own ÷ own asked) | false positive (wrong yes ÷ calls on not-own) | yes | right | wrong | precision | recall |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const [region, x] of Object.entries(w.perRegion)) {
    if (x.ownMoments === 0 && x.yes === 0) continue;
    out.push(
      `| ${region} | ${x.calls} | ${x.ownMoments} | ${r(x.miss)} | ${r(x.falsePositive)} | ${x.yes} | ${x.rightYes} | ${x.wrongYes} | ${r(x.precision)} | ${r(x.recall)} |`,
    );
  }
  const quiet = Object.entries(w.perRegion).filter(
    ([, x]) => x.ownMoments === 0 && x.yes === 0,
  ).length;
  if (quiet)
    out.push(
      '',
      `(${quiet} regions asked that own no moment and never fired are left out of the table.)`,
    );
  out.push(
    '',
    '### 5. Accumulated error',
    '',
    '| measure | value |',
    '|---|---|',
    `| moments with ≥ 1 miss (no needed region shown) | ${r(a.momentsWithMiss)} |`,
    `| moments with ≥ 1 wrong chime | ${r(a.momentsWithWrongChime)} |`,
    `| wrong chimes per moment, measured | ${f(a.wrongChimesPerMoment)} |`,
    `| compounding: ${f(a.regionsAskedPerMoment, 1)} regions asked per moment × mean per-Warden FP ${f(a.meanWardenFalsePositiveRate, 3)} | ${f(a.expectedWrongChimesPerMoment)} expected wrong chimes per moment |`,
    '',
    '### 6. Quota state and memory',
    '',
    '| measure | value |',
    '|---|---|',
    `| five-hour window start → end | ${f(st.quota?.fiveHour.start)} → ${f(st.quota?.fiveHour.end)} % (${st.quota?.probes ?? 0} probes; shared login) |`,
    `| seven-day window start → end | ${f(st.quota?.sevenDay.start)} → ${f(st.quota?.sevenDay.end)} % |`,
    `| host RSS per warm session / per thread | ${st.memory?.rssPerWarmSessionMb ?? '–'} / ${st.memory?.rssPerThreadMb ?? '–'} MB (${st.memory?.note ?? ''}) |`,
    '',
    '### 7. Provenance',
    '',
    '| field | value |',
    '|---|---|',
    `| run | \`${p.run}\` (${p.answers}) |`,
    `| model, effort, MAX_THINKING_TOKENS | ${p.model}, ${p.effort}, ${p.thinkingTokens ?? 'unset'} |`,
    `| charter | ${p.charter ?? '–'} (${p.charterLabel ?? '–'}) |`,
    `| knowledge held | ${p.knowledgeFile ?? '–'}${p.recogniseFallback?.length ? `; fell back to knowledge.md for ${p.recogniseFallback.length} regions (${p.recogniseFallback.join(', ')})` : ''} |`,
    `| regions | ${p.regions ?? '–'}${p.regionsDir ? ` (\`${p.regionsDir}\`)` : ''}${p.knowledge ? `; knowledge \`${p.knowledge}\`` : ''}; roster ${p.roster ?? '–'} |`,
    `| machine load (1 min avg) min / mean / max | ${p.load ? `${f(p.load.min, 0)} / ${f(p.load.mean, 0)} / ${f(p.load.max, 0)}` : '–'} |`,
    `| shared window | ${p.sharedWindow ? "yes: the five-hour window is the whole machine's Claude login" : 'no'} |`,
  );
  const extra = p as unknown as {
    stage1?: { model: string; effort: string; tokensPerCall: number | null };
    stage2?: { model: string; effort: string; tokensPerCall: number | null };
  };
  if (extra.stage1 && extra.stage2)
    out.push(
      `| stages | 1: ${extra.stage1.model} ${extra.stage1.effort}, ${k(extra.stage1.tokensPerCall)} tokens per call; 2: ${extra.stage2.model} ${extra.stage2.effort}, ${k(extra.stage2.tokensPerCall)} tokens per call (stage 1 holding the short recognise.md is the token drop against stage 2) |`,
    );
  out.push('');
  return out.join('\n');
}
function renderReport(): string {
  const st = report.stages as Record<'recognise' | 'confirm' | 'deliver' | 'chorus', StageReport>;
  const fx = fixtures;
  const out: string[] = [
    `# Warden eval report — ${basename(run)}`,
    '',
    `Schema \`${REPORT_SCHEMA}\`, generated ${(report.generatedAt as string).slice(0, 19)}Z. ${report.kind as string}. Docs: \`foundry/docs/EVAL-REPORTING.md\`.`,
    '',
    '## Fixtures',
    '',
    '| field | value |',
    '|---|---|',
    `| probes | ${fx.probes} (${fx.positives} positive, ${fx.targeted} with a doc target; ${fx.negatives} negative); ${fx.moments} moments (turns: ${fx.triggers.join(', ')}) |`,
    `| period / split | ${fx.periods.join(', ') || '–'}; ${fx.splitRule} |`,
    `| truth | ${fx.truth}${fx.labels ? ` (\`${fx.labels}\`)` : ''} |`,
    `| probes file | \`${fx.probesFile}\` |`,
    '',
  ];
  const b = report.baseline as
    | { run: string; sharedProbes: number; headline: Headline; deltas: Headline }
    | undefined;
  out.push(
    '## Headline (chorus roll-up)',
    '',
    `| measure | this run |${b ? ' baseline | delta |' : ''}`,
    `|---|---|${b ? '---|---|' : ''}`,
  );
  for (const [key, v] of Object.entries(afterHeadline))
    out.push(
      `| ${key} | ${f(v, 3)} |${b ? ` ${f(b.headline[key], 3)} | ${b.deltas[key] === null ? '–' : (b.deltas[key]! >= 0 ? '+' : '') + f(b.deltas[key], 3)} |` : ''}`,
    );
  if (b)
    out.push(
      '',
      `Baseline: \`${b.run}\` (${b.sharedProbes} shared probes). Deltas are this run minus the baseline.`,
    );
  out.push('');
  const pd = (report.baseline as { paired?: ReturnType<typeof pairedDiff> } | undefined)?.paired;
  if (pd) {
    const bs = (x: { mean: number | null; ci: [number, number] | null }) =>
      `${f(x.mean, 3)}${x.ci ? ` [${f(x.ci[0], 3)} – ${f(x.ci[1], 3)}]` : ''}`;
    out.push(
      '### Paired diff against the baseline (shared moments)',
      '',
      '| measure | value |',
      '|---|---|',
      `| shared moments (targeted) | ${pd.sharedMoments} (${pd.targetedMoments}) |`,
      `| hit cells (region × moment, needed and shown): baseline → this run | ${pd.hitCells.baseline} → ${pd.hitCells.run}; lost ${pd.hitCells.lost}, gained ${pd.hitCells.gained}, net ${pd.hitCells.net >= 0 ? '+' : ''}${pd.hitCells.net} |`,
      `| regions with a baseline hit that fell to zero | ${pd.regionsFallenToZero.length ? pd.regionsFallenToZero.join(', ') : 'none'} |`,
      `| bootstrap (${pd.bootstrap.draws} moment resamples), net hits in total | ${pd.bootstrap.netHitsTotal ? `${f(pd.bootstrap.netHitsTotal.mean)} [${f(pd.bootstrap.netHitsTotal.ci[0])} – ${f(pd.bootstrap.netHitsTotal.ci[1])}]` : '–'} |`,
      `| Δ coverage (mean per moment) | ${bs(pd.bootstrap.coverage)} |`,
      `| Δ correctness (mean per moment) | ${bs(pd.bootstrap.correctness)} |`,
      `| Δ wrong chimes per moment | ${bs(pd.bootstrap.wrongChimesPerMoment)} |`,
      '',
      '| region | baseline hits | this run | lost | gained |',
      '|---|---|---|---|---|',
    );
    for (const [region, c] of Object.entries(pd.perRegion))
      if (c.baseHits || c.runHits)
        out.push(`| ${region} | ${c.baseHits} | ${c.runHits} | ${c.lost} | ${c.gained} |`);
    out.push('');
  }
  out.push(renderStage(st.recognise, 'Stage 1 — recognise (every region asked)'));
  out.push(renderStage(st.confirm, "Stage 2 — confirm and pick (on stage 1's yeses)"));
  out.push(renderStage(st.deliver, 'Stage 3 — deliver to the main thread'));
  out.push(renderStage(st.chorus, 'Chorus roll-up (what the main thread sees)'));
  const noise = report.noise as { repeat: string | null; differences?: Headline };
  out.push('## Run-to-run noise, impact, recurrence', '');
  if (noise.repeat && noise.differences) {
    out.push(
      `Repeat: \`${noise.repeat}\` (this run minus the repeat).`,
      '',
      '| measure | difference |',
      '|---|---|',
    );
    for (const [key, v] of Object.entries(noise.differences)) out.push(`| ${key} | ${f(v, 3)} |`);
    out.push('');
  } else out.push('Run-to-run noise: no repeat of this arm given.', '');
  out.push('Impact: not measured (intervention test). Recurrence: not measured (Oracle).', '');
  const routed = report.routed as
    | { atK: Record<string, { anticipated: Rate; askedPerMoment: number | null }> }
    | undefined;
  if (routed) {
    out.push(
      '## Routed at k (offline, same answers)',
      '',
      '| k | anticipated | asked per moment |',
      '|---|---|---|',
    );
    for (const [kk, v] of Object.entries(routed.atK))
      out.push(`| ${kk} | ${r(v.anticipated)} | ${f(v.askedPerMoment)} |`);
    out.push('');
  }
  out.push(
    '---',
    '',
    "Definitions: a moment is one turn (probe × trigger). Needed = the regions that hold or are expected for the moment's target; shown = the regions that said yes. Coverage = |needed ∩ shown| ÷ |needed|; correctness = |needed ∩ shown| ÷ |shown| (silent moments count 0 in the all-moments mean and are reported apart). Miss rate = own moments the Warden was asked and stayed silent ÷ own moments asked. False-positive rate = wrong yeses ÷ calls on scorable moments it does not own. Rates carry n/d and a Wilson 95% interval. Window points are the shared five-hour window's growth while the run ran: an upper bound on its own spend.",
    '',
  );
  return out.join('\n');
}

const outFile = values.out ? resolve(values.out) : join(run, 'report.json');
writeFileSync(outFile, JSON.stringify(report, null, 1), { mode: 0o600 });
const mdFile = join(
  dirname(outFile),
  basename(outFile).replace(/\.json$/, '') === 'report'
    ? 'REPORT.md'
    : `${basename(outFile).replace(/\.json$/, '')}.md`,
);
writeFileSync(mdFile, renderReport(), { mode: 0o600 });

// A finding record generated from the report: one line, a pointer to the report, the headline numbers.
if (values.finding) {
  if (!values.experiment || !values.layer || !values.change)
    throw Error('--finding needs --experiment, --layer and --change');
  const h = afterHeadline;
  const chorus = (report.stages as { chorus: StageReport }).chorus;
  const b = report.baseline as { run: string; headline: Headline } | undefined;
  const metrics = (hd: Headline, st?: StageReport) => ({
    coverage: hd.coverage,
    correctness: hd.correctness,
    majority_correct: hd.majorityCorrect,
    anticipated: hd.anticipated,
    pointer: st?.pointer
      ? Object.fromEntries(POINTER_LEVELS.map((l) => [l, st.pointer!.byMomentBestRung[l]]))
      : { exact: null, candidates: null, class: null, wrong: null },
    moments_with_wrong_chime: hd.momentsWithWrongChime,
    wrong_chimes_per_moment: hd.wrongChimesPerMoment,
    tokens_per_moment: hd.tokensPerMoment,
    latency_p50_ms: hd.callP50Ms,
    quota_points: chorus.cost?.windowPoints.growth ?? null,
  });
  const summary = `coverage ${f(h.coverage)}, correctness ${f(h.correctness)}, majority-correct ${f(h.majorityCorrect)}, anticipated ${f(h.anticipated)}, wrong chimes/moment ${f(h.wrongChimesPerMoment)}, ${k(h.tokensPerMoment)} tok/moment, call p50 ${s(h.callP50Ms)}`;
  const record = {
    experiment: values.experiment,
    layer: values.layer,
    change: values.change,
    fixtures: {
      set: relative(join(homedir(), '.foundry', 'evals'), fixtures.probesFile),
      n_pos: fixtures.positives,
      n_neg: fixtures.negatives,
      period: fixtures.periods.join('+') || 'unknown',
    },
    metrics: metrics(h, chorus),
    baseline: b
      ? {
          ref: relative(join(homedir(), '.foundry', 'evals'), b.run),
          metrics: metrics(
            b.headline,
            (report.baseline as { stages: { recognise: StageReport } }).stages.recognise,
          ),
        }
      : { ref: null, metrics: {} },
    regions: chorus.provenance?.regions ?? null,
    date: new Date().toISOString().slice(0, 10),
    notes: `${summary}. Report: ${mdFile}`,
  };
  const findingFile = resolve(values.finding);
  writeFileSync(findingFile, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
  console.error(`finding: ${findingFile}`);
}
console.log(
  JSON.stringify({ run, headline: afterHeadline, report: outFile, markdown: mdFile }, null, 1),
);
console.error(`report: ${outFile}\nmarkdown: ${mdFile}`);
