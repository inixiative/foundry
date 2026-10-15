#!/usr/bin/env bun
/**
 * Labelled fixtures for the Warden prefilter: which Warden domains a moment touches. Writes outside
 * the repository only (fixtures hold session text and company code excerpts).
 *
 *   bun scripts/evals/warden-prefilter.ts build --dir ~/.foundry/evals/warden-prefilter \
 *     --pool ~/.foundry/evals/warden-probes.jsonl --kit <deep-scan kit work dir> [--fresh-days 3]
 *   bun scripts/evals/warden-prefilter.ts label --dir <dir> --settings <settings.json> \
 *     --feedback-log <FEEDBACK-LOG.md> --run r1 [--ids <file>] [--shuffle] [--concurrency 4]
 *   bun scripts/evals/warden-prefilter.ts assemble --dir <dir> --run r1
 *   bun scripts/evals/warden-prefilter.ts sample --dir <dir> --run r1 --n 150 --out <ids file>
 *   bun scripts/evals/warden-prefilter.ts agree --dir <dir> --a r1 --b r2|hand
 *   bun scripts/evals/warden-prefilter.ts measure --dir <dir> --settings <settings.json> \
 *     --knowledge <ladder dir> [--scores <earlier run dir>] [--repeat 3] [--base-url <url>]
 *
 * build: candidates.jsonl from git cases (raw/git-*.jsonl, mined by hand from repo history), the
 * charter probe pool (warden-probes.ts), the kit's sharp corrections the pool left out (agent turn
 * or, for history-only rows, the ask before the correction), and `foundry repeats`' collector over
 * the last --fresh-days. label: Opus over the subscription (decisionHost), resumable per run.
 * measure: the shipped pre-filter (providers/warden-prefilter.ts) against the local model server,
 * over every fixture with its context's roster (never `hidden`). Reports recall of relevant pairs
 * against skip rate on the r1 labels (primary: broad, so the conservative bar for a fail-open
 * filter), on the pairs r1 and r2 agree on, and on the hand check; per Warden; the sweep;
 * consistency over repeats; latency and the server's memory. `--scores` rescores an earlier run.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  computeHash,
  labelAgreement,
  type PrefilterPair,
  parseWardenLabels,
  percentiles,
  prefilterConsistency,
  scorePrefilter,
  scrubSecrets,
  type UnlabelledFixture,
  type WardenFixture,
  type WardenLabel,
  type WardenProbe,
  type WardenRosterEntry,
  wardenLabelMessages,
  wardenLabelPrefix,
} from '../../packages/core/src';
import { markEvalRun } from '../../packages/foundry/src/feedback/charter-eval';
import { collectCandidates } from '../../packages/foundry/src/feedback/repeats';
import { reachableArchive } from '../../packages/foundry/src/feedback/repeats-cli';
import { decisionHost, privateDirectory } from '../../packages/foundry/src/providers/decision-host';
import { WardenPrefilter } from '../../packages/foundry/src/providers/warden-prefilter';
import { loadRoster } from './warden-roster';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  strict: true,
  options: {
    dir: { type: 'string' },
    pool: { type: 'string' },
    kit: { type: 'string' },
    'fresh-days': { type: 'string' },
    settings: { type: 'string' },
    'feedback-log': { type: 'string' },
    run: { type: 'string' },
    ids: { type: 'string' },
    shuffle: { type: 'boolean' },
    concurrency: { type: 'string' },
    batch: { type: 'string' },
    model: { type: 'string' },
    n: { type: 'string' },
    out: { type: 'string' },
    a: { type: 'string' },
    b: { type: 'string' },
    knowledge: { type: 'string' },
    scores: { type: 'string' },
    repeat: { type: 'string' },
    'repeat-sample': { type: 'string' },
    'base-url': { type: 'string' },
  },
});
const dir = resolve(values.dir ?? join(homedir(), '.foundry', 'evals', 'warden-prefilter'));
if (dir.startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) {
  console.error('--dir must be outside the repository: fixtures hold session text');
  process.exit(2);
}
privateDirectory(dir);

const rank = (id: string) => Number(BigInt(Bun.hash(id)) % 1_000_000n);
const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
const writePrivate = (path: string, text: string) => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};
const writeJsonl = (path: string, rows: readonly unknown[]) =>
  writePrivate(path, rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');
const scrub = (text: string) => scrubSecrets(text).text;
const CTX = new Set(['inixiative', 'userevidence', 'personal']);

type GitCase = {
  id: string;
  ctx: string;
  project?: string;
  repo?: string;
  commit?: string;
  fixCommit?: string | null;
  pr?: number | null;
  caseKind?: string;
  trigger: { kind: UnlabelledFixture['trigger']['kind']; text: string };
  context?: string;
  outcome?: string;
  primitive?: string | null;
};
type KitCandidate = {
  src: string;
  session?: string;
  ts?: string;
  ctx: string;
  project?: string;
  text: string;
  prev?: string;
  score?: number | string;
};
type KitTyped = { src: string; ts?: string; ctx: string; project?: string; text: string };
type KitClass = { id: number | string; isCorrection: unknown; sharp: unknown; domain?: string };

/** Under-represented Haiku domains get more of the kit's left-out corrections; caps per (domain, shape). */
const EXTRA_TURN: Record<string, number> = {
  security: 8,
  'ux-frontend': 10,
  permissions: 6,
  testing: 6,
  naming: 3,
  'data-schema': 8,
  'merge-ship': 4,
  'code-quality': 8,
  communication: 4,
  architecture: 6,
  process: 6,
};
const EXTRA_HISTORY: Record<string, number> = {
  reuse: 40,
  security: 12,
  'ux-frontend': 8,
  permissions: 10,
  naming: 8,
  testing: 8,
  'data-schema': 8,
  prose: 6,
  'code-quality': 8,
  architecture: 6,
  'merge-ship': 5,
  communication: 4,
};

