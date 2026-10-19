/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:evals
 */
// Measures how a thread's context delivery mode affects Claude's prompt cache.
//
//   bun run scripts/measure-warm-cache.ts [--turns 10] [--model claude-haiku-5-5]
//       [--modes a,b,c] [--cwd <repo>] [--learning-at 5] [--out <file.json>]
//
// Each mode runs one N-turn thread on a real Claude Code session through the subscription, with
// harness instruction loading off (Foundry composes the stack). Per turn it records input,
// cache-read and cache-creation tokens, the request's whole context and latency.
//   a  every layer every turn, as "# System Context" in the user message (the old delivery)
//   b  stable layers once in the session's system prompt; slow and per-turn parts every turn
//   c  every layer once in the system prompt; afterwards only layers whose hash changed, plus the
//      per-turn parts (the delivery ledger)
// A post-hoc learning update lands before turn --learning-at in every mode.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeHash } from '../packages/core/src';
import { RUN_ENV, stampFoundryRun } from '../packages/foundry/src/archives/run-stamp';
import {
  CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  composeRoleView,
} from '../packages/foundry/src/prompts/instruction-stack';
import {
  ClaudeCodeSessionAdapter,
  InMemoryExternalSessionStore,
} from '../packages/foundry/src/providers/session-adapter';
import { formatMessagesForNativeSession } from '../packages/foundry/src/providers/session-backed';
import { cleanEnvironment, livePath } from './vcr/shared';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

// Run in a clean environment: no parent Claude Code session variables or credentials.
if (!process.env.FOUNDRY_MEASURE_CLEAN) {
  const { path } = await livePath();
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: cleanEnvironment({ PATH: path, FOUNDRY_MEASURE_CLEAN: '1', [RUN_ENV]: 'test' }),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(await child.exited);
}

const turns = Number(arg('turns', '10'));
const model = arg('model', 'claude-haiku-5-5');
const modes = arg('modes', 'a,b,c').split(',') as Mode[];
const cwd = resolve(arg('cwd', join(import.meta.dir, '..')));
const learningAt = Number(arg('learning-at', '5'));
const out = arg('out', join(mkdtempSync(join(tmpdir(), 'foundry-warm-cache-')), 'results.json'));
// The measured sessions run in a stamped scratch folder, never the checkout, so Archive drops them.
const sessionCwd = mkdtempSync(join(tmpdir(), 'foundry-warm-cache-session-'));
// Re-executed with ARCHIVE_RUN=test above, so the stamp is a test run's.
stampFoundryRun(sessionCwd);
type Mode = 'a' | 'b' | 'c';

const EXECUTOR_PROMPT =
  'You are the Artificer, the executor for this Foundry thread. Answer the user directly.';
const instructions = (await composeRoleView({ cwd, harness: 'claude', role: 'main' })).slots
  .instructions.text;

/** One thread's layers at a turn: stable instructions, slow learning and thread-state. */
function layers(turn: number): Array<{ id: string; kind: 'stable' | 'slow'; text: string }> {
  const lessons = [
    'Search for the thing already doing a job before writing a new one.',
    'Report what was not verified, plainly.',
    'Hard cuts only: no backwards-compatibility shims.',
  ];
  if (turn >= learningAt)
    lessons.push('Post-hoc review: the last answer padded its summary; keep answers to the point.');
  return [
    { id: 'instructions', kind: 'stable', text: instructions },
    {
      id: 'learning',
      kind: 'slow',
      text: `## Thread knowledge (convention warden)\n${lessons.map((l) => `- ${l}`).join('\n')}`,
    },
    {
      id: 'thread-state',
      kind: 'slow',
      text: `## Thread state\nmessages: ${turn}\ndomain: foundry context delivery\nrecent: turn ${turn - 1} answered`,
    },
  ];
}

/** Per-turn decoration: the Cartographer's routing line and one Warden's advice. */
const decoration = (turn: number) =>
  `Router selected domains: conventions (confidence 0.${(turn % 9) + 1}).\nDomain decisions: conventions: contribute.\n\n## conventions advice\n- Turn ${turn}: prefer the existing ledger over new bookkeeping.`;

const QUESTIONS = [
  'In one sentence: what is a context layer in Foundry?',
  'In one sentence: who is the sole writer of thread-state?',
  'In one sentence: what does the Cartographer do?',
  'In one sentence: what are Wardens?',
  'In one sentence: what does Kingdom do?',
  'In one sentence: what model do decision roles use?',
  'In one sentence: what is a Signet?',
  'In one sentence: where do demos belong?',
  'In one sentence: what is Oracle for?',
  'In one sentence: what does Archive do?',
  'In one sentence: what are the three delivery parts of a thread context?',
  'In one sentence: what does the injection ledger record?',
];

