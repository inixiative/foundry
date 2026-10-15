#!/usr/bin/env bun
import { createHash } from 'node:crypto';
/**
 * Report a charter eval run (scripts/evals/warden-charter.ts) the way the Warden "after" score is read:
 * anticipated corrections with confidence intervals, the pointer ladder, how many Wardens fire per
 * moment, latency, errors, tokens and quota, and a paired comparison against another run on the same
 * probes.
 *
 *   bun scripts/evals/warden-charter-report.ts --run <run dir> --probes <probes.jsonl> \
 *     [--baseline <run dir>] [--judge-pointers] [--out <report.json>]
 *
 * --judge-pointers grades every remark made on a positive probe with a labelled target on the pointer
 * ladder (exact / candidates / class / wrong; Opus, as the size test does), cached in the run's
 * pointer-ladder.jsonl so a re-report asks nothing again. A probe's rung is its best pointer's. The
 * baseline is scored on the probes both runs asked, and the paired table (both / after only /
 * baseline only / neither) says whether the difference is more than noise. Reads the run; writes only
 * the pointer cache and the report (default <run>/report.json).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type CharterScore,
  POINTER_LEVELS,
  type PointerLevel,
  parseWardenPointerJudgement,
  scoreCharterRun,
  WARDEN_POINTER_JUDGE_PROMPT,
  type WardenPointerJudgement,
  type WardenProbe,
  type WardenProbeAnswer,
  type WardenProbeTrigger,
  type WardenProbeTurn,
  wardenPointerJudgeMessage,
  wilsonInterval,
} from '../../packages/core/src';
import { markEvalRun } from '../../packages/foundry/src/feedback/charter-eval';
import { decisionHost, privateDirectory } from '../../packages/foundry/src/providers/decision-host';

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    probes: { type: 'string' },
    baseline: { type: 'string' },
    'judge-pointers': { type: 'boolean' },
    out: { type: 'string' },
  },
});
if (!values.run || !values.probes) {
  console.error('usage: warden-charter-report.ts --run <dir> --probes <jsonl> [--baseline <dir>]');
  process.exit(2);
}
const run = resolve(values.run);
const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
const probesById = new Map(
  readJsonl<WardenProbe>(resolve(values.probes)).map((p) => [p.id, p] as const),
);
const loadRun = (dir: string) => {
  const turns = readJsonl<WardenProbeTurn>(join(dir, 'turns.jsonl'));
  // Judged answers when a rejudge wrote them; else the run's own.
  const answersFile = existsSync(join(dir, 'answers.rejudged.jsonl'))
    ? 'answers.rejudged.jsonl'
    : 'answers.jsonl';
  const finished = new Set(turns.map((t) => `${t.probeId}|${t.trigger ?? 'agent-action'}`));
  const answers = readJsonl<WardenProbeAnswer>(join(dir, answersFile)).filter((a) =>
    finished.has(`${a.probeId}|${a.trigger ?? 'agent-action'}`),
  );
  const probes = [...new Set(turns.map((t) => t.probeId))]
    .map((id) => probesById.get(id))
    .filter((p): p is WardenProbe => !!p);
  return { dir, turns, answers, probes, answersFile };
};
const after = loadRun(run);

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
const momentOf = (p: WardenProbe) =>
  [p.ask ? `User message:\n${p.ask}` : '', p.moment ? `Agent turn:\n${p.moment}` : '']
    .filter(Boolean)
    .join('\n\n');
if (values['judge-pointers']) {
  const pending = after.answers.filter((a) => {
    const p = probesById.get(a.probeId);
    return (
      p?.kind === 'positive' &&
      p.gold?.target &&
      !a.noComment &&
      !a.error &&
      a.text &&
      !ladder.has(pointerKey(a.probeId, a.text))
    );
  });
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
const pct = (sorted: readonly number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
    : null;
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const withCI = (n: number, d: number) => ({ n, d, rate: rate(n, d), ci: wilsonInterval(n, d) });
const yes = (a: WardenProbeAnswer) => !a.noComment && !a.error;
const matched = (a: WardenProbeAnswer) => yes(a) && !!a.judged?.matches;
const errorClass = (e: string) =>
  /input cap|budget/i.test(e)
    ? 'cap'
    : /timed? ?out/i.test(e)
      ? 'timeout'
      : /not-admitted/i.test(e)
        ? 'not-admitted'
        : 'other';

function measure(r: ReturnType<typeof loadRun>, probes: readonly WardenProbe[]) {
  const ids = new Set(probes.map((p) => p.id));
  const answers = r.answers.filter((a) => ids.has(a.probeId));
  const turns = r.turns.filter((t) => ids.has(t.probeId));
  const score: CharterScore = scoreCharterRun(probes, answers, turns);
  const positives = probes.filter((p) => p.kind === 'positive');
  const negatives = probes.filter((p) => p.kind === 'negative');
  const saidFirst = new Set(answers.filter(matched).map((a) => a.probeId));
  const anticipatedOn = (ps: readonly WardenProbe[]) =>
    withCI(ps.filter((p) => saidFirst.has(p.id)).length, ps.length);
  const targeted = positives.filter((p) => p.gold?.target);
  const human = positives.filter((p) => !p.authorship || p.authorship.by === 'human');
  const agent = positives.filter((p) => p.authorship?.by === 'agent');
  const weighted = (() => {
    const total = positives.reduce((n, p) => n + (p.weight ?? 1), 0);
    const said = positives
      .filter((p) => saidFirst.has(p.id))
      .reduce((n, p) => n + (p.weight ?? 1), 0);
    return rate(said, total);
  })();
  // Per trigger: over the probes that trigger asked.
  const byTrigger = Object.fromEntries(
    (['user-message', 'agent-action'] as WardenProbeTrigger[]).map((trigger) => {
      const asked = new Set(
        turns.filter((t) => (t.trigger ?? 'agent-action') === trigger).map((t) => t.probeId),
      );
      const pos = positives.filter((p) => asked.has(p.id));
      const said = new Set(
        answers
          .filter((a) => (a.trigger ?? 'agent-action') === trigger && matched(a))
          .map((a) => a.probeId),
      );
      const remarks = answers.filter((a) => (a.trigger ?? 'agent-action') === trigger && yes(a));
      return [
        trigger,
        {
          turns: turns.filter((t) => (t.trigger ?? 'agent-action') === trigger).length,
          positives: pos.length,
          anticipated: withCI(pos.filter((p) => said.has(p.id)).length, pos.length),
          remarks: remarks.length,
          wrongRemarks: remarks.filter((a) => !a.judged?.matches).length,
        },
      ];
    }),
  );
  // Pointer ladder: a targeted positive's best rung over its pointers (any trigger).
  const rank: Record<PointerLevel, number> = { exact: 0, candidates: 1, class: 2, wrong: 3 };
  const bestRung = (p: WardenProbe): PointerLevel | 'none' | 'unjudged' => {
    const mine = answers.filter((a) => a.probeId === p.id && yes(a) && a.text);
    if (!mine.length) return 'none';
    const levels = mine
      .map((a) => ladder.get(pointerKey(a.probeId, a.text!))?.level)
      .filter((l): l is PointerLevel => !!l);
    if (!levels.length) return 'unjudged';
    return levels.sort((a, b) => rank[a] - rank[b])[0]!;
  };
  const rungs = targeted.map(bestRung);
  const pointerLadder = {
    targetedPositives: targeted.length,
    byProbeBestRung: Object.fromEntries(
      [...POINTER_LEVELS, 'none', 'unjudged'].map((l) => [l, rungs.filter((r) => r === l).length]),
    ),
    leads: withCI(
      rungs.filter((r) => r !== 'none' && r !== 'unjudged' && r !== 'wrong').length,
      targeted.length,
    ),
    exact: withCI(rungs.filter((r) => r === 'exact').length, targeted.length),
    pointers: (() => {
      const all = answers
        .filter((a) => yes(a) && a.text && probesById.get(a.probeId)?.gold?.target)
        .map((a) => ladder.get(pointerKey(a.probeId, a.text!))?.level ?? 'unjudged');
      return Object.fromEntries(
        [...POINTER_LEVELS, 'unjudged'].map((l) => [l, all.filter((x) => x === l).length]),
      );
    })(),
  };
  // Load per moment: Wardens that said yes on each turn.
  const yesPerTurn = turns.map(
    (t) =>
      answers.filter(
        (a) =>
          a.probeId === t.probeId &&
          (a.trigger ?? 'agent-action') === (t.trigger ?? 'agent-action') &&
          yes(a),
      ).length,
  );
  const sortedYes = [...yesPerTurn].sort((a, b) => a - b);
  const negativeTurns = turns.filter((t) => negatives.some((p) => p.id === t.probeId));
  const negYes = negativeTurns.map(
    (t) =>
      answers.filter(
        (a) =>
          a.probeId === t.probeId &&
          (a.trigger ?? 'agent-action') === (t.trigger ?? 'agent-action') &&
          yes(a),
      ).length,
  );
  const perWarden = new Map<
    string,
    { calls: number; yes: number; matched: number; errors: number }
  >();
  for (const a of answers) {
    const w = perWarden.get(a.domain) ?? { calls: 0, yes: 0, matched: 0, errors: 0 };
    w.calls++;
    if (a.error) w.errors++;
    if (yes(a)) w.yes++;
    if (matched(a)) w.matched++;
    perWarden.set(a.domain, w);
  }
  const elapsed = answers
    .filter((a) => !a.error)
    .map((a) => a.elapsedMs ?? 0)
    .sort((a, b) => a - b);
  const walls = turns.map((t) => t.wallMs).sort((a, b) => a - b);
  const errors = answers.filter((a) => a.error).map((a) => errorClass(a.error!));
  const tokens = answers.reduce(
    (n, a) =>
      n + (a.tokens ? a.tokens.input + (a.tokens.cacheRead ?? 0) + (a.tokens.cacheWrite ?? 0) : 0),
    0,
  );
  const inputPerCall = answers
    .filter((a) => a.tokens)
    .map((a) => a.tokens!.input + (a.tokens!.cacheRead ?? 0) + (a.tokens!.cacheWrite ?? 0))
    .sort((a, b) => a - b);
  return {
    probes: probes.length,
    positives: positives.length,
    negatives: negatives.length,
    turns: turns.length,
    calls: answers.length,
    anticipated: anticipatedOn(positives),
    weightedAnticipated: weighted,
    anticipatedOnTargeted: anticipatedOn(targeted),
    anticipatedHumanAuthored: anticipatedOn(human),
    anticipatedAgentAuthored: anticipatedOn(agent),
    byTrigger,
    pointerLadder,
    silencePrecision: score.silencePrecision,
    speakPrecision: score.speakPrecision,
    scopeViolations: score.scopeViolations,
    remarks: score.remarks,
    wrongRemarks: score.wrongRemarks,
    wrongRemarksPerMoment: rate(score.wrongRemarks, turns.length),
    negativeMoments: {
      count: negativeTurns.length,
      withAnyYes: withCI(negYes.filter((n) => n > 0).length, negativeTurns.length),
      yesPerMoment: rate(
        negYes.reduce((a, b) => a + b, 0),
        negativeTurns.length,
      ),
    },
    yesPerMoment: {
      mean: rate(
        yesPerTurn.reduce((a, b) => a + b, 0),
        yesPerTurn.length,
      ),
      p50: pct(sortedYes, 50),
      p95: pct(sortedYes, 95),
      max: sortedYes.at(-1) ?? null,
      silentMoments: yesPerTurn.filter((n) => n === 0).length,
    },
    perWarden: Object.fromEntries(
      [...perWarden].sort((a, b) => b[1].yes - a[1].yes).map(([d, w]) => [d, w]),
    ),
    latency: {
      callP50Ms: pct(elapsed, 50),
      callP95Ms: pct(elapsed, 95),
      callMaxMs: elapsed.at(-1) ?? null,
      turnP50Ms: pct(walls, 50),
      turnP95Ms: pct(walls, 95),
      turnMaxMs: walls.at(-1) ?? null,
      callsPerTurn: score.turns?.callsPerTurn ?? null,
    },
    errors: {
      total: errors.length,
      ...Object.fromEntries(
        ['cap', 'timeout', 'not-admitted', 'other'].map((c) => [
          c,
          errors.filter((e) => e === c).length,
        ]),
      ),
      retriedCalls: answers.filter((a) => a.retried?.length).length,
    },
    tokens: {
      total: tokens,
      perCallP50: pct(inputPerCall, 50),
      perCallP95: pct(inputPerCall, 95),
      cacheReadShare: rate(
        answers.reduce((n, a) => n + (a.tokens?.cacheRead ?? 0), 0),
        tokens,
      ),
    },
  };
}

/** The five-hour window's growth across the run's quota probes (a drop is the window rolling or a reset). */
function quota(dir: string) {
  const rows = readJsonl<{
    at: string;
    phase: string;
    windows?: Record<string, number>;
    load?: string;
  }>(join(dir, 'quota.jsonl')).filter((r) => r.windows?.five_hour !== undefined);
  if (!rows.length) return undefined;
  let growth = 0;
  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1]!.windows!.five_hour!;
    const after = rows[i]!.windows!.five_hour!;
    growth += after >= before ? after - before : after;
  }
  const loads = rows
    .map((r) => /load averages?: ([\d.]+)/.exec(r.load ?? '')?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
  return {
    observations: rows.length,
    first: rows[0]!.windows,
    last: rows.at(-1)!.windows,
    fiveHourGrowthPercent: growth,
    pauses: rows.filter((r) => r.phase === 'gate').length,
    loadAvg1m: {
      min: Math.min(...loads),
      max: Math.max(...loads),
      mean: rate(
        loads.reduce((a, b) => a + b, 0),
        loads.length,
      ),
    },
  };
}

