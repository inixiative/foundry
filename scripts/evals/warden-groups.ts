#!/usr/bin/env bun
/**
 * Recogniser granularity (eval-only): group regions so one recogniser covers several, and map its
 * answers back to per-region rows. Design: ~/.foundry/evals/experiments/2026-10-15-recogniser-granularity.md.
 *
 *   bun scripts/evals/warden-groups.ts build --regions <pinned regions dir> --budget <tokens|all|1> \
 *     --out <arm dir> [--random --seed <n>] [--seams <seams.txt>] [--votes <votes.json>] \
 *     [--atlas-parents <parents.json>]
 *   bun scripts/evals/warden-groups.ts expand --run <group run dir> --groups <groups.json> --out <dir>
 *
 * build reads every region's `region.json` and `recognise.md` (its short recognition text; a region
 * without one is an error), weighs each pair of regions by concept adjacency with weights fixed in
 * advance (3 × seam siblings, 2 × Jaccard of `sources.docs`, 1 × Jaccard of `sources.catalogClusters`,
 * 1 × shared Atlas parent when --atlas-parents is given, 2 × consensus-vote co-assignment when --votes
 * is given), and joins regions by greedy average linkage until a group reaches the token budget
 * (chars ÷ 4 of the recognise texts). `--budget 1` is G1 (one region per group); `--budget all` is one
 * group of everything. `--random --seed <n>` fills token-matched groups from a shuffled order instead,
 * the control for grouping quality. It writes `<out>/groups.json` (members in merge order, tokens,
 * the weights and inputs used, the regions set's content hash) and a chorus directory
 * `<out>/regions/<group id>/{region.json,knowledge.md}` where knowledge.md is the members' recognise.md
 * texts, each under `# Region <id>: <title>` with its own headings demoted one level, content otherwise
 * unchanged. That directory is what `warden-charter.ts --regions` runs.
 *
 * expand reads a run made on a grouped chorus and writes `<out>/answers.jsonl`, `turns.jsonl`,
 * `score.json` and `quota.jsonl` as if each region had answered for itself: a group's remark names
 * regions one per line (`<id>: <why>`, `region <id>: <why>`; several ids before one colon share the
 * line and are counted as a collapse); a named member is a yes with that line, an unnamed member is
 * NO_COMMENT, an id outside the group is a parse error (counted in `<out>/parse.json`, never guessed).
 * The standard report then runs on the expanded directory unchanged.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { WardenProbeAnswer, WardenProbeTurn } from '../../packages/core/src';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    regions: { type: 'string' },
    budget: { type: 'string' },
    out: { type: 'string' },
    random: { type: 'boolean' },
    seed: { type: 'string' },
    seams: { type: 'string' },
    votes: { type: 'string' },
    'atlas-parents': { type: 'string' },
    run: { type: 'string' },
    groups: { type: 'string' },
  },
});
const usage = () => {
  console.error(
    'usage: warden-groups.ts build --regions <dir> --budget <tokens|all|1> --out <dir> [--random --seed <n>] | expand --run <dir> --groups <groups.json> --out <dir>',
  );
  process.exit(2);
};
const privateDir = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
};
const writePrivate = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });
const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

// ---------------------------------------------------------------------------
// Regions as the builder wrote them
// ---------------------------------------------------------------------------
interface Region {
  id: string;
  title: string;
  routing: string;
  concepts: string[];
  docs: string[];
  clusters: string[];
  recognise: string;
  tokens: number;
}
const tokensOf = (text: string) => Math.ceil(text.length / 4);
function readRegions(dir: string): Region[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw Error(`--regions ${dir} is not a directory`);
  const regions: Region[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = join(dir, entry.name, 'region.json');
    if (!existsSync(meta)) continue;
    const recognisePath = join(dir, entry.name, 'recognise.md');
    if (!existsSync(recognisePath))
      throw Error(
        `region ${entry.name} has no recognise.md: the recogniser's text is what groups hold`,
      );
    const r = JSON.parse(readFileSync(meta, 'utf8')) as {
      id: string;
      title: string;
      routing: string;
      concepts?: string[];
      sources?: { docs?: string[]; catalogClusters?: string[] };
    };
    if (r.id !== entry.name) throw Error(`region ${entry.name}: region.json id ${r.id} differs`);
    const recognise = readFileSync(recognisePath, 'utf8');
    regions.push({
      id: r.id,
      title: r.title,
      routing: r.routing,
      concepts: r.concepts ?? [],
      docs: r.sources?.docs ?? [],
      clusters: r.sources?.catalogClusters ?? [],
      recognise,
      tokens: tokensOf(recognise),
    });
  }
  return regions.sort((a, b) => a.id.localeCompare(b.id));
}
/** The regions set's identity: a hash of its recognise texts in id order. */
const regionsHash = (regions: readonly Region[]) =>
  createHash('sha256')
    .update(regions.map((r) => `${r.id}\0${r.recognise}`).join('\0\0'))
    .digest('hex')
    .slice(0, 12);

