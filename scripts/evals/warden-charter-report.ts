#!/usr/bin/env bun
/**
 * Report a charter eval run (scripts/evals/warden-charter.ts) the way the Warden "after" score is read:
 * anticipated corrections with confidence intervals, the pointer ladder, how many Wardens fire per
 * moment, latency, errors, tokens and quota, and a paired comparison against another run on the same
 * probes.
 *
 *   bun scripts/evals/warden-charter-report.ts --run <run dir> --probes <probes.jsonl> \
 *     [--baseline <run dir>] [--judge-pointers] [--routing <scores.jsonl>] [--labels <labels.json>] \
 *     [--out <report.json>]
 *
 * --routing takes a router run's per-moment scores (`warden-prefilter.ts measure`: one
 * `{fixtureId, wardenId, score}` row per probe and region) and scores the same answers again as if only
 * the routed regions had been asked: at k = 2, 4, 8 the routed set is the top-k regions by score, among
 * those scored above zero. "Anticipated when routed" beside the full fan-out number is what routing
 * costs; the regions firing per moment sizes the live warm set.
 *
 * --judge-pointers grades every remark made on a positive probe with a labelled target on the pointer
 * ladder (exact / candidates / class / wrong; Opus, as the size test does), cached in the run's
 * pointer-ladder.jsonl so a re-report asks nothing again. A probe's rung is its best pointer's. The
 * baseline is scored on the probes both runs asked, and the paired table (both / after only /
 * baseline only / neither) says whether the difference is more than noise. Reads the run; writes only
 * the pointer cache and the report (default <run>/report.json).
 *
 * --labels takes the region labels per probe (`warden-prefilter.ts label-regions`: for each targeted
 * positive the regions `expected` to answer and those whose knowledge `held` the target) and adds the
 * chorus's domain recognition, apart from what the judge made of the remarks: chorus recall = targeted
 * positives where at least one labelled region said yes; chorus false-yes = moments where a region
 * outside the labels (any region, on a negative) said yes; and per region, precision and recall of its
 * yes over the probes it is labelled for (calls, yeses, right and wrong yeses, precision, recall; macro
 * averages, the share of speaking regions at precision >= 0.8, regions that never fired). Truth is
 * multi-region (held or expected); positives with no labelled target are left out of scoring. `goal`
 * is the per-moment measure: coverage = needed regions shown / needed, correctness = needed shown /
 * shown, averaged over targeted moments, with the share of moments where correctness > 0.5.
 */