async function build() {
  if (!values.pool || !values.kit) throw Error('build needs --pool and --kit');
  const kit = values.kit;
  const fixtures: UnlabelledFixture[] = [];
  // 1. Git cases mined from repo history (raw/git-*.jsonl).
  const raw = join(dir, 'raw');
  for (const file of existsSync(raw)
    ? readdirSync(raw).filter((f) => /^git-.*\.jsonl$/.test(f))
    : [])
    for (const g of readJsonl<GitCase>(join(raw, file))) {
      if (!g.trigger?.text) continue;
      fixtures.push({
        id: g.id,
        ctx: g.ctx,
        ...(g.project ? { project: g.project } : {}),
        source: 'git',
        trigger: { kind: g.trigger.kind, text: scrub(g.trigger.text) },
        context: scrub(g.context ?? ''),
        hidden: scrub(
          [g.outcome, g.primitive ? `Existing primitive: ${g.primitive}` : '']
            .filter(Boolean)
            .join('\n'),
        ),
        provenance: {
          repo: g.repo ?? null,
          commit: g.commit ?? null,
          fixCommit: g.fixCommit ?? null,
          pr: g.pr ?? null,
          caseKind: g.caseKind ?? null,
          file,
        },
      });
    }
  // 2. The charter probe pool: the agent turn, and Aron's next message. Context from his earlier asks.
  const candidates = readJsonl<KitCandidate>(join(kit, 'candidates.jsonl'));
  const typed = readJsonl<KitTyped>(join(kit, 'all-typed.jsonl'));
  const classes = new Map(
    readJsonl<KitClass>(join(kit, 'haiku', 'results.jsonl')).map((c) => [Number(c.id), c]),
  );
  const byProject = new Map<string, KitTyped[]>();
  for (const t of typed) {
    const key = `${t.src}|${t.project}`;
    byProject.set(key, [...(byProject.get(key) ?? []), t]);
  }
  /** The person's asks in the same project in the six hours before `ts`, oldest first. */
  const asksBefore = (c: KitCandidate, count: number) => {
    const at = Date.parse(c.ts ?? '');
    return (byProject.get(`${c.src}|${c.project}`) ?? [])
      .filter((t) => {
        const when = Date.parse(t.ts ?? '');
        return when < at && at - when < 6 * 3_600_000 && t.text !== c.text;
      })
      .slice(-count);
  };
  const preceding = (c: KitCandidate) =>
    asksBefore(c, 3)
      .map((t) => `Earlier ask: ${t.text.slice(0, 400)}`)
      .join('\n');
  const pool = readJsonl<WardenProbe>(values.pool);
  const inPool = new Set(pool.map((p) => Number(p.id.split('-')[1])));
  const kept = (p: WardenProbe) => p.kind === 'positive' || rank(p.id) % 100 < 30;
  for (const p of pool.filter(kept)) {
    const c = candidates[Number(p.id.split('-')[1])];
    fixtures.push({
      id: `session-${p.id}`,
      ctx: p.ctx,
      ...(p.project ? { project: p.project } : {}),
      source: 'session',
      trigger: { kind: 'agent-plan', text: p.moment },
      context: '',
      ...(c ? { precedingRaw: scrub(preceding(c)) } : {}),
      ...(p.hidden ? { hidden: p.hidden } : {}),
      provenance: {
        probeId: p.id,
        session: c?.session ?? null,
        harness: c?.src ?? null,
        timestamp: c?.ts ?? null,
        poolKind: p.kind,
      },
    });
  }
  // 3. Sharp corrections the pool left out, weighted toward thin domains.
  const yes = (v: unknown) => String(v).toLowerCase() === 'true';
  const taken = new Map<string, number>();
  const order = candidates
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank(`kit-${x.i}`) - rank(`kit-${y.i}`));
  for (const { c, i } of order) {
    const h = classes.get(i);
    if (!h || !CTX.has(c.ctx) || inPool.has(i) || !yes(h.isCorrection) || !yes(h.sharp)) continue;
    const domain = h.domain ?? 'other';
    const turn = (c.prev ?? '').trim();
    if (turn.length >= 100) {
      const key = `turn|${domain}`;
      if ((taken.get(key) ?? 0) >= (EXTRA_TURN[domain] ?? 0)) continue;
      taken.set(key, (taken.get(key) ?? 0) + 1);
      fixtures.push({
        id: `session-kit-${i}`,
        ctx: c.ctx,
        ...(c.project ? { project: c.project } : {}),
        source: 'session',
        trigger: { kind: 'agent-plan', text: scrub(turn.slice(-4000)) },
        context: '',
        precedingRaw: scrub(preceding(c)),
        hidden: scrub(c.text.slice(0, 2000)),
        provenance: {
          kitId: i,
          session: c.session ?? null,
          harness: c.src,
          timestamp: c.ts ?? null,
        },
      });
      continue;
    }
    // History keeps only what he typed: the moment is the ask before the correction.
    const [ask] = asksBefore(c, 1);
    if (!ask || ask.text.length < 40) continue;
    const key = `history|${domain}`;
    if ((taken.get(key) ?? 0) >= (EXTRA_HISTORY[domain] ?? 0)) continue;
    taken.set(key, (taken.get(key) ?? 0) + 1);
    fixtures.push({
      id: `history-kit-${i}`,
      ctx: c.ctx,
      ...(c.project ? { project: c.project } : {}),
      source: 'history',
      trigger: { kind: 'user-message', text: scrub(ask.text.slice(0, 3000)) },
      context: '',
      precedingRaw: scrub(
        asksBefore({ ...c, ts: ask.ts, text: ask.text }, 2)
          .map((t) => `Earlier ask: ${t.text.slice(0, 400)}`)
          .join('\n'),
      ),
      hidden: scrub(c.text.slice(0, 2000)),
      provenance: {
        kitId: i,
        harness: 'history',
        timestamp: c.ts ?? null,
        askTimestamp: ask.ts ?? null,
      },
    });
  }
  // History negatives: an ask followed by a plain next ask (Haiku: not a correction).
  let historyNegatives = 0;
  for (const { c, i } of order) {
    if (historyNegatives >= 30) break;
    const h = classes.get(i);
    if (!h || !CTX.has(c.ctx) || yes(h.isCorrection) || (c.prev ?? '').trim()) continue;
    const [ask] = asksBefore(c, 1);
    if (!ask || ask.text.length < 60) continue;
    historyNegatives++;
    fixtures.push({
      id: `history-kit-${i}`,
      ctx: c.ctx,
      ...(c.project ? { project: c.project } : {}),
      source: 'history',
      trigger: { kind: 'user-message', text: scrub(ask.text.slice(0, 3000)) },
      context: '',
      hidden: scrub(c.text.slice(0, 2000)),
      provenance: { kitId: i, harness: 'history', timestamp: c.ts ?? null, negative: 'haiku' },
    });
  }
  // 4. Sessions since the kit, through `foundry repeats`' collector (Archive, then the harness files).
  const freshDays = Number(values['fresh-days'] ?? 0);
  // Without --fresh-days a rebuild keeps the window an earlier build collected, so labels stay valid.
  if (!freshDays)
    fixtures.push(
      ...readJsonl<UnlabelledFixture>(join(dir, 'candidates.jsonl')).filter((f) =>
        f.id.startsWith('session-fresh-'),
      ),
    );
  if (freshDays > 0) {
    const archive = await reachableArchive();
    const now = Date.now();
    const { candidates: fresh } = await collectCandidates(
      {
        claudeProjects: join(homedir(), '.claude', 'projects'),
        codexSessions: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
        ...(archive ? { archive } : {}),
        minScore: 0.6,
      },
      now - freshDays * 86_400_000,
      now,
    );
    const ctxOf = (project: string) =>
      project.includes('/zealot') || project.includes('UserEvidence')
        ? 'userevidence'
        : project.includes('/inixiative') || project.includes('/tribe')
          ? 'inixiative'
          : 'personal';
    for (const f of fresh
      .filter((x) => x.event.before.trim().length >= 100)
      .sort((x, y) => rank(x.event.id) - rank(y.event.id))
      .slice(0, 40))
      fixtures.push({
        id: `session-fresh-${computeHash(f.event.id).slice(0, 12)}`,
        ctx: ctxOf(f.project),
        project: f.project.split('/').pop() ?? f.project,
        source: 'session',
        trigger: { kind: 'agent-plan', text: f.event.before },
        context: '',
        hidden: f.event.correction,
        provenance: {
          correctionId: f.event.id,
          harness: f.harness,
          file: f.file.startsWith('archive:') ? f.file : null,
          timestamp: f.event.timestamp,
        },
      });
  }
  const unique = [...new Map(fixtures.map((f) => [f.id, f])).values()];
  writeJsonl(join(dir, 'candidates.jsonl'), unique);
  const count = (pred: (f: UnlabelledFixture) => boolean) => unique.filter(pred).length;
  console.log(
    JSON.stringify(
      {
        total: unique.length,
        git: count((f) => f.source === 'git'),
        session: count((f) => f.source === 'session'),
        history: count((f) => f.source === 'history'),
        userevidence: count((f) => f.ctx === 'userevidence'),
      },
      null,
      1,
    ),
  );
}

