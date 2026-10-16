#!/usr/bin/env bun
/**
 * The Warden healthy-size test: how much conceptual ownership one Warden can hold before it stops
 * classifying moments well. One check type at a time (its moments under
 * `<root>/<check>/moments.jsonl`, its target region in `<root>/<check>/check.json`), knowledge grown
 * by concept neighbourhood from the target region to each size, the target region placed at the
 * start, middle or end. Each cell runs through the charter eval (`warden-charter.ts`): the live
 * Warden call path on the subscription, one primed session per cell.
 *
 *   bun scripts/evals/warden-size.ts build --check concurrency [--root ~/.foundry/evals/warden-size]
 *   bun scripts/evals/warden-size.ts run --checks concurrency,errors [--reps 1] [--parallel 3]
 *     [--sizes 5,10,20,40,80] [--positions start,middle,end] [--run <id>] [--max-window 85]
 *     --experiment <design.md>   (run is always wide: scripts/evals/experiment-gate.ts)
 *   bun scripts/evals/warden-size.ts judge [--checks ...]
 *   bun scripts/evals/warden-size.ts report [--checks ...]
 *
 * Knowledge is laid out as a region Warden holds it: (1) what it covers, (2) a description of the
 * domain, (3) every primitive, pattern and rule in it by name, (4) the specific knowledge in full.
 * Units are template docs (`docs/claude/**`, CLAUDE.md, FEATURES.md; a doc stays whole when it is
 * small, else one unit per H2 with its H1 preface), the org CLAUDE.md (one concept per H2), and the
 * template catalog's entries (`.foundry/catalog/catalog.json`, clusters = concepts). Doc units join
 * the concept whose names they mention most; concepts are related by shared mentions and doc links.
 *
 * Fixtures and results stay private under --root: they hold session-like text.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  POINTER_LEVELS,
  parseWardenPointerJudgement,
  WARDEN_POINTER_JUDGE_PROMPT,
  type WardenPointerJudgement,
  type WardenProbe,
  type WardenProbeAnswer,
  wardenPointerJudgeMessage,
  wilsonInterval as wilson,
} from '../../packages/core/src';
import { FileMemory } from '../../packages/core/src/adapters/file-memory';
import { buildRoleLayers } from '../../packages/foundry/src/agents/role-layers';
import { createSourceResolver } from '../../packages/foundry/src/agents/thread-factory';
import { markEvalRun } from '../../packages/foundry/src/feedback/charter-eval';
import {
  claudeUsageWindows,
  decisionHost,
  privateDirectory,
} from '../../packages/foundry/src/providers/decision-host';
import { ConfigStore } from '../../packages/foundry/src/viewer/config';
import { requireExperiment } from './experiment-gate';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    root: { type: 'string' },
    check: { type: 'string' },
    checks: { type: 'string' },
    reps: { type: 'string' },
    parallel: { type: 'string' },
    sizes: { type: 'string' },
    positions: { type: 'string' },
    run: { type: 'string' },
    'max-window': { type: 'string' },
    'split-from': { type: 'string' },
    template: { type: 'string' },
    catalog: { type: 'string' },
    org: { type: 'string' },
    experiment: { type: 'string' },
  },
});

const ROOT = resolve(values.root ?? join(homedir(), '.foundry', 'evals', 'warden-size'));
const REPO = resolve(import.meta.dir, '..', '..');
if (`${ROOT}/`.startsWith(`${REPO}/`)) throw Error('--root must be outside the repository');
const TEMPLATE = resolve(values.template ?? join(homedir(), 'code', 'inixiative', 'template'));
const CATALOG = resolve(
  values.catalog ??
    join(TEMPLATE, '.worktrees', 'feat-warden-catalog', '.foundry', 'catalog', 'catalog.json'),
);
const ORG = resolve(values.org ?? join(homedir(), 'code', 'inixiative', 'CLAUDE.md'));
const ROLE = 'librarian-reuse';
/**
 * Characters per token of this corpus (markdown, code, paths), calibrated on the provider's usage
 * report (a 319k-character cell measured ~131k tokens). Measured tokens are reported per call.
 */
const CHARS_PER_TOKEN = 2.4;
const SIZES = (values.sizes ?? '5,10,20,40,80').split(',').map((s) => Number(s) * 1000);
const POSITIONS = (values.positions ?? 'start,middle,end').split(',') as Position[];
type Position = 'start' | 'middle' | 'end';

const checksArg = (): string[] =>
  (values.checks ?? values.check ?? '')
    .split(',')
    .filter(Boolean)
    .concat(values.checks || values.check ? [] : listChecks());
const listChecks = () =>
  readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'moments.jsonl')));
const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
const writePrivate = (path: string, text: string) => {
  privateDirectory(resolve(path, '..'));
  writeFileSync(path, text, { mode: 0o600 });
};

// ---------------------------------------------------------------------------
// Corpus: units, concepts, graph
// ---------------------------------------------------------------------------

