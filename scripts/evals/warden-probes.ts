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
 *
 * From the person's PR reviews on GitHub (read-only, through the caller's `gh` login):
 *   bun scripts/evals/warden-probes.ts --github --out ~/.foundry/evals/warden-corrections/probes.jsonl \
 *     [--repos inixiative/template,inixiative/kingdom,inixiative/foundry,userevidence/Zealot-Monorepo] \
 *     [--reviewer agreenspan] [--refresh] [--concurrency 3]
 * Every review, inline review comment and PR comment the reviewer wrote. Change-request reviews are
 * read whole, the rest when they carry a reuse hint; Opus names each place the review pushed toward
 * something that already existed (the target, what was built instead, why it was missed). Each
 * finding is a positive probe (`source: 'github'`), its moment the diff hunk or the PR, labelled with
 * who wrote it (`authorship`: the person, or an agent posting under their account) so scoring can
 * filter. Its target goes into targets-raw.jsonl; run --label-targets next to merge it with the
 * session targets. Fetches, session evidence and readings are cached under sources/github/.
 * Periods: a project's existing test cut (manifest.testFrom) is kept; a new project gets its own.
 *
 * From the person's Linear workspace (read-only; the key is read from an env file, never printed):
 *   bun scripts/evals/warden-probes.ts --linear --out ~/.foundry/evals/warden-corrections/probes.jsonl \
 *     [--linear-env ~/code/zealot/.env.local] [--refresh] [--concurrency 3]
 * The key's user's comments (read whole) and the issue and project descriptions they wrote (read when
 * they carry a reuse hint, as directives). Same findings, probes and targets as --github, with
 * `source: 'linear'`. A comment's moment is the issue it was written on; a directive's ask is the
 * ticket's title, so the user-message trigger is tested on it. Authorship is labelled; agent-written
 * items still count as the person's (Aron, 2026-10-15). Each finding's `scope` sets its `weight`:
 * generic code-correctness findings count 0.75, architectural ones 1.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  authorshipOf,
  type CorrectionTarget,
  correctionTargetMessages,
  evidenceSnippet,
  type ProbeSource,
  parseCorrectionTargets,
  parseReviewFindings,
  parseTargetCanonical,
  REUSE_HINT,
  type ReviewMoment,
  type ReviewReading,
  reviewFindingMessages,
  SCOPE_WEIGHT,
  type SessionEvidence,
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
import { LINEAR_POSTING, sessionEvidence } from './sources/evidence';
import { fetchReviewedPrs, type ReviewedPr } from './sources/github';
import { envValue, fetchLinearItems, type LinearItem } from './sources/linear';

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
    github: { type: 'boolean' },
    repos: { type: 'string' },
    reviewer: { type: 'string' },
    refresh: { type: 'boolean' },
    linear: { type: 'boolean' },
    'linear-env': { type: 'string' },
  },
});
if (
  (!values.work &&
    !values.sessions &&
    !values.github &&
    !values.linear &&
    !values['label-targets']) ||
  !values.out
) {
  console.error(
    'usage: warden-probes.ts (--work <kit work dir> | --sessions --projects a,b | --github | --linear | --label-targets) --out <probes.jsonl>',
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
      source: 'session',
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
  // Other sources' probes stay; their periods follow the cut they were built against.
  const others = readProbes().filter((p) => (p.source ?? 'session') !== 'session');
  writePrivate(out, `${[...split, ...others].map((p) => JSON.stringify(p)).join('\n')}\n`);
  const counts: Record<string, number> = {};
  for (const p of split) {
    const triggers = [p.ask ? 'ask' : '', p.moment ? 'turn' : ''].filter(Boolean).join('+');
    const key = [p.project, p.period, p.kind, p.provenance.harness, triggers].join(' ');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const previous = readManifest();
  const manifest = {
    ...previous,
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

function readProbes(): WardenProbe[] {
  if (!existsSync(out)) return [];
  return readFileSync(out, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WardenProbe);
}

type Manifest = { testShare?: number; testFrom?: Record<string, string> } & Record<string, unknown>;
function readManifest(): Manifest {
  const file = join(dirname(out), 'manifest.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : {};
}

/** Which eval project and context a reviewed repository belongs to. */
const REPO_PROJECTS: Record<string, { project: string; ctx: string }> = {
  'inixiative/template': { project: 'template', ctx: 'inixiative' },
  'inixiative/kingdom': { project: 'kingdom', ctx: 'inixiative' },
  'inixiative/foundry': { project: 'foundry', ctx: 'inixiative' },
  'userevidence/Zealot-Monorepo': { project: 'zealot', ctx: 'userevidence' },
};

async function fromGitHub() {
  const repos = (values.repos ?? Object.keys(REPO_PROJECTS).join(',')).split(',').filter(Boolean);
  for (const repo of repos)
    if (!REPO_PROJECTS[repo]) throw Error(`unknown repo ${repo}: ${Object.keys(REPO_PROJECTS)}`);
  const reviewer = values.reviewer ?? 'agreenspan';
  const state = privateDirectory(dirname(out));
  const cache = privateDirectory(join(state, 'sources', 'github'));
  const now = Date.now();

  // 1. Fetch: every PR the reviewer wrote on. Repos where the reviewer also authors are listed whole.
  const prs: ReviewedPr[] = [];
  for (const repo of repos) {
    const file = join(cache, `${repo.replace('/', '__')}.json`);
    if (values.refresh || !existsSync(file)) {
      const fetched = await fetchReviewedPrs(repo, reviewer, {
        all: repo.startsWith('inixiative/'),
        progress: (line) => process.stderr.write(`\r${line}`),
      });
      process.stderr.write('\n');
      writePrivate(file, JSON.stringify(fetched));
    }
    prs.push(...(JSON.parse(readFileSync(file, 'utf8')) as ReviewedPr[]));
  }
  const items = prs.flatMap((pr) => pr.items.map((item) => ({ pr, item })));

  // 2. Authorship evidence from the person's own sessions (cached; --refresh rescans).
  const evidenceFile = join(cache, 'evidence.json');
  let evidence: Record<string, SessionEvidence>;
  if (values.refresh || !existsSync(evidenceFile)) {
    process.stderr.write(`scanning sessions for ${items.length} comments…\n`);
    const found = await sessionEvidence(
      items.map(({ item }) => item),
      [
        join(homedir(), '.claude', 'projects'),
        join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
      ],
      (text) => evidenceSnippet(text),
    );
    evidence = Object.fromEntries(found);
    writePrivate(evidenceFile, JSON.stringify(evidence));
  } else
    evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as Record<string, SessionEvidence>;

  // 3. Read: change-request reviews whole, everything else with a reuse hint.
  const byId = new Map(items.map((entry) => [entry.item.id, entry]));
  const commentText = (id?: string) =>
    id
      ? (byId.get(id)?.item.body ??
        items.flatMap(({ pr }) => pr.thread).find((t) => t.id === id)?.body)
      : undefined;
  const candidates = items.filter(
    ({ item }) =>
      item.state !== 'PENDING' &&
      (item.state === 'CHANGES_REQUESTED' || REUSE_HINT.test(item.body)),
  );
  const moment = ({ pr, item }: (typeof items)[number]): ReviewMoment => {
    const replyTo = commentText(item.replyTo);
    return {
      id: item.id,
      where: `${pr.repo} PR #${pr.number} by ${pr.author === reviewer ? 'the reviewer (an agent working for him)' : pr.author} (${item.kind}${item.state ? `, ${item.state} review` : ''})`,
      work: `${pr.title}\n\n${pr.body}`,
      ...(item.diffHunk
        ? { code: `${item.path ?? ''}${item.line ? `:${item.line}` : ''}\n${item.diffHunk}` }
        : {}),
      ...(replyTo ? { replyTo } : {}),
      text: item.body,
    };
  };
  const { readings, failed, model } = await readMoments(
    join(cache, 'readings.jsonl'),
    candidates.map((entry) => moment(entry)),
    state,
    `${items.length} comments on ${prs.length} PRs`,
  );

  // 4. Probes: one per finding, deduped within a PR by target name.
  const scrub = (text: string) => scrubSecrets(text).text;
  const seen = new Set<string>();
  const probes: (WardenProbe & { provenance: Record<string, string | number | null> })[] = [];
  for (const entry of candidates) {
    const { pr, item } = entry;
    const reading = readings.get(item.id);
    if (!reading?.findings.length) continue;
    const { project, ctx } = REPO_PROJECTS[pr.repo]!;
    const authorship = authorshipOf(item.body, evidence[item.id], reading.voice);
    for (const finding of reading.findings) {
      const key = `${pr.repo}#${pr.number}|${finding.target.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = `github-${project}-${pr.number}-${createHash('sha256').update(`${item.id}|${finding.target.name}`).digest('hex').slice(0, 10)}`;
      const head = `${pr.repo} PR #${pr.number}: ${pr.title}`;
      probes.push({
        id,
        kind: 'positive',
        ctx,
        project,
        source: 'github',
        authorship,
        moment: scrub(
          item.diffHunk
            ? `${head}\n\n${item.path ?? ''}${item.line ? `:${item.line}` : ''}\n${item.diffHunk.slice(-1500)}`
            : `${head}\n\n${pr.body.slice(0, 1500)}`,
        ),
        at: new Date(Date.parse(item.at)).toISOString(),
        gold: {
          domains: [],
          statements: [
            `Use ${finding.target.name}${finding.target.builtInstead ? ` instead of ${finding.target.builtInstead}` : ''}`,
          ],
        },
        hidden: scrub(finding.excerpt || item.body.slice(0, 300)),
        ...(finding.scope ? { weight: SCOPE_WEIGHT[finding.scope] } : {}),
        provenance: {
          url: item.url,
          repo: pr.repo,
          pr: pr.number,
          prAuthor: pr.author,
          item: item.kind,
          state: item.state ?? null,
        },
      });
      // The target is already named: it joins the session targets at --label-targets.
      targetsRaw.set(id, finding.target);
    }
  }

  // 5. Periods and the merge into probes.jsonl.
  const { split, cuts, manifest } = writeSourceProbes('github', probes);

  const counts: Record<string, number> = {};
  for (const p of split) {
    const key = [p.project, p.period, p.authorship!.by, p.authorship!.confidence].join(' ');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const misses: Record<string, number> = {};
  for (const p of split) {
    const miss = targetsRaw.get(p.id)?.miss ?? 'unclear';
    misses[miss] = (misses[miss] ?? 0) + 1;
  }
  const comments: Record<string, number> = {};
  for (const { pr, item } of items) {
    const a = authorshipOf(item.body, evidence[item.id], readings.get(item.id)?.voice);
    const key = `${REPO_PROJECTS[pr.repo]!.project} ${a.by} ${a.confidence}`;
    comments[key] = (comments[key] ?? 0) + 1;
  }
  const github = {
    builtAt: new Date(now).toISOString(),
    reviewer,
    repos,
    model,
    prs: prs.length,
    comments: items.length,
    read: candidates.length,
    readFailed: failed,
    withFindings: candidates.filter(({ item }) => readings.get(item.id)?.findings.length).length,
    probes: split.length,
    authorshipOfComments: Object.fromEntries(Object.entries(comments).sort()),
    misses,
    counts: Object.fromEntries(Object.entries(counts).sort()),
  };
  writePrivate(
    join(dirname(out), 'manifest.json'),
    `${JSON.stringify({ ...manifest, testFrom: cuts, github }, null, 1)}\n`,
  );
  console.log(JSON.stringify({ testFrom: cuts, ...github }, null, 1));
}

/** Which eval project and context a Linear workspace belongs to. */
const LINEAR_WORKSPACES: Record<string, { project: string; ctx: string }> = {
  userevidence: { project: 'zealot', ctx: 'userevidence' },
};

async function fromLinear() {
  const envFile = resolve(values['linear-env'] ?? join(homedir(), 'code', 'zealot', '.env.local'));
  const key = envValue(envFile, 'LINEAR_API_KEY');
  if (!key) {
    console.error(`no LINEAR_API_KEY in ${envFile}`);
    process.exit(2);
  }
  const state = privateDirectory(dirname(out));
  const cache = privateDirectory(join(state, 'sources', 'linear'));
  const now = Date.now();

  // 1. Fetch everything the key's user wrote.
  const file = join(cache, 'items.json');
  if (values.refresh || !existsSync(file)) {
    const fetched = await fetchLinearItems(key, (line) => process.stderr.write(`\r${line}`));
    process.stderr.write('\n');
    writePrivate(file, JSON.stringify(fetched));
  }
  const { workspace, items } = JSON.parse(readFileSync(file, 'utf8')) as {
    workspace: string;
    items: LinearItem[];
  };
  const place = LINEAR_WORKSPACES[workspace];
  if (!place)
    throw Error(`unknown Linear workspace ${workspace}: ${Object.keys(LINEAR_WORKSPACES)}`);

  // 2. Authorship evidence: the text inside a session's Linear tool call, or a typed prompt.
  const evidenceFile = join(cache, 'evidence.json');
  let evidence: Record<string, SessionEvidence>;
  if (values.refresh || !existsSync(evidenceFile)) {
    process.stderr.write(`scanning sessions for ${items.length} Linear items…\n`);
    const found = await sessionEvidence(
      items,
      [
        join(homedir(), '.claude', 'projects'),
        join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
      ],
      (text) => evidenceSnippet(text),
      LINEAR_POSTING,
    );
    evidence = Object.fromEntries(found);
    writePrivate(evidenceFile, JSON.stringify(evidence));
  } else
    evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as Record<string, SessionEvidence>;

  // 3. Read: comments whole; issue and project descriptions as directives, when they carry a hint.
  const candidates = items.filter((i) => i.kind === 'comment' || REUSE_HINT.test(i.body));
  const moment = (i: LinearItem): ReviewMoment => ({
    id: i.id,
    where: `Linear ${workspace} ${i.kind === 'project' ? `project "${i.subject.title}"` : i.subject.ref} (${i.kind}${i.kind === 'comment' ? ` on an issue opened by ${i.subject.creator}` : ''})`,
    work:
      i.kind === 'comment'
        ? `${i.subject.ref}: ${i.subject.title}\n\n${i.subject.description}`
        : `${i.subject.ref === 'project' ? 'Project' : i.subject.ref}: ${i.subject.title}`,
    ...(i.replyTo ? { replyTo: i.replyTo } : {}),
    text: i.body,
    mode: i.kind === 'comment' ? 'review' : 'directive',
  });
  const { readings, failed, model } = await readMoments(
    join(cache, 'readings.jsonl'),
    candidates.map(moment),
    state,
    `${items.length} Linear items in ${workspace}`,
  );

  // 4. Probes: one per finding, deduped within an issue by target name.
  const scrub = (text: string) => scrubSecrets(text).text;
  const seen = new Set<string>();
  const probes: (WardenProbe & { provenance: Record<string, string | number | null> })[] = [];
  for (const item of candidates) {
    const reading = readings.get(item.id);
    if (!reading?.findings.length) continue;
    const authorship = authorshipOf(item.body, evidence[item.id], reading.voice);
    const subject = item.kind === 'project' ? `project:${item.subject.title}` : item.subject.ref;
    for (const finding of reading.findings) {
      const dedupe = `${subject}|${finding.target.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const id = `linear-${place.project}-${createHash('sha256').update(`${item.id}|${finding.target.name}`).digest('hex').slice(0, 12)}`;
      const head = `${item.subject.ref === 'project' ? 'Project' : item.subject.ref}: ${item.subject.title}`;
      probes.push({
        id,
        kind: 'positive',
        ctx: place.ctx,
        project: place.project,
        source: 'linear',
        authorship,
        // A comment answers work in progress (the issue); a directive is tested on its ticket's ask.
        moment:
          item.kind === 'comment'
            ? scrub(`${head}\n\n${item.subject.description.slice(0, 1500)}`)
            : '',
        ...(item.kind === 'comment' ? {} : { ask: scrub(head) }),
        at: new Date(Date.parse(item.at)).toISOString(),
        gold: {
          domains: [],
          statements: [
            `Use ${finding.target.name}${finding.target.builtInstead ? ` instead of ${finding.target.builtInstead}` : ''}`,
          ],
        },
        hidden: scrub(finding.excerpt || item.body.slice(0, 300)),
        ...(finding.scope ? { weight: SCOPE_WEIGHT[finding.scope] } : {}),
        provenance: { url: item.url, ref: item.subject.ref, item: item.kind },
      });
      targetsRaw.set(id, finding.target);
    }
  }

  // 5. Periods and the merge into probes.jsonl.
  const { split, cuts, manifest } = writeSourceProbes('linear', probes);
  const tally = (key: (p: (typeof split)[number]) => string) => {
    const counts: Record<string, number> = {};
    for (const p of split) counts[key(p)] = (counts[key(p)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort());
  };
  const linear = {
    builtAt: new Date(now).toISOString(),
    workspace,
    model,
    items: items.length,
    byKind: Object.fromEntries(
      ['comment', 'issue', 'project'].map((k) => [k, items.filter((i) => i.kind === k).length]),
    ),
    read: candidates.length,
    readFailed: failed,
    withFindings: candidates.filter((i) => readings.get(i.id)?.findings.length).length,
    probes: split.length,
    counts: tally((p) =>
      [p.project, p.period, p.provenance.item, p.authorship!.by, p.authorship!.confidence].join(
        ' ',
      ),
    ),
    misses: tally((p) => targetsRaw.get(p.id)?.miss ?? 'unclear'),
    weights: tally((p) => String(p.weight ?? 1)),
  };
  writePrivate(
    join(dirname(out), 'manifest.json'),
    `${JSON.stringify({ ...manifest, testFrom: cuts, linear }, null, 1)}\n`,
  );
  console.log(JSON.stringify({ testFrom: cuts, ...linear }, null, 1));
}

/** Opus reads each review moment for findings, resumable: readings are cached in `file` by id. */
async function readMoments(
  file: string,
  moments: readonly ReviewMoment[],
  state: string,
  label: string,
): Promise<{ readings: Map<string, ReviewReading>; failed: number; model: string }> {
  const readings = new Map<string, ReviewReading>(
    (existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []).filter(Boolean).map((line) => {
      const row = JSON.parse(line) as { id: string; reading: ReviewReading };
      return [row.id, row.reading];
    }),
  );
  const pending = moments.filter((m) => !readings.has(m.id));
  process.stderr.write(`${label}; ${moments.length} to read, ${pending.length} new\n`);
  const model = 'claude-opus-5-5';
  const concurrency = Number(values.concurrency ?? 3);
  let failed = 0;
  if (!pending.length) return { readings, failed, model };
  markEvalRun(state);
  const host = decisionHost(model, 'claude', concurrency, state);
  const save = () =>
    writePrivate(
      file,
      [...readings].map(([id, reading]) => `${JSON.stringify({ id, reading })}\n`).join(''),
    );
  const read = async (batch: readonly ReviewMoment[]): Promise<void> => {
    try {
      const result = await host.provider.complete(reviewFindingMessages(batch), {
        tools: false,
        maxTurns: 1,
        temperature: 0,
      });
      const parsed = parseReviewFindings(
        result.content,
        batch.map((m) => m.id),
      );
      batch.forEach((m, i) => {
        if (parsed[i]) readings.set(m.id, parsed[i]!);
      });
      save();
      const missing = batch.filter((_, i) => !parsed[i]);
      if (missing.length && missing.length < batch.length) for (const m of missing) await read([m]);
      else if (missing.length === 1) failed++;
    } catch (error) {
      console.error(`read failed: ${String(error).slice(0, 160)}`);
      if (batch.length > 1) for (const m of batch) await read([m]);
      else failed++;
    }
  };
  const batches: ReviewMoment[][] = [];
  for (let i = 0; i < pending.length; i += 6) batches.push(pending.slice(i, i + 6));
  let next = 0;
  let done = 0;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let batch = batches[next++]; batch; batch = batches[next++]) {
          await read(batch);
          done += batch.length;
          process.stderr.write(`\rread ${done}/${pending.length}`);
        }
      }),
    );
    process.stderr.write('\n');
  } finally {
    await host.shutdown();
  }
  return { readings, failed, model };
}

/**
 * Merge one source's probes into probes.jsonl, replacing that source's earlier probes and stale
 * targets. Periods keep each project's existing cut; a project without one gets its own.
 */
function writeSourceProbes<P extends WardenProbe>(source: ProbeSource, probes: readonly P[]) {
  const manifest = readManifest();
  const testShare = Number(values['test-share'] ?? manifest.testShare ?? 0.3);
  const cuts: Record<string, string> = { ...(manifest.testFrom ?? {}) };
  for (const project of new Set(probes.map((p) => p.project!))) {
    if (cuts[project]) continue;
    const times = probes
      .filter((p) => p.project === project)
      .map((p) => p.at!)
      .sort();
    cuts[project] = times[Math.min(times.length - 1, Math.floor(times.length * (1 - testShare)))]!;
  }
  const split = probes.map((p) => ({
    ...p,
    period: (p.at! >= cuts[p.project!]! ? 'test' : 'train') as 'train' | 'test',
  }));
  const kept = readProbes().filter((p) => (p.source ?? 'session') !== source);
  writePrivate(
    out,
    `${[...kept, ...split]
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
      .map((p) => JSON.stringify(p))
      .join('\n')}\n`,
  );
  saveTargetsRaw(new Set(split.map((p) => p.id)), `${source}-`);
  return { split, cuts, manifest };
}

/** targets-raw.jsonl: the target each positive pushed toward (null: none existed), by probe id. */
const targetsRawFile = join(dirname(out), 'targets-raw.jsonl');
const targetsRaw = new Map<string, CorrectionTarget | null>(
  (existsSync(targetsRawFile) ? readFileSync(targetsRawFile, 'utf8').split('\n') : [])
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { id: string; target: CorrectionTarget | null };
      return [row.id, row.target];
    }),
);
/** Write targets-raw.jsonl; a source's rebuild drops its stale ids (those not in `keep`). */
function saveTargetsRaw(keep?: Set<string>, source = 'github-') {
  writePrivate(
    targetsRawFile,
    [...targetsRaw]
      .filter(([id]) => !keep || !id.startsWith(source) || keep.has(id))
      .map(([id, target]) => `${JSON.stringify({ id, target })}\n`)
      .join(''),
  );
}

/** Opus labels each positive's target over the subscription; answers are kept in targets-raw.jsonl. */
async function labelTargets() {
  const probes = readFileSync(out, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WardenProbe);
  const raw = targetsRaw;
  const pending = probes.filter((p) => p.kind === 'positive' && !raw.has(p.id));
  const model = 'claude-opus-5-5';
  const state = privateDirectory(dirname(out));
  markEvalRun(state);
  const concurrency = Number(values.concurrency ?? 3);
  const host = decisionHost(model, 'claude', concurrency, state);
  const save = () => saveTargetsRaw();
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
      bySource: Record<string, number>;
      /** Corrections from sources where agents also post under the person's account, by who wrote them. */
      byAuthorship: Record<string, number>;
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
        bySource: {},
        byAuthorship: {},
        names: [],
        probes: [],
      };
      e.corrections++;
      if (t.where && !e.where.includes(t.where)) e.where.push(t.where);
      if (!e.names.includes(t.name)) e.names.push(t.name);
      e.byPeriod[p.period ?? '?'] = (e.byPeriod[p.period ?? '?'] ?? 0) + 1;
      e.byProject[p.project ?? '?'] = (e.byProject[p.project ?? '?'] ?? 0) + 1;
      const source: ProbeSource = p.source ?? 'session';
      e.bySource[source] = (e.bySource[source] ?? 0) + 1;
      if (p.authorship) {
        const who = `${p.authorship.by}/${p.authorship.confidence}`;
        e.byAuthorship[who] = (e.byAuthorship[who] ?? 0) + 1;
      }
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
      bySource: Object.fromEntries(
        [...new Set(positives.map((p) => p.source ?? 'session'))].map((source) => [
          source,
          {
            positives: positives.filter((p) => (p.source ?? 'session') === source).length,
            targets: list.filter((e) => e.bySource[source]).length,
            onlyHere: list.filter((e) => e.bySource[source] && Object.keys(e.bySource).length === 1)
              .length,
          },
        ]),
      ),
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

if (values['label-targets']) await labelTargets();
else if (values.sessions) await fromSessions();
else if (values.github) await fromGitHub();
else if (values.linear) await fromLinear();
else fromKit();