function roster(): WardenRosterEntry[] {
  if (!values.settings) throw Error('--settings is required');
  const settings = JSON.parse(readFileSync(values.settings, 'utf8')) as {
    agents: Record<
      string,
      { flowRole?: string; enabled?: boolean; domain?: string; prompt?: string }
    >;
  };
  return Object.entries(settings.agents).flatMap(([id, a]) =>
    a.flowRole === 'domain-advising' && a.domain && a.prompt
      ? [{ id, domain: a.domain, prompt: a.prompt, enabled: a.enabled !== false }]
      : [],
  );
}

function feedbackRules(): { n: number; rule: string; count: string }[] {
  if (!values['feedback-log']) return [];
  return readFileSync(values['feedback-log'], 'utf8')
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length > 6 && /^\d+$/.test(cells[1] ?? ''))
    .map((cells) => ({
      n: Number(cells[1]),
      rule: (cells[3] ?? '').slice(0, 200),
      count: cells[4] ?? '',
    }));
}

type LabelRow = {
  id: string;
  run: string;
  model: string;
  promptHash: string;
  context: string;
  labels: Record<string, WardenLabel>;
  feedbackRules: number[];
};

async function label() {
  const run = values.run;
  if (!run) throw Error('--run is required');
  const model = values.model ?? 'claude-opus-5-5';
  const all = roster();
  writePrivate(join(dir, 'roster.json'), `${JSON.stringify(all, null, 1)}\n`);
  let wardens = all.filter((w) => w.enabled);
  if (values.shuffle)
    wardens = [...wardens].sort((a, b) => rank(`${run}${a.id}`) - rank(`${run}${b.id}`));
  const prefix = wardenLabelPrefix(wardens, feedbackRules());
  const promptHash = computeHash(prefix).slice(0, 12);
  const out = join(dir, `labels-${run}.jsonl`);
  const done = new Set(readJsonl<LabelRow>(out).map((r) => r.id));
  const only = values.ids
    ? new Set(readFileSync(values.ids, 'utf8').split('\n').filter(Boolean))
    : undefined;
  const pending = readJsonl<UnlabelledFixture>(join(dir, 'candidates.jsonl')).filter(
    (f) => !done.has(f.id) && (!only || only.has(f.id)),
  );
  const batchSize = Number(values.batch ?? 5);
  const batches: UnlabelledFixture[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
  const state = privateDirectory(dir);
  // An eval run, not work: Archive and the repeat report leave its sessions out.
  markEvalRun(state);
  const concurrency = Number(values.concurrency ?? 4);
  const host = decisionHost(model, 'claude', concurrency, state);
  const rows: LabelRow[] = readJsonl<LabelRow>(out);
  let failures = 0;
  const ask = async (batch: UnlabelledFixture[]): Promise<void> => {
    if (failures >= 8) return;
    try {
      const result = await host.provider.complete(wardenLabelMessages(prefix, batch), {
        threadId: `warden-prefilter:${run}`,
        stablePrefix: prefix,
        tools: false,
        maxTurns: 1,
        temperature: 0,
      });
      const parsed = parseWardenLabels(
        result.content,
        wardens,
        batch.map((f) => f.id),
      );
      const missing: UnlabelledFixture[] = [];
      for (const [i, f] of batch.entries()) {
        const p = parsed[i];
        if (p) rows.push({ id: f.id, run, model, promptHash, ...p });
        else missing.push(f);
      }
      writeJsonl(out, rows);
      if (missing.length === batch.length) {
        failures++;
        if (batch.length > 1) for (const f of batch) await ask([f]);
      } else for (const f of missing) await ask([f]);
    } catch (error) {
      failures++;
      console.error(`batch failed: ${String(error).slice(0, 200)}`);
      if (batch.length > 1) for (const f of batch) await ask([f]);
    }
  };
  let next = 0;
  let finished = 0;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let batch = batches[next++]; batch; batch = batches[next++]) {
          await ask(batch);
          finished += batch.length;
          console.error(`  ${finished}/${pending.length} labelled`);
        }
      }),
    );
  } finally {
    await host.shutdown();
  }
  console.log(`${run}: ${rows.length} labelled, ${failures} failed calls → ${out}`);
}