interface Entry {
  readonly name: string;
  readonly kind: string;
  readonly job: string;
  readonly usage: string;
  readonly choose: string;
  readonly wheres: string[];
}
interface Concept {
  readonly id: string;
  readonly title: string;
  readonly covers: string;
  readonly entries: Entry[];
  readonly units: DocUnit[];
}
interface DocUnit {
  readonly id: string;
  readonly file: string;
  readonly text: string;
}
interface CatalogFile {
  clusters: { id: string; title: string; covers: string }[];
  entries: Record<string, CatalogEntry>;
  docs: Record<string, { entries: CatalogEntry[] }>;
}
interface CatalogEntry {
  name: string;
  kind: string;
  where: string;
  job: string;
  usage?: string;
  choose?: string;
  cluster: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** H2 sections outside code fences: [heading, body] with the text before the first H2 as preface. */
function splitH2(text: string): { preface: string; sections: { heading: string; body: string }[] } {
  const lines = text.split('\n');
  let fence = false;
  const preface: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) {
      sections.push({ heading: line.slice(3).trim(), lines: [line] });
      continue;
    }
    (sections.at(-1)?.lines ?? preface).push(line);
  }
  return {
    preface: preface.join('\n').trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() })),
  };
}

/** A doc's units: whole when small, else one per H2 carrying the H1 and its first paragraph. */
function docUnits(path: string, label: string, wholeUnder = 12_000): DocUnit[] {
  const text = readFileSync(path, 'utf8').trim();
  if (text.length <= wholeUnder) return [{ id: label, file: label, text }];
  const { preface, sections } = splitH2(text);
  const h1 = /^# .*$/m.exec(preface)?.[0] ?? `# ${label}`;
  const lead = preface
    .split(/\n\s*\n/)
    .slice(1)
    .find((p) => p.trim() && !p.startsWith('#'))
    ?.trim()
    .slice(0, 400);
  return sections
    .filter((s) => !/^(table of )?contents$/i.test(s.heading))
    .map((s) => ({
      id: `${label}#${slug(s.heading)}`,
      file: label,
      text: [h1, lead, s.body].filter(Boolean).join('\n\n'),
    }));
}

function walkMarkdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walkMarkdown(path) : name.endsWith('.md') ? [path] : [];
  });
}

/** Names that look like code identifiers, so prose words never count as mentions. */
const identifiers = (name: string) =>
  (name.match(/[A-Za-z_$][\w$.]*/g) ?? []).filter(
    (w) =>
      w.length >= 5 &&
      (/[a-z][A-Z]|[._]|^[A-Z][a-z]+[A-Z]|^[A-Z_]{5,}$/.test(w) || /\(/.test(name)),
  );

function buildCorpus(): {
  concepts: Map<string, Concept>;
  edges: Map<string, Map<string, number>>;
} {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogFile;
  const concepts = new Map<string, Concept>();
  for (const c of catalog.clusters)
    concepts.set(c.id, { id: c.id, title: c.title, covers: c.covers, entries: [], units: [] });
  // Entries, deduped per concept by name.
  const all = [
    ...Object.values(catalog.entries),
    ...Object.values(catalog.docs).flatMap((d) => d.entries),
  ];
  const byKey = new Map<string, Entry & { cluster: string }>();
  for (const e of all) {
    if (!concepts.has(e.cluster)) continue;
    const key = `${e.cluster}|${e.name.toLowerCase()}`;
    const found = byKey.get(key);
    if (found) {
      if (!found.wheres.includes(e.where)) found.wheres.push(e.where);
      continue;
    }
    byKey.set(key, {
      cluster: e.cluster,
      name: e.name,
      kind: e.kind,
      job: e.job,
      usage: e.usage ?? '',
      choose: e.choose ?? '',
      wheres: [e.where],
    });
  }
  for (const e of byKey.values()) concepts.get(e.cluster)!.entries.push(e);

  // Which concepts mention a name: its weight is shared among them.
  const nameConcepts = new Map<string, Set<string>>();
  for (const c of concepts.values())
    for (const e of c.entries)
      for (const id of identifiers(e.name)) {
        const set = nameConcepts.get(id) ?? new Set<string>();
        set.add(c.id);
        nameConcepts.set(id, set);
      }
  const scores = (text: string) => {
    const score = new Map<string, number>();
    for (const [name, owners] of nameConcepts) {
      if (!text.includes(name)) continue;
      for (const owner of owners) score.set(owner, (score.get(owner) ?? 0) + 1 / owners.size);
    }
    return score;
  };

  const edges = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number) => {
    if (a === b || w <= 0) return;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = edges.get(x) ?? new Map<string, number>();
      m.set(y, (m.get(y) ?? 0) + w);
      edges.set(x, m);
    }
  };

  // Template docs: each unit joins its strongest concept; a file without any falls back to the
  // concept most of its units joined, else becomes its own concept.
  const docsRoot = join(TEMPLATE, 'docs', 'claude');
  const files = [
    join(TEMPLATE, 'CLAUDE.md'),
    join(TEMPLATE, 'FEATURES.md'),
    ...walkMarkdown(docsRoot),
  ].filter(existsSync);
  const unitConcept = new Map<string, string>();
  const fileUnits = new Map<string, DocUnit[]>();
  for (const path of files) {
    const label = relative(TEMPLATE, path);
    const units = docUnits(path, label);
    fileUnits.set(label, units);
    const placed: [DocUnit, Map<string, number>, string | undefined][] = units.map((u) => {
      const s = scores(u.text);
      const top = [...s].sort((a, b) => b[1] - a[1])[0];
      return [u, s, top && top[1] >= 1 ? top[0] : undefined];
    });
    const votes = new Map<string, number>();
    for (const [, , c] of placed) if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
    const fallback = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const [u, s, c] of placed) {
      let home = c ?? fallback;
      if (!home) {
        home = `doc-${slug(basename(u.file, '.md'))}`;
        if (!concepts.has(home)) {
          const firstLine = u.text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
          concepts.set(home, {
            id: home,
            title: (/^# (.*)$/m.exec(u.text)?.[1] ?? u.file).trim(),
            covers: firstLine.slice(0, 200),
            entries: [],
            units: [],
          });
        }
      }
      concepts.get(home)!.units.push(u);
      unitConcept.set(u.id, home);
      for (const [other, w] of s) link(home, other, Math.min(w, s.get(home) ?? w));
    }
  }
  // Doc links relate the linking unit's concept to the linked doc's concepts.
  for (const units of fileUnits.values())
    for (const u of units) {
      const from = unitConcept.get(u.id)!;
      for (const m of u.text.matchAll(/\]\((?:\.\/)?([A-Z_/]+\.md)/g)) {
        const target = [...fileUnits.keys()].find((f) => f.endsWith(`/${m[1]}`) || f === m[1]);
        const linked = target ? fileUnits.get(target)! : [];
        for (const t of linked) link(from, unitConcept.get(t.id)!, 1 / linked.length);
      }
    }
  // Catalog entries that say where they are written relate their concept to that doc's.
  for (const c of concepts.values())
    for (const e of c.entries)
      for (const where of e.wheres) {
        const file = [...fileUnits.keys()].find((f) => where.includes(basename(f)));
        if (!file) continue;
        const units = fileUnits.get(file)!;
        for (const u of units) link(c.id, unitConcept.get(u.id)!, 0.5 / units.length);
      }

  // The org CLAUDE.md: one guidance concept per H2, related in document order and by mentions.
  if (existsSync(ORG)) {
    const { sections } = splitH2(readFileSync(ORG, 'utf8'));
    let previous: string | undefined;
    for (const s of sections) {
      const id = `org-${slug(s.heading)}`;
      const firstLine = s.body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
      concepts.set(id, {
        id,
        title: `Org guidance: ${s.heading}`,
        covers: firstLine.slice(0, 200),
        entries: [],
        units: [
          { id: `CLAUDE.md (org)#${slug(s.heading)}`, file: 'CLAUDE.md (org)', text: s.body },
        ],
      });
      if (previous) link(previous, id, 0.5);
      for (const [other, w] of scores(s.body)) link(id, other, w);
      previous = id;
    }
  }
  return { concepts, edges };
}