// ---------------------------------------------------------------------------
// Adjacency weights (fixed in advance)
// ---------------------------------------------------------------------------
const WEIGHTS = { seam: 3, docs: 2, clusters: 1, atlasParent: 1, votes: 2 } as const;
const jaccard = (a: readonly string[], b: readonly string[]) => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
};
/**
 * Seam siblings from the consensus `seams.txt`: each line is a split region followed by a dict whose
 * keys are `<kind>:<new region id>`; the new ids named on one line are siblings of each other.
 */
function readSeams(path: string | undefined, ids: ReadonlySet<string>): Set<string> {
  const pairs = new Set<string>();
  if (!path) return pairs;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const names = [
      ...new Set([...line.matchAll(/'[a-z]+:([A-Za-z0-9_.-]+)'/g)].map((m) => m[1]!)),
    ].filter((n) => ids.has(n));
    const parent = line.split(' ')[0];
    if (parent && ids.has(parent)) names.push(parent);
    for (const a of names) for (const b of names) if (a < b) pairs.add(`${a}|${b}`);
  }
  return pairs;
}
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function weights(
  regions: readonly Region[],
  inputs: { seams: Set<string>; votes?: Record<string, string[]>; atlas?: Record<string, string> },
): Map<string, number> {
  const w = new Map<string, number>();
  const parentsOf = (r: Region) =>
    new Set(
      r.concepts
        .map((c) => inputs.atlas?.[c])
        .filter((p): p is string => !!p && p !== 'primitive:shared' && p !== 'shared'),
    );
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]!;
      const b = regions[j]!;
      let value = 0;
      if (inputs.seams.has(pairKey(a.id, b.id))) value += WEIGHTS.seam;
      value += WEIGHTS.docs * jaccard(a.docs, b.docs);
      value += WEIGHTS.clusters * jaccard(a.clusters, b.clusters);
      if (inputs.atlas) {
        const pa = parentsOf(a);
        if ([...parentsOf(b)].some((p) => pa.has(p))) value += WEIGHTS.atlasParent;
      }
      if (inputs.votes) {
        const va = new Set(inputs.votes[a.id] ?? []);
        if ((inputs.votes[b.id] ?? []).some((v) => va.has(v))) value += WEIGHTS.votes;
      }
      if (value > 0) w.set(pairKey(a.id, b.id), Math.round(value * 1000) / 1000);
    }
  return w;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