function labelsOf(run: string): Map<string, Record<string, WardenLabel>> {
  const path = join(dir, run === 'hand' ? 'handcheck.jsonl' : `labels-${run}.jsonl`);
  return new Map(readJsonl<LabelRow>(path).map((r) => [r.id, r.labels]));
}

function assemble() {
  const run = values.run ?? 'r1';
  const rows = new Map(readJsonl<LabelRow>(join(dir, `labels-${run}.jsonl`)).map((r) => [r.id, r]));
  const hand = labelsOf('hand');
  const fixtures: WardenFixture[] = [];
  for (const f of readJsonl<UnlabelledFixture>(join(dir, 'candidates.jsonl'))) {
    const row = rows.get(f.id);
    if (!row) continue;
    const { precedingRaw: _raw, ...rest } = f;
    fixtures.push({
      ...rest,
      context: row.context || f.context,
      labels: row.labels,
      feedbackRules: row.feedbackRules,
      labeler: { model: row.model, run, promptHash: row.promptHash },
      ...(hand.has(f.id) ? { handChecked: true } : {}),
    });
  }
  writeJsonl(join(dir, 'fixtures.jsonl'), fixtures);
  // Per-Warden eval subsets: every positive plus negatives up to a 30% positive rate.
  const wardenIds = [...new Set(fixtures.flatMap((f) => Object.keys(f.labels)))];
  const splits: Record<string, { positives: string[]; negatives: string[] }> = {};
  const stats: Record<string, { positives: number; rate: number; splitRate: number }> = {};
  for (const w of wardenIds) {
    const positives = fixtures.filter((f) => f.labels[w]?.relevant).map((f) => f.id);
    const negatives = fixtures
      .filter((f) => !f.labels[w]?.relevant)
      .map((f) => f.id)
      .sort((a, b) => rank(`${w}${a}`) - rank(`${w}${b}`))
      .slice(0, Math.max(positives.length, Math.floor((positives.length * 7) / 3)));
    splits[w] = { positives, negatives };
    stats[w] = {
      positives: positives.length,
      rate: Math.round((positives.length / fixtures.length) * 1000) / 10,
      splitRate:
        Math.round((positives.length / (positives.length + negatives.length || 1)) * 1000) / 10,
    };
  }
  writePrivate(join(dir, 'splits.json'), `${JSON.stringify(splits)}\n`);
  console.log(JSON.stringify({ fixtures: fixtures.length, perWarden: stats }, null, 1));
}