const afterMeasure = measure(after, after.probes);
const q = quota(run);
const report: Record<string, unknown> = {
  run,
  probesFile: resolve(values.probes),
  answers: after.answersFile,
  roster: [...new Set(after.answers.map((a) => a.domain))].length,
  after: afterMeasure,
  quota: q && {
    ...q,
    percentPerMillionTokens: afterMeasure.tokens.total
      ? Math.round((q.fiveHourGrowthPercent / afterMeasure.tokens.total) * 1e6 * 1000) / 1000
      : null,
    percentPerMoment: afterMeasure.turns
      ? Math.round((q.fiveHourGrowthPercent / afterMeasure.turns) * 1000) / 1000
      : null,
  },
};
if (values.baseline) {
  const base = loadRun(resolve(values.baseline));
  const shared = after.probes.filter((p) => base.probes.some((b) => b.id === p.id));
  const saidBy = (r: ReturnType<typeof loadRun>) =>
    new Set(r.answers.filter(matched).map((a) => a.probeId));
  const a = saidBy(after);
  const b = saidBy(base);
  const pos = shared.filter((p) => p.kind === 'positive');
  report.baseline = {
    run: base.dir,
    sharedProbes: shared.length,
    sharedPositives: pos.length,
    baseline: measure(base, shared),
    afterOnShared: measure(after, shared),
    paired: {
      both: pos.filter((p) => a.has(p.id) && b.has(p.id)).length,
      afterOnly: pos.filter((p) => a.has(p.id) && !b.has(p.id)).length,
      baselineOnly: pos.filter((p) => !a.has(p.id) && b.has(p.id)).length,
      neither: pos.filter((p) => !a.has(p.id) && !b.has(p.id)).length,
    },
  };
}
const outFile = values.out ? resolve(values.out) : join(run, 'report.json');
writeFileSync(outFile, JSON.stringify(report, null, 1), { mode: 0o600 });
console.log(JSON.stringify(report, null, 1));
console.error(`report: ${outFile}`);