/** Greedy average linkage: join the two groups with the highest mean pair weight whose union fits the budget. */
function linkage(regions: readonly Region[], w: Map<string, number>, budget: number): string[][] {
  const groups = regions.map((r) => [r.id]);
  const tokens = new Map(regions.map((r) => [r.id, r.tokens]));
  const size = (g: string[]) => g.reduce((n, id) => n + (tokens.get(id) ?? 0), 0);
  const mean = (a: string[], b: string[]) => {
    let total = 0;
    for (const x of a) for (const y of b) total += w.get(pairKey(x, y)) ?? 0;
    return total / (a.length * b.length);
  };
  for (;;) {
    let best: { i: number; j: number; score: number } | undefined;
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        if (size(groups[i]!) + size(groups[j]!) > budget) continue;
        const score = mean(groups[i]!, groups[j]!);
        if (score > 0 && (!best || score > best.score)) best = { i, j, score };
      }
    if (!best) return groups;
    const merged = [...groups[best.i]!, ...groups[best.j]!];
    groups.splice(best.j, 1);
    groups.splice(best.i, 1, merged);
  }
}
/** A seeded shuffle (mulberry32), so a random arm is reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
/** Token-matched groups from a shuffled order: fill until the next region would pass the budget. */
function randomGroups(regions: readonly Region[], budget: number, seed: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const r of shuffled(regions, seed)) {
    if (current.length && size + r.tokens > budget) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(r.id);
    size += r.tokens;
  }
  if (current.length) groups.push(current);
  return groups;
}
/** A member's recognise text with every heading demoted one level (at most six), under its region heading. */
function wrapped(r: Region): string {
  const demoted = r.recognise
    .replace(/^(#{1,5})(\s)/gm, (_m, hashes: string, space: string) => `#${hashes}${space}`)
    .replace(/^#{6,}(\s)/gm, '######$1');
  return `# Region ${r.id}: ${r.title}\n\n${demoted.trim()}\n`;
}

function build() {
  if (!values.regions || !values.budget || !values.out) usage();
  const dir = resolve(values.regions!);
  const regions = readRegions(dir);
  const ids = new Set(regions.map((r) => r.id));
  const budget =
    values.budget === 'all'
      ? Number.POSITIVE_INFINITY
      : values.budget === '1'
        ? 0
        : Number(values.budget);
  if (Number.isNaN(budget) || budget < 0) throw Error('--budget is a token count, "all" or "1"');
  const seed = Number(values.seed ?? 1);
  const votes = values.votes
    ? (JSON.parse(readFileSync(resolve(values.votes), 'utf8')) as Record<string, string[]>)
    : undefined;
  const atlas = values['atlas-parents']
    ? (JSON.parse(readFileSync(resolve(values['atlas-parents']), 'utf8')) as Record<string, string>)
    : undefined;
  const seams = readSeams(values.seams ? resolve(values.seams) : undefined, ids);
  const w = weights(regions, { seams, ...(votes ? { votes } : {}), ...(atlas ? { atlas } : {}) });
  const members =
    budget === 0
      ? regions.map((r) => [r.id])
      : values.random
        ? randomGroups(regions, budget, seed)
        : linkage(regions, w, budget);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const out = privateDir(resolve(values.out!));
  const regionsOut = privateDir(join(out, 'regions'));
  const groups = members.map((ids, index) => {
    const rs = ids.map((id) => byId.get(id)!);
    const id = rs.length === 1 ? rs[0]!.id : `g${String(index + 1).padStart(2, '0')}-${rs[0]!.id}`;
    const knowledge = rs.map(wrapped).join('\n');
    const groupDir = privateDir(join(regionsOut, id));
    writePrivate(join(groupDir, 'knowledge.md'), knowledge);
    writePrivate(
      join(groupDir, 'region.json'),
      JSON.stringify(
        {
          id,
          title:
            rs.length === 1
              ? rs[0]!.title
              : `Group of ${rs.length}: ${rs.map((r) => r.title).join('; ')}`,
          routing: rs
            .map((r) => (rs.length === 1 ? r.routing : `[${r.id}] ${r.routing}`))
            .join('\n'),
          concepts: [...new Set(rs.flatMap((r) => r.concepts))],
          members: rs.map((r) => r.id),
          tokens: tokensOf(knowledge),
          tokenMethod: 'chars/4',
        },
        null,
        1,
      ),
    );
    return {
      id,
      members: rs.map((r) => r.id),
      titles: rs.map((r) => r.title),
      tokens: tokensOf(knowledge),
    };
  });
  const manifest = {
    builtAt: new Date().toISOString(),
    regions: dir,
    regionsHash: regionsHash(regions),
    regionCount: regions.length,
    budget: values.budget,
    random: !!values.random,
    seed: values.random ? seed : null,
    weights: WEIGHTS,
    inputs: {
      seams: values.seams ? resolve(values.seams) : null,
      seamPairs: seams.size,
      votes: values.votes ? resolve(values.votes) : null,
      atlasParents: values['atlas-parents'] ? resolve(values['atlas-parents']) : null,
      pairsWeighted: w.size,
    },
    groups,
    singletons: groups.filter((g) => g.members.length === 1).length,
    largestTokens: Math.max(...groups.map((g) => g.tokens)),
    chorusDir: regionsOut,
  };
  writePrivate(join(out, 'groups.json'), JSON.stringify(manifest, null, 1));
  console.log(
    JSON.stringify(
      {
        groups: groups.length,
        singletons: manifest.singletons,
        largestTokens: manifest.largestTokens,
        regionsHash: manifest.regionsHash,
        chorusDir: regionsOut,
      },
      null,
      1,
    ),
  );
}

// ---------------------------------------------------------------------------
// Expand: group answers back to per-region rows
// ---------------------------------------------------------------------------
const LINE =
  /^\s*(?:in my domain:\s*)?(?:regions?\s+)?`?([A-Za-z0-9][A-Za-z0-9_.,\s-]*?)`?\s*:\s*(.+?)\s*$/i;
/** The ids a line names (one, or several before one colon) and its why. */
function parseLine(line: string): { ids: string[]; why: string } | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  const ids = m[1]!
    .split(/\s*(?:,|\band\b|\/)\s*/i)
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter((s) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(s));
  return ids.length ? { ids, why: m[2]! } : undefined;
}
function expand() {
  if (!values.run || !values.groups || !values.out) usage();
  const run = resolve(values.run!);
  const manifest = JSON.parse(readFileSync(resolve(values.groups!), 'utf8')) as {
    groups: { id: string; members: string[] }[];
  };
  const members = new Map(manifest.groups.map((g) => [g.id, g.members]));
  const answers = readJsonl<WardenProbeAnswer>(join(run, 'answers.jsonl'));
  const turns = readJsonl<WardenProbeTurn>(join(run, 'turns.jsonl'));
  const out = privateDir(resolve(values.out!));
  const parse = {
    groupAnswers: answers.length,
    groupYes: 0,
    lines: 0,
    parseErrorLines: 0,
    unknownIds: 0,
    collapses: 0,
    perRegionRows: 0,
    unknownGroups: 0,
    examples: { parseErrors: [] as string[], unknownIds: [] as string[] },
  };
  const expanded: WardenProbeAnswer[] = [];
  for (const a of answers) {
    const group = members.get(a.domain);
    if (!group) {
      parse.unknownGroups++;
      continue;
    }
    const base = {
      probeId: a.probeId,
      ...(a.trigger ? { trigger: a.trigger } : {}),
      elapsedMs: a.elapsedMs ?? 0,
    };
    const share = (n: number) => {
      // The group's tokens are split evenly over its members, so per-region cost sums to the group's.
      if (!a.tokens) return {};
      const t = a.tokens;
      const part = (x: number | undefined) => (x === undefined ? undefined : Math.round(x / n));
      return {
        tokens: {
          input: part(t.input)!,
          output: part(t.output)!,
          ...(t.cacheRead !== undefined ? { cacheRead: part(t.cacheRead)! } : {}),
          ...(t.cacheWrite !== undefined ? { cacheWrite: part(t.cacheWrite)! } : {}),
          ...(t.thinking !== undefined ? { thinking: part(t.thinking)! } : {}),
        },
      };
    };
    if (a.error) {
      for (const id of group)
        expanded.push({
          ...base,
          domain: id,
          noComment: false,
          error: a.error,
          ...share(group.length),
        });
      continue;
    }
    if (a.noComment || !a.text) {
      for (const id of group)
        expanded.push({ ...base, domain: id, noComment: true, ...share(group.length) });
      continue;
    }
    parse.groupYes++;
    const named = new Map<string, string>();
    for (const line of a.text.split('\n')) {
      if (!line.trim()) continue;
      parse.lines++;
      const parsed = parseLine(line);
      if (!parsed) {
        parse.parseErrorLines++;
        if (parse.examples.parseErrors.length < 10)
          parse.examples.parseErrors.push(line.trim().slice(0, 160));
        continue;
      }
      if (parsed.ids.length > 1) parse.collapses++;
      for (const id of parsed.ids) {
        if (!group.includes(id)) {
          parse.unknownIds++;
          if (parse.examples.unknownIds.length < 10)
            parse.examples.unknownIds.push(`${a.domain}: ${id}`);
          continue;
        }
        named.set(id, named.has(id) ? `${named.get(id)}\n${parsed.why}` : parsed.why);
      }
    }
    for (const id of group)
      expanded.push(
        named.has(id)
          ? { ...base, domain: id, noComment: false, text: named.get(id)!, ...share(group.length) }
          : { ...base, domain: id, noComment: true, ...share(group.length) },
      );
  }
  parse.perRegionRows = expanded.length;
  const groupSize = (domain: string) => members.get(domain)?.length ?? 0;
  const expandedTurns = turns.map((t) => ({
    ...t,
    calls: answers
      .filter(
        (a) =>
          a.probeId === t.probeId &&
          (a.trigger ?? 'agent-action') === (t.trigger ?? 'agent-action'),
      )
      .reduce((n, a) => n + groupSize(a.domain), 0),
  }));
  writePrivate(join(out, 'answers.jsonl'), expanded.map((a) => `${JSON.stringify(a)}\n`).join(''));
  writePrivate(
    join(out, 'turns.jsonl'),
    expandedTurns.map((t) => `${JSON.stringify(t)}\n`).join(''),
  );
  const score = existsSync(join(run, 'score.json'))
    ? (JSON.parse(readFileSync(join(run, 'score.json'), 'utf8')) as Record<string, unknown>)
    : {};
  writePrivate(
    join(out, 'score.json'),
    JSON.stringify(
      {
        ...score,
        roster: [...new Set(expanded.map((a) => a.domain))].sort(),
        expandedFrom: { run, groups: resolve(values.groups!), groupCount: manifest.groups.length },
      },
      null,
      1,
    ),
  );
  if (existsSync(join(run, 'quota.jsonl')))
    writePrivate(join(out, 'quota.jsonl'), readFileSync(join(run, 'quota.jsonl'), 'utf8'));
  writePrivate(join(out, 'parse.json'), JSON.stringify(parse, null, 1));
  console.log(JSON.stringify({ out, ...parse, examples: undefined }, null, 1));
}

if (command === 'build') build();
else if (command === 'expand') expand();
else usage();
console.error(`${command}: ${basename(resolve(values.out ?? '.'))}`);
