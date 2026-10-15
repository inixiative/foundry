#!/usr/bin/env bun
/**
 * Build Warden probes. Writes JSONL outside the repo: probes hold session text.
 *
 * From a correction harvest (the deep-scan kit: detector candidates, Haiku classifications and the
 * clustered rules):
 *   bun scripts/evals/warden-probes.ts --work <kit>/work --out ~/.foundry/evals/warden-probes.jsonl
 * Positive: a sharp correction (Haiku) of a rule the clusters say was already recorded somewhere,
 * with the agent turn it answered. Negative: an agent turn followed by a message that is not a
 * correction. UserEvidence probes are kept in their own context and never mixed with inixiative.
 *
 * From the person's own sessions, through the Prospector (`foundry repeats`' collector and classifier):
 *   bun scripts/evals/warden-probes.ts --sessions --projects template,zealot --since 2025-12-01 \
 *     --out ~/.foundry/evals/warden-corrections/probes.jsonl [--test-share 0.3] [--concurrency 4]
 * Every correction candidate in those projects' Archive sessions, harness files and prompt history.
 * Positive: a sharp correction (Haiku, cached with `foundry repeats`); negative: a candidate Haiku
 * says is not a correction. Each probe carries the ask the agent was answering (the user-message
 * trigger) and the agent's turn when the source recorded it (agent-action). Per project, the latest
 * --test-share of positives by time are the test period, the rest train; a manifest records the cut.
 *
 * Label what each positive pushed toward (the existing rule, primitive, system or pattern, with its
 * concept cluster), in place, resumable; then merge names per cluster and write the distinct targets:
 *   bun scripts/evals/warden-probes.ts --label-targets --out ~/.foundry/evals/warden-corrections/probes.jsonl
 * Writes targets.json beside the probes: every distinct target by cluster, with counts and probe ids
 * (the catalog's checklist: a target the catalog lacks is a catalog gap).
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type CorrectionTarget,
  correctionTargetMessages,
  parseCorrectionTargets,
  parseTargetCanonical,
  scrubSecrets,
  type TokenCounts,
  targetCanonicalMessages,
  type WardenProbe,
} from '../../packages/core/src';
import { markEvalRun } from '../../packages/foundry/src/feedback/charter-eval';
import {
  collectCandidates,
  type StageUsage,
  scan,
} from '../../packages/foundry/src/feedback/repeats';
import {
  loadCache,
  reachableArchive,
  saveCache,
} from '../../packages/foundry/src/feedback/repeats-cli';
import { decisionHost, privateDirectory } from '../../packages/foundry/src/providers/decision-host';

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    out: { type: 'string' },
    'min-turn': { type: 'string' },
    sessions: { type: 'boolean' },
    projects: { type: 'string' },
    since: { type: 'string' },
    'test-share': { type: 'string' },
    'min-score': { type: 'string' },
    concurrency: { type: 'string' },
    'label-targets': { type: 'boolean' },
  },
});
if ((!values.work && !values.sessions && !values['label-targets']) || !values.out) {
  console.error(
    'usage: warden-probes.ts (--work <kit work dir> | --sessions --projects a,b) --out <probes.jsonl>',
  );
  process.exit(2);
}
const out = resolve(values.out);
// Probes hold session text: never inside this repository.
if (out.startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) {
  console.error('--out must be outside the repository: probes hold session text');
  process.exit(2);
}
const writePrivate = (path: string, text: string) => {
  privateDirectory(dirname(path));
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

function fromKit() {
  const work = values.work!;
  const minTurn = Number(values['min-turn'] ?? 100);

  /** The harvest's domain vocabulary → the roster Wardens that own it. */
  const OWNERS: Record<string, string[]> = {
    'merge-ship': ['ship'],
    reuse: ['reuse', 'lean'],
    naming: ['naming'],
    'data-schema': ['schema'],
    permissions: ['authority'],
    testing: ['tests', 'verify'],
    'code-quality': ['types', 'errors', 'layout'],
    security: ['security'],
    'ux-frontend': ['frontend'],
    communication: ['voice', 'surface', 'assumptions'],
    prose: ['prose'],
    process: ['intent', 'adversary', 'access', 'sync'],
    architecture: ['architecture'],
    domain: ['zealot'],
  };

  type Candidate = { ctx: string; project?: string; text: string; prev?: string; ts?: string };
  type Classified = {
    id: string;
    isCorrection: unknown;
    sharp: unknown;
    statements?: unknown;
    domain?: string;
  };
  const candidates: Candidate[] = readFileSync(join(work, 'candidates.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const classified = new Map<string, Classified>(
    readFileSync(join(work, 'haiku', 'results.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Classified)
      .map((c) => [String(c.id), c]),
  );
  const recorded = new Map<number, { domain: string; domain2?: string | null }[]>();
  for (const file of readdirSync(work).filter((f) => /^clusters-.*\.json$/.test(f))) {
    for (const rule of JSON.parse(readFileSync(join(work, file), 'utf8')).rules ?? []) {
      if (!rule.livesIn?.length) continue;
      for (const id of rule.evidence ?? []) recorded.set(id, [...(recorded.get(id) ?? []), rule]);
    }
  }
  const yes = (v: unknown) => String(v).toLowerCase() === 'true';
  const statements = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    try {
      const parsed = JSON.parse(String(v));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  const probes: WardenProbe[] = [];
  candidates.forEach((c, i) => {
    const h = classified.get(String(i));
    const turn = (c.prev ?? '').trim();
    if (!h || turn.length < minTurn || !['inixiative', 'personal', 'userevidence'].includes(c.ctx))
      return;
    const rules = recorded.get(i) ?? [];
    const base = {
      id: `probe-${i}`,
      ctx: c.ctx,
      ...(c.project ? { project: c.project } : {}),
      moment: scrubSecrets(turn.slice(-4000)).text,
      hidden: scrubSecrets(c.text.slice(0, 2000)).text,
    };
    if (yes(h.isCorrection) && yes(h.sharp) && rules.length) {
      const domains = [
        ...new Set(
          rules
            .flatMap((r) => [r.domain, r.domain2].filter((d): d is string => !!d))
            .flatMap((d) => OWNERS[d] ?? []),
        ),
      ];
      if (domains.length)
        probes.push({
          ...base,
          kind: 'positive',
          gold: { domains, statements: statements(h.statements) },
        });
    } else if (!yes(h.isCorrection)) probes.push({ ...base, kind: 'negative' });
  });
  writePrivate(out, `${probes.map((p) => JSON.stringify(p)).join('\n')}\n`);
  const count = (kind: string, ctx: string) =>
    probes.filter((p) => p.kind === kind && p.ctx === ctx).length;
  for (const ctx of ['inixiative', 'personal', 'userevidence'])
    console.log(`${ctx}: ${count('positive', ctx)} positive, ${count('negative', ctx)} negative`);
}

/** Which eval project a session belongs to, from its Archive project id or its working directory. */
const PROJECTS: Record<string, { ctx: string; match: RegExp }> = {
  template: { ctx: 'inixiative', match: /^template$|\/template(?:\/|$)/ },
  zealot: { ctx: 'userevidence', match: /^userevidence$|\/zealot(?:\/|$)|UserEvidenceZealot/i },
};

async function fromSessions() {
  const wanted = (values.projects ?? 'template,zealot').split(',').filter(Boolean);
  for (const project of wanted)
    if (!PROJECTS[project]) throw Error(`unknown project ${project}: ${Object.keys(PROJECTS)}`);
  const projectOf = (where: string) => wanted.find((p) => PROJECTS[p]!.match.test(where));
  const since = Date.parse(values.since ?? '2025-12-01');
  const testShare = Number(values['test-share'] ?? 0.3);
  const now = Date.now();
  const archive = await reachableArchive();
  const collected = await collectCandidates(
    {
      claudeProjects: join(homedir(), '.claude', 'projects'),
      codexSessions: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
      history: join(homedir(), '.claude', 'history.jsonl'),
      ...(archive ? { archive } : {}),
      minScore: Number(values['min-score'] ?? 0.4),
    },
    since,
    now,
  );
  const candidates = collected.candidates.filter((c) => projectOf(c.project));
  console.error(
    `${collected.candidates.length} candidates, ${candidates.length} in ${wanted.join(', ')} (archive: ${archive ? 'yes' : 'no'})`,
  );
  // The Prospector's classifier on the subscription's decision model, sharing `foundry repeats`' cache.
  const model = 'claude-haiku-5-5';
  const state = privateDirectory(dirname(out));
  markEvalRun(state);
  const concurrency = Number(values.concurrency ?? 4);
  const host = decisionHost(model, 'claude', concurrency, state);
  const cache = loadCache();
  const usage: StageUsage = {
    stage: 'scan',
    model,
    calls: 0,
    failed: 0,
    errors: {},
    tokens: { input: 0, output: 0 },
  };
  const tokens: TokenCounts[] = [];
  let classified: Map<string, { isCorrection: boolean; sharp: boolean; statements: string[] }>;
  try {
    classified = await scan(
      candidates,
      {
        scan: { provider: host.provider, model, batch: 10, concurrency },
        cache,
        progress: (line) => process.stderr.write(`\r${line}`),
      },
      usage,
      tokens,
    );
  } finally {
    saveCache(cache);
    await host.shutdown();
  }
  process.stderr.write('\n');
  const scrub = (text: string) => scrubSecrets(text).text;
  const probes: (WardenProbe & { provenance: Record<string, string | null> })[] = [];
  for (const c of candidates) {
    const verdict = classified.get(c.event.id);
    const ask = (c.event.ask ?? '').trim();
    const turn = c.event.before.trim();
    // A moment needs something a Warden could have spoken on.
    if (!verdict || (ask.length < 20 && turn.length < 100)) continue;
    const project = projectOf(c.project)!;
    const kind =
      verdict.isCorrection && verdict.sharp
        ? 'positive'
        : !verdict.isCorrection
          ? 'negative'
          : undefined;
    if (!kind) continue;
    probes.push({
      id: `${project}-${c.harness}-${c.event.id.replace(/[^A-Za-z0-9:_-]/g, '').slice(-48)}`,
      kind,
      ctx: PROJECTS[project]!.ctx,
      project,
      moment: turn.length >= 100 ? scrub(turn.slice(-4000)) : '',
      ...(ask.length >= 20 ? { ask: scrub(ask.slice(0, 3000)) } : {}),
      at: new Date(Date.parse(c.event.timestamp)).toISOString(),
      ...(kind === 'positive' ? { gold: { domains: [], statements: verdict.statements } } : {}),
      hidden: scrub(c.event.correction.slice(0, 2000)),
      provenance: {
        harness: c.harness,
        file: c.file.startsWith('archive:') ? c.file : c.harness === 'history' ? 'history' : c.file,
        correctionId: c.event.id,
        signal: c.event.signal,
      },
    });
  }
  // Per project: the latest --test-share of positives by time are the test period.
  const cuts: Record<string, string> = {};
  for (const project of wanted) {
    const times = probes
      .filter((p) => p.project === project && p.kind === 'positive')
      .map((p) => p.at!)
      .sort();
    if (!times.length) continue;
    cuts[project] = times[Math.min(times.length - 1, Math.floor(times.length * (1 - testShare)))]!;
  }
  const split = probes
    .map((p) => ({
      ...p,
      period: (p.at! >= (cuts[p.project!] ?? '9999') ? 'test' : 'train') as 'train' | 'test',
    }))
    .sort((a, b) => a.at!.localeCompare(b.at!));
  writePrivate(out, `${split.map((p) => JSON.stringify(p)).join('\n')}\n`);
  const counts: Record<string, number> = {};
  for (const p of split) {
    const triggers = [p.ask ? 'ask' : '', p.moment ? 'turn' : ''].filter(Boolean).join('+');
    const key = [p.project, p.period, p.kind, p.provenance.harness, triggers].join(' ');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const manifest = {
    builtAt: new Date(now).toISOString(),
    since: new Date(since).toISOString(),
    projects: wanted,
    testShare,
    testFrom: cuts,
    classifier: { model, calls: usage.calls, failed: usage.failed, errors: usage.errors },
    sources: collected.sources,
    fromArchive: collected.fromArchive,
    candidates: candidates.length,
    probes: split.length,
    counts: Object.fromEntries(Object.entries(counts).sort()),
  };
  writePrivate(join(dirname(out), 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(JSON.stringify(manifest, null, 1));
}

if (values['label-targets']) await labelTargets();
else if (values.sessions) await fromSessions();
else fromKit();

/** Opus labels each positive's target over the subscription; answers are kept in targets-raw.jsonl. */
async function labelTargets() {
  const probes = readFileSync(out, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WardenProbe);
  const rawFile = join(dirname(out), 'targets-raw.jsonl');
  const raw = new Map<string, CorrectionTarget | null>(
    (existsSync(rawFile) ? readFileSync(rawFile, 'utf8').split('\n') : [])
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as { id: string; target: CorrectionTarget | null };
        return [row.id, row.target];
      }),
  );
  const pending = probes.filter((p) => p.kind === 'positive' && !raw.has(p.id));
  const model = 'claude-opus-5-5';
  const state = privateDirectory(dirname(out));
  markEvalRun(state);
  const concurrency = Number(values.concurrency ?? 3);
  const host = decisionHost(model, 'claude', concurrency, state);
  const save = () =>
    writePrivate(
      rawFile,
      [...raw].map(([id, target]) => `${JSON.stringify({ id, target })}\n`).join(''),
    );
  const ask = async (batch: WardenProbe[]): Promise<void> => {
    try {
      const result = await host.provider.complete(correctionTargetMessages(batch), {
        tools: false,
        maxTurns: 1,
        temperature: 0,
      });
      const parsed = parseCorrectionTargets(
        result.content,
        batch.map((p) => p.id),
      );
      batch.forEach((p, i) => {
        if (parsed[i] !== undefined) raw.set(p.id, parsed[i]!);
      });
      save();
      const missing = batch.filter((_, i) => parsed[i] === undefined);
      if (missing.length && missing.length < batch.length) for (const p of missing) await ask([p]);
    } catch (error) {
      console.error(`label failed: ${String(error).slice(0, 160)}`);
      if (batch.length > 1) for (const p of batch) await ask([p]);
    }
  };
  const batches: WardenProbe[][] = [];
  for (let i = 0; i < pending.length; i += 8) batches.push(pending.slice(i, i + 8));
  let next = 0;
  let labelled = 0;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let batch = batches[next++]; batch; batch = batches[next++]) {
          await ask(batch);
          labelled += batch.length;
          process.stderr.write(`\rlabelled ${labelled}/${pending.length}`);
        }
      }),
    );
    process.stderr.write('\n');
    // One merge call per concept cluster: names for the same thing share a canonical name.
    const byConcept = new Map<string, Set<string>>();
    for (const target of raw.values())
      if (target)
        byConcept.set(
          target.concept,
          (byConcept.get(target.concept) ?? new Set()).add(target.name),
        );
    const canonical = new Map<string, string>();
    for (const [concept, set] of byConcept) {
      const names = [...set].sort();
      let merged = names;
      if (names.length > 1) {
        const result = await host.provider
          .complete(targetCanonicalMessages(concept, names), {
            tools: false,
            maxTurns: 1,
            temperature: 0,
          })
          .catch(() => undefined);
        if (result) merged = parseTargetCanonical(result.content, names);
      }
      names.forEach((name, i) => {
        canonical.set(`${concept}|${name}`, merged[i]!);
      });
    }
    const labelled2 = probes.map((p) => {
      const target = raw.get(p.id);
      if (p.kind !== 'positive' || !target) return p;
      return {
        ...p,
        gold: {
          domains: p.gold?.domains ?? [],
          statements: p.gold?.statements ?? [],
          target: {
            ...target,
            canonical: canonical.get(`${target.concept}|${target.name}`) ?? target.name,
          },
        },
      };
    });
    writePrivate(out, `${labelled2.map((p) => JSON.stringify(p)).join('\n')}\n`);
    // The distinct targets, by cluster, most corrected first.
    type Entry = {
      target: string;
      kind: string;
      concept: string;
      where: string[];
      corrections: number;
      byPeriod: Record<string, number>;
      byProject: Record<string, number>;
      names: string[];
      probes: string[];
    };
    const entries = new Map<string, Entry>();
    for (const p of labelled2) {
      const t = p.gold?.target;
      if (!t?.canonical) continue;
      const key = `${t.concept}|${t.canonical}`;
      const e = entries.get(key) ?? {
        target: t.canonical,
        kind: t.kind,
        concept: t.concept,
        where: [],
        corrections: 0,
        byPeriod: {},
        byProject: {},
        names: [],
        probes: [],
      };
      e.corrections++;
      if (t.where && !e.where.includes(t.where)) e.where.push(t.where);
      if (!e.names.includes(t.name)) e.names.push(t.name);
      e.byPeriod[p.period ?? '?'] = (e.byPeriod[p.period ?? '?'] ?? 0) + 1;
      e.byProject[p.project ?? '?'] = (e.byProject[p.project ?? '?'] ?? 0) + 1;
      e.probes.push(p.id);
      entries.set(key, e);
    }
    const list = [...entries.values()].sort(
      (a, b) => a.concept.localeCompare(b.concept) || b.corrections - a.corrections,
    );
    const positives = labelled2.filter((p) => p.kind === 'positive');
    const summary = {
      positives: positives.length,
      targeted: positives.filter((p) => p.gold?.target).length,
      noExistingTarget: positives.filter((p) => raw.get(p.id) === null).length,
      unlabelled: positives.filter((p) => !raw.has(p.id)).length,
      distinctTargets: list.length,
      concepts: Object.fromEntries(
        [...new Set(list.map((e) => e.concept))].map((c) => [
          c,
          {
            targets: list.filter((e) => e.concept === c).length,
            corrections: list.filter((e) => e.concept === c).reduce((n, e) => n + e.corrections, 0),
          },
        ]),
      ),
    };
    writePrivate(
      join(dirname(out), 'targets.json'),
      `${JSON.stringify({ ...summary, targets: list }, null, 1)}\n`,
    );
    console.log(JSON.stringify(summary, null, 1));
  } finally {
    await host.shutdown();
  }
}