// ---------------------------------------------------------------------------
// Knowledge cells
// ---------------------------------------------------------------------------

const renderEntry = (e: Entry) =>
  [
    `- **${e.name}** (${e.kind}): ${e.job}.`,
    `  Where: ${e.wheres.slice(0, 4).join('; ')}.`,
    e.usage ? `  Usage: \`${e.usage}\`` : '',
    e.choose ? `  Choose: ${e.choose}` : '',
  ]
    .filter(Boolean)
    .join('\n');

/** A concept's specific knowledge in full: its entries, then its doc units. */
const renderSpecific = (c: Concept) =>
  [
    `### ${c.title}`,
    ...c.entries.map(renderEntry),
    ...c.units.map((u) => `#### From ${u.id}\n\n${u.text}`),
  ].join('\n\n');

/** The four-part region layout. */
function renderKnowledge(concepts: readonly Concept[]): string {
  return [
    `# Domain knowledge`,
    `## 1. What this Warden covers`,
    concepts.map((c) => c.title).join('; '),
    `## 2. The domain`,
    concepts.map((c) => `- **${c.title}**: ${c.covers}`).join('\n'),
    `## 3. Everything in it, by name`,
    concepts
      .map(
        (c) =>
          `- **${c.title}**: ${[
            ...c.entries.map((e) => `${e.name} (${e.kind})`),
            ...c.units.map((u) => `${u.id} (doc)`),
          ].join(', ')}`,
      )
      .join('\n'),
    `## 4. Specific knowledge`,
    ...concepts.map(renderSpecific),
  ].join('\n\n');
}

/** A concept cut to fit: entries first, then whole doc units, in order, while under `chars`. */
function trimmed(c: Concept, chars: number): Concept {
  const entries: Entry[] = [];
  const units: DocUnit[] = [];
  let used = c.title.length + c.covers.length + 200;
  for (const e of c.entries) {
    const n = renderEntry(e).length + e.name.length + 20;
    if (used + n > chars) break;
    entries.push(e);
    used += n;
  }
  if (entries.length === c.entries.length)
    for (const u of c.units) {
      const n = u.text.length + u.id.length + 30;
      if (used + n > chars) break;
      units.push(u);
      used += n;
    }
  return { ...c, entries, units };
}

interface CheckConfig {
  /** Concepts whose knowledge the check's targets live in. */
  readonly targetConcepts: string[];
  /** Doc units (ids as built) the targets live in, moved into the target region when they joined another concept. */
  readonly targetUnits?: string[];
}

