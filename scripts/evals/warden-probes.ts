#!/usr/bin/env bun
/**
 * Build Warden probes from a correction harvest (the deep-scan kit: detector candidates, Haiku
 * classifications and the clustered rules). Writes JSONL outside the repo: probes hold session text.
 *
 *   bun scripts/evals/warden-probes.ts --work <kit>/work --out ~/.foundry/evals/warden-probes.jsonl
 *
 * Positive: a sharp correction (Haiku) of a rule the clusters say was already recorded somewhere,
 * with the agent turn it answered. Negative: an agent turn followed by a message that is not a
 * correction. UserEvidence probes are kept in their own context and never mixed with inixiative.
 */
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scrubSecrets, type WardenProbe } from '../../packages/core/src';
import { privateDirectory } from '../../packages/foundry/src/providers/decision-host';

const { values } = parseArgs({
  options: { work: { type: 'string' }, out: { type: 'string' }, 'min-turn': { type: 'string' } },
});
if (!values.work || !values.out) {
  console.error('usage: warden-probes.ts --work <kit work dir> --out <probes.jsonl>');
  process.exit(2);
}
const work = values.work;
const out = resolve(values.out);
// Probes hold session text: never inside this repository.
if (out.startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) {
  console.error('--out must be outside the repository: probes hold session text');
  process.exit(2);
}
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
privateDirectory(dirname(out));
writeFileSync(out, `${probes.map((p) => JSON.stringify(p)).join('\n')}\n`, { mode: 0o600 });
chmodSync(out, 0o600);
const count = (kind: string, ctx: string) =>
  probes.filter((p) => p.kind === kind && p.ctx === ctx).length;
for (const ctx of ['inixiative', 'personal', 'userevidence'])
  console.log(`${ctx}: ${count('positive', ctx)} positive, ${count('negative', ctx)} negative`);