/** A stratified sample for a second labeling and the hand check: positives of every Warden, then negatives. */
function sample() {
  const run = values.run ?? 'r1';
  const n = Number(values.n ?? 150);
  if (!values.out) throw Error('--out is required');
  const rows = readJsonl<LabelRow>(join(dir, `labels-${run}.jsonl`)).sort(
    (a, b) => rank(`s${a.id}`) - rank(`s${b.id}`),
  );
  const picked = new Set<string>();
  const wardenIds = [...new Set(rows.flatMap((r) => Object.keys(r.labels)))];
  const perWarden = Math.max(2, Math.floor((n * 0.7) / wardenIds.length));
  for (const w of wardenIds)
    for (const r of rows.filter((x) => x.labels[w]?.relevant).slice(0, perWarden)) picked.add(r.id);
  for (const r of rows) {
    if (picked.size >= n) break;
    if (!Object.values(r.labels).some((l) => l.relevant)) picked.add(r.id);
  }
  for (const r of rows) {
    if (picked.size >= n) break;
    picked.add(r.id);
  }
  writePrivate(resolve(values.out), `${[...picked].join('\n')}\n`);
  console.log(`${picked.size} ids → ${values.out}`);
}

function agree() {
  if (!values.a || !values.b) throw Error('agree needs --a and --b');
  const a = labelsOf(values.a);
  const b = labelsOf(values.b);
  const wardenIds = [...new Set([...a.values()].flatMap((l) => Object.keys(l)))].sort();
  const result = labelAgreement(a, b, wardenIds);
  const pct = (x: number, n: number) => (n ? `${Math.round((x / n) * 1000) / 10}%` : '-');
  console.log(
    `${values.a} vs ${values.b}: ${result.fixtures} shared fixtures, ${result.exactFixtures} identical across all Wardens`,
  );
  console.log('warden\tagree\tkappa\tpos a\tpos b\tboth');
  for (const r of [...result.perWarden, result.pooled])
    console.log(
      `${r.wardenId}\t${pct(r.agree, r.n)}\t${r.kappa ?? '-'}\t${r.positivesA}\t${r.positivesB}\t${r.bothPositive}`,
    );
}

