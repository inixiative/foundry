#!/usr/bin/env bun
/**
 * Score a Warden charter wording against real-session probes (scripts/evals/warden-probes.ts).
 *
 *   bun scripts/evals/warden-charter.ts --probes ~/.foundry/evals/warden-probes.jsonl \
 *     --settings <roster settings.json> --knowledge <role knowledge dir> [--charter <file>] \
 *     [--per-kind 40] [--ctx inixiative] [--out <dir>]
 *
 * Each probe runs as one turn: every Warden is asked at once on Haiku over the subscription, as live,
 * with --concurrency decisions in flight (the decision queue's size); remarks are judged by Opus.
 * Prints silence precision, speak precision, scope violations, recall, and per-turn calls and
 * latency at roster scale; writes every answer under --out.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computeHash, scoreCharterRun, type WardenProbe } from '../../packages/core/src';
import {
  WARDEN_CHARTER,
  WARDEN_CHARTER_VERSION,
} from '../../packages/foundry/src/agents/warden-charter';
import {
  type EvalWarden,
  markEvalRun,
  runCharterEval,
} from '../../packages/foundry/src/feedback/charter-eval';
import { decisionHost, privateDirectory } from '../../packages/foundry/src/providers/decision-host';

const { values } = parseArgs({
  options: {
    probes: { type: 'string' },
    settings: { type: 'string' },
    knowledge: { type: 'string' },
    charter: { type: 'string' },
    'per-kind': { type: 'string' },
    ctx: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string' },
  },
});
if (!values.probes || !values.settings || !values.knowledge) {
  console.error(
    'usage: warden-charter.ts --probes <jsonl> --settings <settings.json> --knowledge <dir>',
  );
  process.exit(2);
}
const ctx = values.ctx ?? 'inixiative';
const perKind = Number(values['per-kind'] ?? 40);
const charter = values.charter ? readFileSync(values.charter, 'utf8').trim() : WARDEN_CHARTER;
const label = values.charter
  ? `charter-${computeHash(charter).slice(0, 12)}`
  : WARDEN_CHARTER_VERSION;
const out = values.out ?? join(homedir(), '.foundry', 'evals', `charter-${label}-${Date.now()}`);
if (resolve(out).startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) {
  console.error('--out must be outside the repository: answers hold session text');
  process.exit(2);
}
privateDirectory(out);

/** A stable sample: the same probes for every charter, so runs compare. */
const rank = (id: string) => Number(BigInt(Bun.hash(id)) % 1_000_000n);
const all = readFileSync(values.probes, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as WardenProbe);
const pick = (kind: string) =>
  all
    .filter(
      (p) => p.kind === kind && (p.ctx === ctx || (ctx === 'inixiative' && p.ctx === 'personal')),
    )
    .sort((a, b) => rank(a.id) - rank(b.id))
    .slice(0, perKind);
const probes = [...pick('positive'), ...pick('negative')];

// The roster's Wardens, composed from the role files of the probe's ladder.
const settings = JSON.parse(readFileSync(values.settings, 'utf8'));
const roster = Object.entries(
  settings.agents as Record<
    string,
    { flowRole?: string; enabled?: boolean; domain?: string; prompt?: string }
  >,
).filter(([, a]) => a.flowRole === 'domain-advising' && a.enabled && a.domain && a.prompt);
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const ladder = (probe: WardenProbe) =>
  probe.ctx === 'userevidence'
    ? ['org-userevidence', 'project-zealot']
    : ['personal', 'org-inixiative', ...(probe.project ? [`project-${probe.project}`] : [])];
const cache = new Map<string, EvalWarden[]>();
const wardensFor = (probe: WardenProbe): EvalWarden[] => {
  const nodes = ladder(probe);
  const key = nodes.join('|');
  if (!cache.has(key))
    cache.set(
      key,
      roster
        .map(([id, agent]) => ({
          domain: agent.domain!,
          instructions: [
            agent.prompt!,
            ...nodes.map((n) => read(join(values.knowledge!, n, id, 'instructions.md'))),
          ]
            .filter(Boolean)
            .join('\n\n'),
          domainKnowledge: nodes
            .map((n) => read(join(values.knowledge!, n, id, 'domainKnowledge.md')))
            .filter(Boolean)
            .join('\n\n'),
        }))
        .filter((w) => w.domainKnowledge.trim()),
    );
  return cache.get(key)!;
};

const concurrency = Number(values.concurrency ?? 16);
// An eval run, not work: Archive and the repeat report leave its sessions out.
const state = privateDirectory(join(homedir(), '.foundry', 'evals'));
markEvalRun(state);
const wardens = decisionHost(
  'claude-haiku-5-5',
  'claude',
  concurrency,
  join(homedir(), '.foundry', 'evals'),
);
const judges = decisionHost('claude-opus-5-5', 'claude', 4, state);
const started = Date.now();
let done = 0;
try {
  const { answers, turns } = await runCharterEval({
    probes,
    wardensFor,
    warden: wardens.provider,
    judge: judges.provider,
    charter,
    concurrency,
    onAnswer: () => {
      if (++done % 50 === 0)
        console.error(`  ${done} answers (${Math.round((Date.now() - started) / 1000)}s)`);
    },
  });
  const score = scoreCharterRun(probes, answers, turns);
  writeFileSync(
    join(out, 'answers.jsonl'),
    `${answers.map((a) => JSON.stringify(a)).join('\n')}\n`,
    { mode: 0o600 },
  );
  chmodSync(join(out, 'answers.jsonl'), 0o600);

  writeFileSync(
    join(out, 'score.json'),
    JSON.stringify(
      { charter: label, ctx, perKind, score, elapsedMs: Date.now() - started },
      null,
      1,
    ),
  );
  console.log(JSON.stringify({ charter: label, ...score }, null, 1));
  console.log(`answers: ${out}`);
} finally {
  await wardens.shutdown();
  await judges.shutdown();
}