interface TurnRow {
  mode: Mode;
  turn: number;
  promptChars: number;
  delivered: string[];
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  context: number;
  latencyMs: number;
}

async function runMode(mode: Mode): Promise<TurnRow[]> {
  const first = layers(1);
  const baseContext =
    mode === 'a'
      ? undefined
      : [
          EXECUTOR_PROMPT,
          ...first.filter((l) => mode === 'c' || l.kind === 'stable').map((l) => l.text),
        ].join('\n\n');
  const held = new Map(mode === 'c' ? first.map((l) => [l.id, computeHash(l.text)] as const) : []);
  const adapter = new ClaudeCodeSessionAdapter({
    store: new InMemoryExternalSessionStore(),
    defaults: { model, env: { ...CLAUDE_HARNESS_INSTRUCTIONS_OFF }, maxTurns: 1 },
  });
  const session = await adapter.createSession({
    threadId: `measure-warm-cache:${mode}`,
    cwd: sessionCwd,
    model,
    maxTurns: 1,
    ...(baseContext ? { baseContext } : {}),
  });
  await session.start();
  const rows: TurnRow[] = [];
  try {
    for (let turn = 1; turn <= turns; turn++) {
      const current = layers(turn);
      const sent =
        mode === 'a'
          ? current
          : mode === 'b'
            ? current.filter((l) => l.kind === 'slow')
            : current.filter((l) => held.get(l.id) !== computeHash(l.text));
      for (const l of sent) if (mode === 'c') held.set(l.id, computeHash(l.text));
      const system = [
        ...(mode === 'a' ? [EXECUTOR_PROMPT] : []),
        ...sent.map((l) =>
          mode === 'c' ? `# Updated: ${l.id} (replaces the earlier version)\n\n${l.text}` : l.text,
        ),
        decoration(turn),
      ].join('\n\n');
      const prompt = formatMessagesForNativeSession([
        { role: 'system', content: system },
        {
          role: 'user',
          content: `${QUESTIONS[(turn - 1) % QUESTIONS.length]} Do not use any tools.`,
        },
      ]);
      const started = performance.now();
      const result = await session.send(prompt, { timeout: 180_000 });
      const latencyMs = Math.round(performance.now() - started);
      const t = result.tokens ?? { input: 0, output: 0 };
      const row: TurnRow = {
        mode,
        turn,
        promptChars: prompt.length,
        delivered: sent.map((l) => l.id),
        input: t.input,
        cacheRead: t.cacheRead ?? 0,
        cacheWrite: t.cacheWrite ?? 0,
        output: t.output,
        context: t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0),
        latencyMs,
      };
      rows.push(row);
      console.log(
        `${mode} t${String(turn).padStart(2)} prompt ${String(row.promptChars).padStart(6)}ch  in ${String(row.input).padStart(5)}  read ${String(row.cacheRead).padStart(7)}  write ${String(row.cacheWrite).padStart(6)}  ctx ${String(row.context).padStart(7)}  out ${row.output}  ${row.latencyMs}ms  [${row.delivered.join(',')}]`,
      );
    }
  } finally {
    session.kill();
  }
  return rows;
}

console.log(
  `instructions: ${instructions.length} chars from ${cwd}; model ${model}; ${turns} turns; learning update before turn ${learningAt}`,
);
const all: TurnRow[] = [];
for (const mode of modes) all.push(...(await runMode(mode)));

const sum = (rows: TurnRow[], key: keyof TurnRow) =>
  rows.reduce((total, row) => total + (row[key] as number), 0);
console.log(
  '\nmode | input | cache read | cache write | final context | ctx growth/turn | mean latency',
);
for (const mode of modes) {
  const rows = all.filter((r) => r.mode === mode);
  const growth = (rows.at(-1)!.context - rows[0]!.context) / Math.max(1, rows.length - 1);
  console.log(
    `${mode} | ${sum(rows, 'input')} | ${sum(rows, 'cacheRead')} | ${sum(rows, 'cacheWrite')} | ${rows.at(-1)!.context} | ${Math.round(growth)} | ${Math.round(sum(rows, 'latencyMs') / rows.length)}ms`,
  );
}
writeFileSync(out, JSON.stringify({ model, turns, learningAt, cwd, rows: all }, null, 2));
console.log(`\nrows: ${out}`);