type Scored = { fixtureId: string; wardenId: string; score?: number };

async function measure() {
  if (!values.settings || !values.knowledge)
    throw Error('measure needs --settings and --knowledge');
  const fixtures = readJsonl<WardenFixture>(join(dir, 'fixtures.jsonl'));
  const out = join(dir, 'runs', `${Date.now()}`);
  privateDirectory(out);
  let scored: Scored[];
  const latencies: number[] = [];
  let consistency: Record<string, ReturnType<typeof prefilterConsistency>> = {};
  let rssMb = 0;
  if (values.scores) scored = readJsonl<Scored>(join(resolve(values.scores), 'scores.jsonl'));
  else {
    const roster = loadRoster(values.settings, values.knowledge);
    const prefilter = new WardenPrefilter({
      ...(values.model ? { model: values.model } : {}),
      ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
      timeoutMs: 30_000,
    });
    const health = await prefilter.waitReady(60_000);
    if (!health.ok) throw Error(`model server unavailable: ${health.reason}`);
    // The first call compiles the model on its device: not a measured latency.
    await prefilter.score(
      'user-message',
      'warm up',
      undefined,
      roster.wardensFor('inixiative'),
      'eval',
    );
    // What a Warden sees at the moment: the trigger and the context, never `hidden`.
    const scoreOne = async (f: WardenFixture) => {
      const wardens = roster.wardensFor(f.ctx, f.project);
      const outcome = await prefilter.score(
        f.trigger.kind,
        f.trigger.text,
        f.context,
        wardens,
        'eval',
      );
      return wardens.map((w) => ({
        fixtureId: f.id,
        wardenId: w.id,
        ...(outcome.status === 'scored' && outcome.scores.has(w.domain)
          ? { score: outcome.scores.get(w.domain) }
          : {}),
        elapsedMs: outcome.elapsedMs,
      }));
    };
    scored = [];
    for (const [i, f] of fixtures.entries()) {
      const rows = await scoreOne(f);
      latencies.push(rows[0]?.elapsedMs ?? 0);
      scored.push(...rows.map(({ elapsedMs: _e, ...r }) => r));
      if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${fixtures.length}`);
    }
    const repeats = new Map<string, (number | undefined)[]>();
    const sample = fixtures.slice(0, Number(values['repeat-sample'] ?? 40));
    for (const r of scored.filter((r) => sample.some((f) => f.id === r.fixtureId)))
      repeats.set(`${r.fixtureId}|${r.wardenId}`, [r.score]);
    for (let n = 1; n < Number(values.repeat ?? 3); n++)
      for (const f of sample)
        for (const r of await scoreOne(f))
          repeats.get(`${r.fixtureId}|${r.wardenId}`)?.push(r.score);
    consistency = Object.fromEntries(
      [0.05, 0.1, 0.2, 0.3].map((t) => [String(t), prefilterConsistency(repeats, t)]),
    );
    for (const pid of Bun.spawnSync(['pgrep', '-f', 'laya-serve']).stdout.toString().split('\n'))
      if (pid.trim())
        rssMb +=
          Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', pid.trim()]).stdout.toString()) / 1024;
    writeJsonl(join(out, 'scores.jsonl'), scored);
  }

  // Label sets: r1 (the fixtures' labels), the pairs r1 and r2 agree on, the hand check.
  const r1 = new Map(fixtures.map((f) => [f.id, f.labels]));
  const r2 = labelsOf('r2');
  const hand = labelsOf('hand');
  const pairsFor = (label: (fixtureId: string, wardenId: string) => boolean | undefined) =>
    scored.flatMap((r): PrefilterPair[] => {
      const relevant = label(r.fixtureId, r.wardenId);
      return relevant === undefined
        ? []
        : [
            {
              momentId: r.fixtureId,
              wardenId: r.wardenId,
              relevant,
              ...(r.score !== undefined ? { score: r.score } : {}),
            },
          ];
    });
  const sets = {
    r1: pairsFor((f, w) => r1.get(f)?.[w]?.relevant),
    'r1=r2': pairsFor((f, w) => {
      const a = r1.get(f)?.[w]?.relevant;
      const b = r2.get(f)?.[w]?.relevant;
      return a !== undefined && a === b ? a : undefined;
    }),
    hand: pairsFor((f, w) => hand.get(f)?.[w]?.relevant),
  };
  const scores = Object.fromEntries(
    Object.entries(sets).map(([k, pairs]) => [k, scorePrefilter(pairs)]),
  );
  const byTrigger = Object.fromEntries(
    [...new Set(fixtures.map((f) => f.trigger.kind))].map((kind) => {
      const ids = new Set(fixtures.filter((f) => f.trigger.kind === kind).map((f) => f.id));
      return [kind, scorePrefilter(sets.r1.filter((p) => ids.has(p.momentId)))];
    }),
  );
  // Per Warden, at the r1 thresholds that hold 80% and 90% recall overall.
  const at = (t: number | undefined, pairs: readonly PrefilterPair[]) => {
    if (t === undefined) return null;
    const relevant = pairs.filter((p) => p.relevant);
    const asked = (p: PrefilterPair) => p.score === undefined || p.score >= t;
    return {
      recall: relevant.length
        ? Math.round((relevant.filter(asked).length / relevant.length) * 1000) / 1000
        : null,
      skip: Math.round((pairs.filter((p) => !asked(p)).length / (pairs.length || 1)) * 1000) / 1000,
    };
  };
  const t80 = scores.r1!.skipAtRecall['0.8']?.threshold;
  const t90 = scores.r1!.skipAtRecall['0.9']?.threshold;
  const perWarden = Object.fromEntries(
    [...new Set(sets.r1.map((p) => p.wardenId))].sort().map((w) => {
      const pairs = sets.r1.filter((p) => p.wardenId === w);
      return [
        w,
        {
          relevant: pairs.filter((p) => p.relevant).length,
          at80: at(t80, pairs),
          at90: at(t90, pairs),
        },
      ];
    }),
  );
  const summary = {
    fixtures: fixtures.length,
    unscored: scored.filter((r) => r.score === undefined).length,
    scores,
    byTrigger,
    perWarden,
    consistency,
    ...(latencies.length ? { latencyMs: percentiles(latencies) } : {}),
    ...(rssMb ? { serverRssMb: Math.round(rssMb) } : {}),
  };
  writePrivate(join(out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  const line = (name: string, s: ReturnType<typeof scorePrefilter>) =>
    `${name.padEnd(13)} pairs ${String(s.pairs).padStart(6)} relevant ${String(s.relevant).padStart(5)}  auroc ${s.auroc ?? '-'}  recall@skip50 ${s.recallAtSkip['0.5'] ?? '-'}  skip@recall80 ${s.skipAtRecall['0.8']?.skipRate ?? '-'} (t ${s.skipAtRecall['0.8']?.threshold ?? '-'})  skip@recall90 ${s.skipAtRecall['0.9']?.skipRate ?? '-'} (t ${s.skipAtRecall['0.9']?.threshold ?? '-'})`;
  for (const [name, s] of Object.entries(scores)) console.log(line(name, s));
  for (const [name, s] of Object.entries(byTrigger)) console.log(line(name, s));
  console.log(`per Warden at t80=${t80} / t90=${t90} (relevant, recall/skip):`);
  for (const [w, r] of Object.entries(perWarden))
    console.log(
      `  ${w.padEnd(24)} ${String(r.relevant).padStart(4)}  ${r.at80?.recall}/${r.at80?.skip}  ${r.at90?.recall}/${r.at90?.skip}`,
    );
  if (Object.keys(consistency).length) console.log(`consistency ${JSON.stringify(consistency)}`);
  if (summary.latencyMs)
    console.log(
      `latency per trigger ${JSON.stringify(summary.latencyMs)} ms; server RSS ${summary.serverRssMb} MB`,
    );
  console.log(`run: ${out}`);
}

const commands: Record<string, () => unknown> = { build, label, assemble, sample, agree, measure };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error('usage: warden-prefilter.ts build|label|assemble|sample|agree|measure [options]');
  process.exit(2);
}
await run();
