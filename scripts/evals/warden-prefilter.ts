#!/usr/bin/env bun
/**
 * Measure the Warden pre-filter (providers/warden-prefilter.ts) against labelled moments: the
 * harvested Warden probes and the Prospector's fixtures. Runs the shipped provider against the local
 * model server, so it measures exactly what runs live.
 *
 *   bun scripts/evals/warden-prefilter.ts --settings <roster settings.json> --knowledge <ladder dir> \
 *     [--probes ~/.foundry/evals/warden-probes.jsonl] \
 *     [--fixtures ~/.foundry/evals/warden-prefilter/fixtures.jsonl] [--repeat 3] [--model english]
 *
 * Prints recall of Warden-relevant pairs against the skip rate (both ways), the threshold sweep,
 * consistency over repeats, p50/p95 latency per trigger and the server's resident memory; writes
 * every score under ~/.foundry/evals/warden-prefilter/runs/. A probe's unlabelled Wardens count
 * toward the skip rate, never toward recall.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type PrefilterFixture,
  type PrefilterPair,
  parsePrefilterFixture,
  percentiles,
  prefilterConsistency,
  probeFixture,
  scorePrefilter,
  type WardenProbe,
} from '../../packages/core/src';
import { privateDirectory } from '../../packages/foundry/src/providers/decision-host';
import { WardenPrefilter } from '../../packages/foundry/src/providers/warden-prefilter';
import { loadRoster } from './warden-roster';

const evals = join(homedir(), '.foundry', 'evals');
const { values } = parseArgs({
  options: {
    settings: { type: 'string' },
    knowledge: { type: 'string' },
    probes: { type: 'string', default: join(evals, 'warden-probes.jsonl') },
    fixtures: { type: 'string', default: join(evals, 'warden-prefilter', 'fixtures.jsonl') },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    repeat: { type: 'string', default: '3' },
    'repeat-sample': { type: 'string', default: '40' },
    limit: { type: 'string' },
  },
});
if (!values.settings || !values.knowledge) {
  console.error('usage: warden-prefilter.ts --settings <settings.json> --knowledge <ladder dir>');
  process.exit(2);
}
const out = join(evals, 'warden-prefilter', 'runs', `${Date.now()}`);
if (resolve(out).startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) process.exit(2);
privateDirectory(out);

const roster = loadRoster(values.settings, values.knowledge);
const prefilter = new WardenPrefilter({
  ...(values.model ? { model: values.model } : {}),
  ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
  timeoutMs: 30_000,
});
const health = await prefilter.check(10_000);
if (!health.ok) {
  console.error(`model server unavailable: ${health.reason}`);
  process.exit(1);
}

type Moment = { fixture: PrefilterFixture; ctx: string; project?: string };
const lines = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
const moments: Moment[] = [];
for (const line of lines(values.probes!)) {
  const probe = JSON.parse(line) as WardenProbe;
  moments.push({
    fixture: probeFixture(probe, (domain) => roster.ids.get(domain)),
    ctx: probe.ctx,
    ...(probe.project ? { project: probe.project } : {}),
  });
}
let unparsed = 0;
for (const line of lines(values.fixtures!)) {
  const fixture = parsePrefilterFixture(line);
  if (fixture)
    moments.push({
      fixture,
      ctx: fixture.ctx ?? 'inixiative',
      ...(fixture.project ? { project: fixture.project } : {}),
    });
  else unparsed++;
}
const limit = values.limit ? Number(values.limit) : moments.length;
const run = moments.slice(0, limit);
console.error(
  `${run.length} moments (${run.filter((m) => m.fixture.source === 'probe').length} probes); ${unparsed} fixture lines unparsed`,
);

// Warm the server once: the first call compiles the model on its device.
await prefilter.score(
  'user-message',
  'warm up',
  undefined,
  roster.wardensFor('inixiative'),
  'eval',
);

const pairs: (PrefilterPair & { source: string; trigger: string })[] = [];
const latencies: number[] = [];
let unavailable = 0;
const scoreMoment = async (m: Moment) => {
  const wardens = roster.wardensFor(m.ctx, m.project);
  const outcome = await prefilter.score(
    m.fixture.trigger.kind,
    m.fixture.trigger.text,
    m.fixture.context,
    wardens,
    'eval',
  );
  return { wardens, outcome };
};
for (const [i, m] of run.entries()) {
  const { wardens, outcome } = await scoreMoment(m);
  latencies.push(outcome.elapsedMs);
  if (outcome.status !== 'scored') unavailable++;
  for (const w of wardens) {
    const label = m.fixture.labels[w.id];
    const score = outcome.status === 'scored' ? outcome.scores.get(w.domain) : undefined;
    pairs.push({
      momentId: m.fixture.id,
      wardenId: w.id,
      source: m.fixture.source,
      trigger: m.fixture.trigger.kind,
      ...(label ? { relevant: label.relevant } : {}),
      ...(score !== undefined ? { score } : {}),
    });
  }
  if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${run.length}`);
}

// Consistency: a stable sample of moments scored again, N times in all.
const repeat = Number(values.repeat);
const sample = run.slice(0, Number(values['repeat-sample']));
const repeats = new Map<string, (number | undefined)[]>();
for (const p of pairs.filter((p) => sample.some((m) => m.fixture.id === p.momentId)))
  repeats.set(`${p.momentId}|${p.wardenId}`, [p.score]);
for (let r = 1; r < repeat; r++)
  for (const m of sample) {
    const { wardens, outcome } = await scoreMoment(m);
    for (const w of wardens)
      repeats
        .get(`${m.fixture.id}|${w.id}`)
        ?.push(outcome.status === 'scored' ? outcome.scores.get(w.domain) : undefined);
  }

const rssMb = (() => {
  const pids = Bun.spawnSync(['pgrep', '-f', 'laya-serve']).stdout.toString().trim().split('\n');
  return pids
    .filter(Boolean)
    .map(
      (pid) =>
        Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', pid]).stdout.toString().trim()) / 1024,
    )
    .reduce((a, b) => a + b, 0);
})();

const by = (filter: (p: (typeof pairs)[number]) => boolean) => scorePrefilter(pairs.filter(filter));
const summary = {
  model: prefilter.settings.model,
  moments: run.length,
  unavailable,
  all: by(() => true),
  probes: by((p) => p.source === 'probe'),
  fixtures: by((p) => p.source !== 'probe'),
  byTrigger: Object.fromEntries(
    [...new Set(pairs.map((p) => p.trigger))].map((t) => [t, by((p) => p.trigger === t)]),
  ),
  consistency: Object.fromEntries(
    [0.05, 0.1, 0.2].map((t) => [String(t), prefilterConsistency(repeats, t)]),
  ),
  latencyMs: percentiles(latencies),
  serverRssMb: Math.round(rssMb),
};
writeFileSync(join(out, 'pairs.jsonl'), `${pairs.map((p) => JSON.stringify(p)).join('\n')}\n`, {
  mode: 0o600,
});
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1), { mode: 0o600 });
const line = (name: string, s: ReturnType<typeof scorePrefilter>) =>
  `${name.padEnd(14)} pairs ${String(s.pairs).padStart(6)}  relevant ${String(s.relevant).padStart(5)}  auroc ${s.auroc ?? '-'}  recall@skip50 ${s.recallAtSkip['0.5'] ?? '-'}  skip@recall80 ${s.skipAtRecall['0.8']?.skipRate ?? '-'} (t=${s.skipAtRecall['0.8']?.threshold ?? '-'})  skip@recall90 ${s.skipAtRecall['0.9']?.skipRate ?? '-'}`;
console.log(line('all', summary.all));
console.log(line('probes', summary.probes));
console.log(line('fixtures', summary.fixtures));
for (const [t, s] of Object.entries(summary.byTrigger)) console.log(line(t, s));
console.log('sweep (all):');
for (const p of summary.all.sweep)
  console.log(
    `  skip below ${p.threshold}: skip ${p.skipRate}  recall ${p.recall}  correct skips ${p.correctSkips}`,
  );
console.log(`consistency ${JSON.stringify(summary.consistency)}`);
console.log(
  `latency per trigger ${JSON.stringify(summary.latencyMs)} ms; server RSS ${summary.serverRssMb} MB`,
);
console.log(`scores: ${out}`);