function build(check: string) {
  const dir = join(ROOT, check);
  rmSync(join(dir, 'knowledge'), { recursive: true, force: true });
  const config = JSON.parse(readFileSync(join(dir, 'check.json'), 'utf8')) as CheckConfig;
  const { concepts, edges } = buildCorpus();
  for (const id of config.targetConcepts)
    if (!concepts.has(id)) throw Error(`${check}: unknown target concept ${id}`);
  // The target region: its concepts, plus any target unit that joined a neighbour.
  const target: Concept[] = config.targetConcepts.map((id) => concepts.get(id)!);
  for (const unitId of config.targetUnits ?? []) {
    const owner = [...concepts.values()].find((c) => c.units.some((u) => u.id === unitId));
    if (!owner) throw Error(`${check}: unknown target unit ${unitId}`);
    if (target.includes(owner)) continue;
    const unit = owner.units.find((u) => u.id === unitId)!;
    owner.units.splice(owner.units.indexOf(unit), 1);
    target[0]!.units.push(unit);
  }
  // Grow by concept neighbourhood: repeatedly add the concept most related to what is held, by
  // affinity (link weight over the geometric mean of both degrees, so large hubs do not win on
  // size), the target region counting double.
  const held = new Set(target.map((c) => c.id));
  const targetIds = new Set(held);
  const order: Concept[] = [];
  const degree = (id: string) => [...(edges.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const affinity = (a: string, b: string) =>
    (edges.get(a)?.get(b) ?? 0) / Math.sqrt(Math.max(1e-9, degree(a) * degree(b)));
  while (held.size < concepts.size) {
    let best: string | undefined;
    let bestW = -1;
    for (const c of concepts.values()) {
      if (held.has(c.id) || (!c.entries.length && !c.units.length)) continue;
      const w = [...held].reduce(
        (sum, h) => sum + affinity(h, c.id) * (targetIds.has(h) ? 1 : 0.5),
        0,
      );
      if (w > bestW || (w === bestW && best && degree(c.id) > degree(best))) {
        best = c.id;
        bestW = w;
      }
    }
    if (!best) break;
    held.add(best);
    order.push(concepts.get(best)!);
  }
  const targetChars = renderKnowledge(target).length;
  const corpusChars = renderKnowledge([...target, ...order]).length;
  const instructions = regionInstructions();
  const cells: Record<string, unknown>[] = [];
  // Sizes the target region alone already exceeds collapse into one point, the region alone,
  // labelled by the largest size it stands for (a size within 10% of the next is that point).
  const budgetOf = (size: number) => Math.max(size * CHARS_PER_TOKEN, targetChars);
  const sizes = SIZES.filter(
    (size, i) => SIZES[i + 1] === undefined || budgetOf(SIZES[i + 1]!) > 1.1 * budgetOf(size),
  );
  for (const size of sizes) {
    const budget = Math.max(size * CHARS_PER_TOKEN, targetChars);
    // The neighbours that fit beside the target, the last one cut to fit.
    const neighbours: Concept[] = [];
    for (const c of order) {
      const now = renderKnowledge([...target, ...neighbours]).length;
      if (now >= budget) break;
      const whole = renderKnowledge([...target, ...neighbours, c]).length;
      if (whole <= budget) neighbours.push(c);
      else {
        const cut = trimmed(c, budget - now);
        if (cut.entries.length || cut.units.length) neighbours.push(cut);
        break;
      }
    }
    for (const position of POSITIONS) {
      const half = Math.ceil(neighbours.length / 2);
      const arranged =
        position === 'start'
          ? [...target, ...neighbours]
          : position === 'end'
            ? [...neighbours, ...target]
            : [...neighbours.slice(0, half), ...target, ...neighbours.slice(half)];
      const knowledge = renderKnowledge(arranged);
      const cell = `${size / 1000}k-${position}`;
      writePrivate(join(dir, 'knowledge', cell, ROLE, 'domainKnowledge.md'), knowledge);
      writePrivate(join(dir, 'knowledge', cell, ROLE, 'instructions.md'), instructions);
      cells.push({
        cell,
        size,
        position,
        chars: knowledge.length,
        nominalTokens: Math.round(knowledge.length / CHARS_PER_TOKEN),
        concepts: arranged.map((c) => c.id),
      });
    }
  }
  const manifest = {
    check,
    builtAt: new Date().toISOString(),
    catalog: CATALOG,
    template: TEMPLATE,
    org: ORG,
    target: target.map((c) => c.id),
    targetChars,
    corpus: { concepts: concepts.size, chars: corpusChars },
    neighbourhood: order.slice(0, 40).map((c) => c.id),
    cells,
  };
  writePrivate(join(dir, 'knowledge', 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(
    JSON.stringify(
      {
        check,
        target: manifest.target,
        targetTokens: Math.round(targetChars / CHARS_PER_TOKEN),
        corpusTokens: Math.round(corpusChars / CHARS_PER_TOKEN),
        cells: cells.map((c) => `${c.cell}:${c.nominalTokens}`),
        neighbourhood: manifest.neighbourhood.slice(0, 12),
      },
      null,
      1,
    ),
  );
}

/**
 * A region Warden's instructions: one generic line (the region is named at the top of its
 * knowledge), then the ladder's composed guidance as the live Reuse Warden carries it.
 */
let instructionsCache: string | undefined;
function regionInstructions(): string {
  if (instructionsCache) return instructionsCache;
  const text = readFileSync(join(ROOT, 'instructions.md'), 'utf8');
  instructionsCache = text;
  return text;
}

async function composeInstructions() {
  const foundryDir = join(homedir(), 'code', 'inixiative', 'foundry', '.foundry');
  const config = await new ConfigStore(foundryDir).load();
  const resolveSource = createSourceResolver({
    memory: new FileMemory(join(foundryDir, 'memory')),
  });
  const project = Object.entries(config.projects ?? {}).find(
    ([, p]) => basename(p.path ?? '') === 'template',
  );
  if (!project) throw Error('template is not a registered project');
  const slots = buildRoleLayers(config, ROLE, {
    resolveSource,
    scope: { projectId: project[0], cwd: project[1].path! },
  });
  await slots.instructions.warm();
  // The composed slot is the role's own prompt, then the ladder's files; keep the ladder.
  const composed = slots.instructions.content;
  const ladder = composed.slice(composed.indexOf('\n\n') + 2);
  const text = [
    'You are a region Warden. Your region is named and described at the top of your domain knowledge; everything you hold is listed there by name. Classify each moment as the charter says: relevant or NO_COMMENT, and when relevant, one pointer to the thing that applies and where it is written.',
    ladder,
  ].join('\n\n');
  writePrivate(join(ROOT, 'instructions.md'), text);
  return text;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface CellMeta {
  check: string;
  cell: string;
  rep: number;
  startedAt: string;
  endedAt?: string;
  exit?: number;
  uptimeBefore: string;
  uptimeAfter?: string;
  windowBefore?: Record<string, number>;
  windowAfter?: Record<string, number>;
}

const uptime = () => Bun.spawnSync(['uptime']).stdout.toString().trim();
const windowPercent = () => claudeUsageWindows(ROOT);

async function run() {
  const checks = checksArg();
  const reps = Number(values.reps ?? 1);
  const parallel = Number(values.parallel ?? 3);
  const maxWindow = Number(values['max-window'] ?? 85);
  // From this size up, each position asks a disjoint third of the moments (stratified by kind), so
  // a size still sees every moment once at a third of the quota.
  const splitFrom = Number(values['split-from'] ?? Number.POSITIVE_INFINITY) * 1000;
  const runId = values.run ?? new Date().toISOString().replace(/[:.]/g, '-');
  const jobs: { check: string; cell: string; rep: number }[] = [];
  // The cells each check's build wrote, smallest first, so a partial run covers the small sizes.
  const built = new Map(
    checks.map((check) => {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, check, 'knowledge', 'manifest.json'), 'utf8'),
      ) as { cells: { cell: string; size: number; position: Position }[] };
      return [
        check,
        manifest.cells.filter((c) => SIZES.includes(c.size) && POSITIONS.includes(c.position)),
      ] as const;
    }),
  );
  for (let rep = 1; rep <= reps; rep++)
    for (const size of SIZES)
      for (const position of POSITIONS)
        for (const check of checks)
          if (built.get(check)!.some((c) => c.size === size && c.position === position))
            jobs.push({ check, cell: `${size / 1000}k-${position}`, rep });
  const charter = join(ROOT, 'charter-classify.md');
  console.error(`run ${runId}: ${jobs.length} cells, ${parallel} at once`);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const out = join(ROOT, job.check, 'runs', runId, `${job.cell}-r${job.rep}`);
      if (existsSync(join(out, 'score.json'))) continue;
      // Share the account: wait out the five-hour window when it is nearly spent.
      for (;;) {
        const w = await windowPercent();
        if (!w || (w.five_hour ?? 0) < maxWindow) break;
        console.error(`five-hour window at ${w.five_hour}%: waiting 10 min`);
        await Bun.sleep(600_000);
      }
      privateDirectory(out);
      const size = Number(job.cell.split('k-')[0]) * 1000;
      const position = job.cell.split('k-')[1] as Position;
      let probes = join(ROOT, job.check, 'moments.jsonl');
      if (size >= splitFrom) {
        probes = join(out, 'moments.jsonl');
        writePrivate(
          probes,
          thirdOf(readJsonl<Moment>(join(ROOT, job.check, 'moments.jsonl')), position),
        );
      }
      const meta: CellMeta = {
        ...job,
        startedAt: new Date().toISOString(),
        uptimeBefore: uptime(),
        ...(await windowPercent().then((w) => (w ? { windowBefore: w } : {}))),
      };
      const proc = Bun.spawn(
        [
          'bun',
          join(REPO, 'scripts', 'evals', 'warden-charter.ts'),
          '--probes',
          probes,
          '--projects',
          'template,kingdom',
          '--per-kind',
          '500',
          '--knowledge',
          join(ROOT, job.check, 'knowledge', job.cell),
          '--roles',
          ROLE,
          '--session',
          `size-${job.check}-${job.cell}-r${job.rep}-${runId}`,
          '--budget',
          '4000000',
          '--input-cap',
          '4000000',
          '--charter',
          charter,
          '--no-judge',
          '--concurrency',
          '1',
          '--out',
          out,
          '--resume',
          ...(values.experiment ? ['--experiment', values.experiment] : []),
        ],
        { cwd: REPO, stdout: 'ignore', stderr: Bun.file(join(out, 'stderr.log')) },
      );
      const exit = await proc.exited;
      Object.assign(meta, {
        endedAt: new Date().toISOString(),
        exit,
        uptimeAfter: uptime(),
        ...(await windowPercent().then((w) => (w ? { windowAfter: w } : {}))),
      });
      writePrivate(join(out, 'meta.json'), JSON.stringify(meta, null, 1));
      // The standard report for the cell (docs/EVAL-REPORTING.md): offline, from its answers; no labels,
      // so the one Warden under test is every targeted moment's needed region.
      if (exit === 0)
        await Bun.spawn(
          [
            'bun',
            join(REPO, 'scripts', 'evals', 'warden-charter-report.ts'),
            '--run',
            out,
            '--probes',
            probes,
          ],
          { cwd: REPO, stdout: 'ignore', stderr: Bun.file(join(out, 'report.err')) },
        ).exited;
      console.error(
        `${job.check} ${job.cell} r${job.rep}: exit ${exit} (${meta.startedAt} → ${meta.endedAt})`,
      );
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

// ---------------------------------------------------------------------------
// Judge (pointers) and report
// ---------------------------------------------------------------------------

type Moment = WardenProbe & {
  domain?: 'in' | 'out';
  confuser?: string;
  thread?: string;
};
/** One position's third of the moments: each kind in a stable hashed order, every third one. */
function thirdOf(moments: readonly Moment[], position: Position): string {
  const part = POSITION_PARTS[position];
  const order = (m: Moment) => createHash('sha256').update(m.id).digest('hex');
  return (['positive', 'negative'] as const)
    .flatMap((kind) =>
      moments
        .filter((m) => m.kind === kind)
        .sort((a, b) => order(a).localeCompare(order(b)))
        .filter((_, i) => i % 3 === part),
    )
    .map((m) => `${JSON.stringify(m)}\n`)
    .join('');
}
const POSITION_PARTS: Record<Position, number> = { start: 0, middle: 1, end: 2 };

const pointerKey = (probeId: string, text: string) =>
  createHash('sha256').update(`${probeId}\0${text}`).digest('hex').slice(0, 24);

interface CellAnswer {
  check: string;
  run: string;
  cell: string;
  size: number;
  position: Position;
  rep: number;
  /** Order within the cell: the first call primes the session (cold), the rest fork it (warm). */
  index: number;
  answer: WardenProbeAnswer;
}
function collect(check: string): CellAnswer[] {
  const runs = join(ROOT, check, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs).flatMap((run) =>
    readdirSync(join(runs, run)).flatMap((cellRep) => {
      const m = /^(\d+)k-(start|middle|end)-r(\d+)$/.exec(cellRep);
      if (!m) return [];
      return readJsonl<WardenProbeAnswer>(join(runs, run, cellRep, 'answers.jsonl')).map(
        (answer, index) => ({
          check,
          index,
          run,
          cell: `${m[1]}k-${m[2]}`,
          size: Number(m[1]) * 1000,
          position: m[2] as Position,
          rep: Number(m[3]),
          answer,
        }),
      );
    }),
  );
}

async function judgeAll() {
  const cacheFile = join(ROOT, 'pointer-ladder.jsonl');
  const cache = new Map(
    readJsonl<{ key: string; judged: WardenPointerJudgement }>(cacheFile).map((r) => [
      r.key,
      r.judged,
    ]),
  );
  const pending: { key: string; moment: Moment; text: string }[] = [];
  for (const check of checksArg()) {
    const moments = new Map(
      readJsonl<Moment>(join(ROOT, check, 'moments.jsonl')).map((m) => [m.id, m]),
    );
    for (const { answer } of collect(check)) {
      const moment = moments.get(answer.probeId);
      if (!moment?.gold?.target || answer.noComment || answer.error || !answer.text) continue;
      const key = pointerKey(answer.probeId, answer.text);
      if (!cache.has(key) && !pending.some((p) => p.key === key))
        pending.push({ key, moment, text: answer.text });
    }
  }
  console.error(`judging ${pending.length} pointers`);
  if (!pending.length) return;
  const state = privateDirectory(join(homedir(), '.foundry', 'evals'));
  markEvalRun(state);
  const judges = decisionHost('claude-opus-5-5', 'claude', 3, state);
  try {
    let next = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < pending.length) {
          const item = pending[next++]!;
          let judged: WardenPointerJudgement | undefined;
          for (let attempt = 0; attempt < 3 && !judged; attempt++) {
            try {
              const result = await judges.provider.complete(
                [
                  { role: 'system', content: WARDEN_POINTER_JUDGE_PROMPT },
                  {
                    role: 'user',
                    content: wardenPointerJudgeMessage({
                      moment: item.moment.moment,
                      target: item.moment.gold!.target!,
                      pointer: item.text,
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
          cache.set(item.key, judged);
          appendFileSync(cacheFile, `${JSON.stringify({ key: item.key, judged })}\n`, {
            mode: 0o600,
          });
        }
      }),
    );
  } finally {
    await judges.shutdown();
  }
}

const pct = (sorted: readonly number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
    : null;
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

function report() {
  const judged = new Map(
    readJsonl<{ key: string; judged: WardenPointerJudgement }>(
      join(ROOT, 'pointer-ladder.jsonl'),
    ).map((r) => [r.key, r.judged]),
  );
  const out: Record<string, unknown> = {};
  // The five-hour window's growth over the whole run (a reset counts from zero), per input token
  // of every Warden call in the run. Other sessions on the account inflate it.
  const allMetas = listChecks().flatMap((check) =>
    existsSync(join(ROOT, check, 'runs'))
      ? readdirSync(join(ROOT, check, 'runs')).flatMap((run) =>
          readdirSync(join(ROOT, check, 'runs', run))
            .map((c) => join(ROOT, check, 'runs', run, c, 'meta.json'))
            .filter(existsSync)
            .map((p) => JSON.parse(readFileSync(p, 'utf8')) as CellMeta),
        )
      : [],
  );
  const observations = allMetas
    .flatMap((m) => [
      ...(m.windowBefore
        ? [[Date.parse(m.startedAt), m.windowBefore.five_hour ?? 0] as const]
        : []),
      ...(m.windowAfter && m.endedAt
        ? [[Date.parse(m.endedAt), m.windowAfter.five_hour ?? 0] as const]
        : []),
    ])
    .sort((a, b) => a[0] - b[0]);
  let windowGrowth = 0;
  for (let i = 1; i < observations.length; i++) {
    const [, before] = observations[i - 1]!;
    const [, after] = observations[i]!;
    windowGrowth += after >= before ? after - before : after;
  }
  const runTokens = listChecks()
    .flatMap((check) => collect(check))
    .reduce(
      (n, r) =>
        n +
        (r.answer.tokens
          ? r.answer.tokens.input +
            (r.answer.tokens.cacheRead ?? 0) +
            (r.answer.tokens.cacheWrite ?? 0)
          : 0),
      0,
    );
  const percentPerToken = runTokens ? windowGrowth / runTokens : 0;
  out.quota = { windowGrowth, runTokens, percentPerMillionTokens: percentPerToken * 1e6 };
  for (const check of checksArg()) {
    const moments = new Map(
      readJsonl<Moment>(join(ROOT, check, 'moments.jsonl')).map((m) => [m.id, m]),
    );
    const rows = collect(check);
    const manifest = existsSync(join(ROOT, check, 'knowledge', 'manifest.json'))
      ? (JSON.parse(readFileSync(join(ROOT, check, 'knowledge', 'manifest.json'), 'utf8')) as {
          cells: { cell: string; nominalTokens: number }[];
        })
      : undefined;
    const group = (pick: (r: CellAnswer) => boolean) => {
      const mine = rows.filter(pick);
      const pos = mine.filter((r) => moments.get(r.answer.probeId)?.kind === 'positive');
      const neg = mine.filter((r) => moments.get(r.answer.probeId)?.kind === 'negative');
      const ok = (r: CellAnswer) => !r.answer.error;
      const yes = (r: CellAnswer) => ok(r) && !r.answer.noComment;
      const pointer = (r: CellAnswer) =>
        r.answer.text ? judged.get(pointerKey(r.answer.probeId, r.answer.text)) : undefined;
      // Every call counts: a broken or lost answer injects nothing live, so on a positive it is a
      // miss and on a negative it is no false yes. Broken answers are also counted on their own.
      const posOk = pos;
      const negOk = neg;
      const negIn = negOk.filter((r) => moments.get(r.answer.probeId)?.domain === 'in');
      const negOut = negOk.filter((r) => moments.get(r.answer.probeId)?.domain !== 'in');
      const conf = posOk.filter((r) => moments.get(r.answer.probeId)?.confuser);
      // A pointer leads when it reaches the target at any rung of the ladder: exact, among a few
      // candidates, or the right class.
      const level = (r: CellAnswer) => pointer(r)?.level;
      const reaches = (r: CellAnswer) => yes(r) && !!level(r) && level(r) !== 'wrong';
      const leads = posOk.filter(reaches).length;
      const ladder = Object.fromEntries(
        POINTER_LEVELS.map((l) => [
          l,
          rate(posOk.filter((r) => yes(r) && level(r) === l).length, posOk.length),
        ]),
      );
      const calls = mine.map((r) => r.answer);
      const warm = mine.filter((r) => r.index > 0 && !r.answer.error).map((r) => r.answer);
      const cold = mine.filter((r) => r.index === 0 && !r.answer.error).map((r) => r.answer);
      const ms = (xs: WardenProbeAnswer[]) => xs.map((a) => a.elapsedMs ?? 0).sort((a, b) => a - b);
      const inTokens = calls
        .filter((a) => a.tokens)
        .map(
          (a) => (a.tokens!.input ?? 0) + (a.tokens!.cacheRead ?? 0) + (a.tokens!.cacheWrite ?? 0),
        )
        .sort((a, b) => a - b);
      const errors = calls.filter((a) => a.error);
      const retried = calls.flatMap((a) => a.retried ?? []);
      return {
        positives: posOk.length,
        negatives: negOk.length,
        recall: rate(posOk.filter(yes).length, posOk.length),
        recallCI: wilson(posOk.filter(yes).length, posOk.length),
        leads: rate(leads, posOk.length),
        leadsCI: wilson(leads, posOk.length),
        leadsWhenYes: rate(leads, posOk.filter(yes).length),
        /** Share of positives at each rung: exact, candidates, class, wrong (silences and unjudged make up the rest). */
        ladder,
        unjudgedPointers: posOk.filter((r) => yes(r) && !pointer(r)).length,
        falseYes: rate(negOk.filter(yes).length, negOk.length),
        falseYesCI: wilson(negOk.filter(yes).length, negOk.length),
        falseYesIn: rate(negIn.filter(yes).length, negIn.length),
        falseYesOut: rate(negOut.filter(yes).length, negOut.length),
        confusers: conf.length,
        /** Sibling confusers whose pointer went wrong (most often to the tempting sibling). */
        confusion: rate(conf.filter((r) => yes(r) && level(r) === 'wrong').length, conf.length),
        confuserExact: rate(conf.filter((r) => yes(r) && level(r) === 'exact').length, conf.length),
        confuserLeads: rate(conf.filter(reaches).length, conf.length),
        calls: calls.length,
        errors: errors.length,
        protocolErrors: errors.filter((a) =>
          /neither NO_COMMENT|protocol|malformed/i.test(a.error!),
        ).length,
        timeouts: errors.filter((a) => /timed? ?out|deadline/i.test(a.error!)).length,
        capRefusals: errors.filter((a) => /input cap|budget/i.test(a.error!)).length,
        retriedTimeouts: retried.filter((e) => /timed? ?out|deadline/i.test(e)).length,
        warmP50: pct(ms(warm), 50),
        warmP95: pct(ms(warm), 95),
        warmCalls: warm.length,
        coldP50: pct(ms(cold), 50),
        coldP95: pct(ms(cold), 95),
        coldCalls: cold.length,
        inputTokensP50: pct(inTokens, 50),
      };
    };
    const quota = (size: number) => {
      const metas = readdirSync(join(ROOT, check, 'runs'))
        .flatMap((run) =>
          readdirSync(join(ROOT, check, 'runs', run))
            .filter((c) => c.startsWith(`${size / 1000}k-`))
            .map((c) => join(ROOT, check, 'runs', run, c, 'meta.json')),
        )
        .filter(existsSync)
        .map((p) => JSON.parse(readFileSync(p, 'utf8')) as CellMeta);
      return {
        cells: metas.length,
        load: metas.map((m) => m.uptimeBefore.replace(/.*load averages?: /, '')),
      };
    };
    const tokensOf = (a: WardenProbeAnswer) =>
      a.tokens ? a.tokens.input + (a.tokens.cacheRead ?? 0) + (a.tokens.cacheWrite ?? 0) : 0;
    const sizes = [...new Set(rows.map((r) => r.size))].sort((a, b) => a - b);
    const bySize = sizes.map((size) => {
      const pooled = group((r) => r.size === size);
      const q = existsSync(join(ROOT, check, 'runs')) ? quota(size) : undefined;
      return {
        size,
        measuredTokens: pooled.inputTokensP50,
        nominalTokens: manifest?.cells.find((c) => c.cell === `${size / 1000}k-start`)
          ?.nominalTokens,
        ...pooled,
        quota: q && {
          ...q,
          // Cells of all sizes run at once, so the window's growth is shared out by input tokens.
          percentPerCall: percentPerToken
            ? Math.round(
                percentPerToken *
                  (rows.filter((r) => r.size === size).reduce((n, r) => n + tokensOf(r.answer), 0) /
                    Math.max(1, pooled.calls)) *
                  1e5,
              ) / 1e5
            : null,
        },
        byPosition: Object.fromEntries(
          POSITIONS.map((p) => [p, group((r) => r.size === size && r.position === p)]),
        ),
      };
    });
    // The pre-registered reading (PREREGISTRATION.md).
    const base = bySize[0];
    const verdicts = bySize.map((s) => {
      const accurate =
        !!base &&
        (s.recall ?? 0) >= (base.recall ?? 0) - 0.1 &&
        (s.leads ?? 0) >= (base.leads ?? 0) - 0.1 &&
        (s.falseYes ?? 1) <= (base.falseYes ?? 0) + 0.1 &&
        Object.values(s.byPosition).every((p) => (p.leads ?? 0) >= (base.leads ?? 0) - 0.2);
      const fast =
        (s.warmP95 ?? Infinity) <= 7_500 &&
        (s.coldP95 ?? 0) <= 30_000 &&
        s.timeouts + s.retriedTimeouts <= 0.02 * s.calls;
      const affordable =
        s.capRefusals === 0 &&
        (s.quota?.percentPerCall == null || s.quota.percentPerCall <= 0.0167);
      // Amendment 2026-10-15: a pointer that still leads but no longer names the exact unit is a
      // precision loss, reported beside the verdict.
      const exactDrop = !!base && (s.ladder.exact ?? 0) < (base.ladder.exact ?? 0) - 0.15;
      return { size: s.size, accurate, fast, affordable, exactDrop };
    });
    const baselineFails =
      !!base && ((base.recall ?? 0) < 0.8 || (base.leads ?? 0) < 0.6 || (base.falseYes ?? 1) > 0.2);
    let h: number | null = null;
    for (const v of verdicts) {
      if (v.accurate && v.fast && v.affordable) h = v.size;
      else break;
    }
    out[check] = { baselineFails, H: h, verdicts, bySize };
  }
  writePrivate(join(ROOT, 'report.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

switch (command) {
  case 'instructions':
    console.log((await composeInstructions()).slice(0, 400));
    break;
  case 'build':
    if (!existsSync(join(ROOT, 'instructions.md'))) await composeInstructions();
    for (const check of checksArg()) build(check);
    break;
  case 'run':
    requireExperiment(values.experiment, true);
    await run();
    break;
  case 'judge':
    await judgeAll();
    break;
  case 'report':
    report();
    break;
  default:
    console.error('usage: warden-size.ts instructions | build | run | judge | report (see header)');
    process.exit(2);
}