import { createHash } from 'node:crypto';
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
    routing: { type: 'string' },
    labels: { type: 'string' },
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
  const buckets: [string, (n: number) => boolean][] = [
    ['0', (n) => n === 0],
    ['1', (n) => n === 1],
    ['2', (n) => n === 2],
    ['3-4', (n) => n >= 3 && n <= 4],
    ['5-8', (n) => n >= 5 && n <= 8],
    ['9+', (n) => n >= 9],
  ];
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
      histogram: Object.fromEntries(buckets.map(([b, f]) => [b, yesPerTurn.filter(f).length])),
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
  const probes = after.probes.filter((p) => routedIds.has(p.id));
  const positives = probes.filter((p) => p.kind === 'positive');
  const fullFanOut = new Set(after.answers.filter(matched).map((a) => a.probeId));
  report.routed = {
    scores: resolve(values.routing),
    probesWithRouting: probes.length,
    positivesWithRouting: positives.length,
    fullFanOutOnThese: withCI(
      positives.filter((p) => fullFanOut.has(p.id)).length,
      positives.length,
    ),
    atK: Object.fromEntries(
      [2, 4, 8].map((k) => {
        const routedFor = (probeId: string) => new Set(ranked(probeId).slice(0, k));
        const said = new Set(
          after.answers
            .filter((a) => matched(a) && routedFor(a.probeId).has(a.domain))
            .map((a) => a.probeId),
        );
        const turns = after.turns.filter((t) => routedIds.has(t.probeId));
        const perTurn = turns.map(
          (t) =>
            after.answers.filter(
              (a) =>
                a.probeId === t.probeId &&
                (a.trigger ?? 'agent-action') === (t.trigger ?? 'agent-action') &&
                yes(a) &&
                routedFor(a.probeId).has(a.domain),
            ).length,
        );
        const wrong = after.answers.filter(
          (a) =>
            routedIds.has(a.probeId) &&
            yes(a) &&
            !a.judged?.matches &&
            routedFor(a.probeId).has(a.domain),
        ).length;
        return [
          k,
          {
            anticipated: withCI(positives.filter((p) => said.has(p.id)).length, positives.length),
            askedPerMoment: rate(
              turns.reduce((n, t) => n + Math.min(k, ranked(t.probeId).length), 0),
              turns.length,
            ),
            yesPerMoment: rate(
              perTurn.reduce((a, b) => a + b, 0),
              perTurn.length,
            ),
            wrongRemarksPerMoment: rate(wrong, turns.length),
          },
        ];
      }),
    ),
  };
}
if (values.labels) {
  // Labelled regions per probe: `expected` (judged routing destination) and `held` (knowledge holds the target).
  const labels = JSON.parse(readFileSync(resolve(values.labels), 'utf8')) as {
    probes: Record<string, { expected?: string[]; held?: string[] }>;
  };
  const labelled = (probeId: string) =>
    new Set([...(labels.probes[probeId]?.expected ?? []), ...(labels.probes[probeId]?.held ?? [])]);
  // Truth is known on negatives and on positives with a labelled target; a correction with no doc target is left out of scoring.
  const positives = after.probes.filter((p) => p.kind === 'positive' && labelled(p.id).size);
  const scored = new Set([
    ...positives.map((p) => p.id),
    ...after.probes.filter((p) => p.kind === 'negative').map((p) => p.id),
  ]);
  const saidYes = (probeId: string, domain: string) =>
    after.answers.some((a) => a.probeId === probeId && a.domain === domain && yes(a));
  const shown = (probeId: string) =>
    new Set(after.answers.filter((a) => a.probeId === probeId && yes(a)).map((a) => a.domain));
  const recognised = positives.filter((p) => [...labelled(p.id)].some((r) => saidYes(p.id, r)));
  const outsideYes = (t: WardenProbeTurn) =>
    after.answers.filter(
      (a) =>
        a.probeId === t.probeId &&
        (a.trigger ?? 'agent-action') === (t.trigger ?? 'agent-action') &&
        yes(a) &&
        !labelled(a.probeId).has(a.domain),
    ).length;
  const scoredTurns = after.turns.filter((t) => scored.has(t.probeId));
  const falseYesTurns = scoredTurns.filter((t) => outsideYes(t) > 0);
  const negativeTurns = after.turns.filter((t) => probesById.get(t.probeId)?.kind === 'negative');
  // Per region: a yes is right when the region holds or is expected for the moment's target (multi-region truth).
  const regions = [...new Set(after.answers.map((a) => a.domain))].sort();
  const perRegion = Object.fromEntries(
    regions.map((region) => {
      const mine = after.answers.filter((a) => a.domain === region);
      const relevant = positives.filter((p) => labelled(p.id).has(region));
      const hits = relevant.filter((p) => saidYes(p.id, region));
      const spoke = mine.filter((a) => yes(a) && scored.has(a.probeId));
      const right = spoke.filter((a) => labelled(a.probeId).has(region));
      return [
        region,
        {
          calls: mine.length,
          yes: mine.filter(yes).length,
          rightYes: right.length,
          wrongYes: spoke.length - right.length,
          precision: rate(right.length, spoke.length),
          labelledFor: relevant.length,
          recall: rate(hits.length, relevant.length),
        },
      ];
    }),
  );
  const speaking = Object.values(perRegion).filter((r) => r.precision !== null);
  const owning = Object.values(perRegion).filter((r) => r.recall !== null);
  // Aron's goal metric, per targeted moment: needed = labelled regions, shown = regions that said yes.
  const moments = positives.map((p) => {
    const needed = labelled(p.id);
    const seen = shown(p.id);
    const both = [...needed].filter((r) => seen.has(r)).length;
    return {
      coverage: both / needed.size,
      correctness: seen.size ? both / seen.size : null,
    };
  });
  const spoken = moments.filter((m) => m.correctness !== null);
  const mean = (xs: number[]) =>
    rate(
      xs.reduce((a, b) => a + b, 0),
      xs.length,
    );
  report.recognition = {
    labels: resolve(values.labels),
    labelledPositives: positives.length,
    excludedPositives: after.probes.filter((p) => p.kind === 'positive').length - positives.length,
    chorusRecall: withCI(recognised.length, positives.length),
    chorusFalseYes: withCI(falseYesTurns.length, scoredTurns.length),
    chorusFalseYesOnNegatives: withCI(
      negativeTurns.filter((t) => outsideYes(t) > 0).length,
      negativeTurns.length,
    ),
    outsideYesPerMoment: rate(
      scoredTurns.reduce((n, t) => n + outsideYes(t), 0),
      scoredTurns.length,
    ),
    goal: {
      moments: positives.length,
      silentMoments: moments.length - spoken.length,
      coverageMean: mean(moments.map((m) => m.coverage)),
      correctnessMeanOverAll: mean(moments.map((m) => m.correctness ?? 0)),
      correctnessMeanOverSpoken: mean(spoken.map((m) => m.correctness!)),
      majorityCorrect: withCI(spoken.filter((m) => m.correctness! > 0.5).length, positives.length),
    },
    regions: regions.length,
    regionsNeverFired: Object.values(perRegion).filter((r) => r.yes === 0).length,
    regionsSpeaking: speaking.length,
    regionsPrecisionAtLeast80: withCI(
      speaking.filter((r) => r.precision! >= 0.8).length,
      speaking.length,
    ),
    macroRegionRecall: mean(owning.map((r) => r.recall!)),
    macroRegionPrecision: mean(speaking.map((r) => r.precision!)),
    perRegion,
  };
}
const outFile = values.out ? resolve(values.out) : join(run, 'report.json');
writeFileSync(outFile, JSON.stringify(report, null, 1), { mode: 0o600 });
console.log(JSON.stringify(report, null, 1));
console.error(`report: ${outFile}`);
