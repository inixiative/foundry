// Live pre-message latency on the machine's own logins, through a Foundry
// instance on a spare VIEWER_PORT (never the daemon's 4400).
//
//   bun scripts/measure-decisions.ts [--foundry <checkout>] [--port 4471] [--runs 10] [--experts 6] [--gap-ms 30000]
//
// --gap-ms spaces messages like real turns (the worker's own run separates them);
// back-to-back messages measure a request burst the provider may throttle.
//
// Builds a throwaway project with N domain experts, sends a warm-up message and
// then --runs messages to the main thread, and reads the timings Foundry already
// journals: the turn accepted (session_turns.started_at) and the sealed plan
// written immediately before the worker starts (session_phase.stored_at). Prints
// timings, token counts and model names only. If another Foundry holds the Claude
// worker lock, the worker launch is refused after the seal; the pre-message
// timing is unaffected.

import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const foundry = resolve(arg('foundry', join(import.meta.dir, '..')));
const port = Number(arg('port', '4471')),
  runs = Number(arg('runs', '10')),
  expertCount = Number(arg('experts', '6')),
  gapMs = Number(arg('gap-ms', '30000'));
if (port === 4400) throw Error('4400 belongs to the daemon; choose a spare port');
const DOMAINS = ['api', 'db', 'ui', 'auth', 'security', 'testing', 'performance', 'docs'].slice(
  0,
  expertCount,
);
const project = mkdtempSync(join(tmpdir(), 'foundry-measure-'));
mkdirSync(join(project, 'docs')); // the starter conventions source reads <project>/docs
writeFileSync(
  join(project, 'docs', 'README.md'),
  '# Measurement project\n\nA throwaway project for decision latency measurement.\n',
);

async function start(label: string) {
  const { DATABASE_URL: _database, REDIS_URL: _redis, ...inherited } = process.env;
  const env = { ...inherited, VIEWER_PORT: String(port), FOUNDRY_STARTUP_SELF_TEST: '0' };
  const child = Bun.spawn(['bun', join(foundry, 'packages/foundry/src/start.ts')], {
    cwd: project,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  void read(child.stdout);
  void read(child.stderr);
  for (let i = 0; !/Foundry Viewer running at/.test(output); i++) {
    if (child.exitCode !== null || i > 600)
      throw Error(`${label}: Foundry did not start:\n${output.slice(-2000)}`);
    await Bun.sleep(50);
  }
  return {
    child,
    get output() {
      return output;
    },
    async stop() {
      child.kill('SIGINT');
      await Promise.race([child.exited, Bun.sleep(8_000)]);
      child.kill('SIGKILL');
    },
  };
}

// 1. Starter configuration, then N experts with owned inline knowledge.
const first = await start('generate');
await first.stop();
const settingsPath = join(project, '.foundry', 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const model = settings.defaults.classifierModel ?? 'gpt-6-luna';
const knowledge = (d: string) =>
  Array.from(
    { length: 40 },
    (_, i) =>
      `- ${d} rule ${i}: changes under src/${d}/module${i} must keep the ${d} contract ${i % 3 === 0 ? 'backward compatible' : 'tested'}.`,
  ).join('\n');
for (const d of DOMAINS) {
  settings.agents[`${d}-expert`] = {
    id: `${d}-expert`,
    kind: 'decider',
    flowRole: 'domain-advising',
    domain: d,
    prompt: `You are the ${d} expert. Advise which ${d} context the message needs, from your owned knowledge only.`,
    provider: 'subscription-decisions',
    model,
    tools: false,
    visibleLayers: [`${d}-reference`],
    ownedLayers: [`${d}-reference`],
    peers: [],
    maxDepth: 1,
    enabled: true,
  };
  settings.layers[`${d}-reference`] = {
    id: `${d}-reference`,
    domain: d,
    segment: 'domain-knowledge',
    prompt: `${d} knowledge`,
    sourceIds: [`${d}-source`],
    writers: [`${d}-expert`],
    staleness: 0,
    enabled: true,
  };
  settings.sources[`${d}-source`] = {
    id: `${d}-source`,
    label: d,
    type: 'inline',
    uri: knowledge(d),
    enabled: true,
  };
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

// 2. Measure.
const foundryInstance = await start('measure');
const messages = [
  'Add a rate limit to the login endpoint',
  'Why does the orders query scan the whole table?',
  'Rename the settings page button',
  'Rotate the session signing key',
  'Add a regression test for password reset',
  'Cache the product list response',
  'Split the user model into profile and account',
  'Document the webhook retry policy',
  'Move feature flags to the database',
  'Reduce the bundle size of the dashboard',
  'Audit admin routes for missing checks',
  'Paginate the audit log API',
];
const send = async (id: string, message: string) => {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, threadId: 'main', message }),
  }).catch((error) => ({ status: 0, text: async () => String(error) }) as unknown as Response);
  return { status: response.status, wallMs: Date.now() - started };
};
const ids: string[] = [];
try {
  await send(`warmup-${Date.now()}`, 'Warm up: summarize what this project does.');
  for (let n = 0; n < runs; n++) {
    await Bun.sleep(gapMs);
    const id = `measure-${n}-${Date.now()}`;
    ids.push(id);
    await send(id, messages[n % messages.length]!);
  }
} finally {
  await foundryInstance.stop();
}

// 3. Journaled timings.
const db = new Database(join(project, '.foundry', 'sessions.sqlite'), { readonly: true });
const rows = ids
  .map((id) => {
    const turn = db
      .query('select started_at as startedAt from session_turns where id = ?')
      .get(id) as { startedAt: number } | null;
    const phase = db
      .query('select min(stored_at) as sealedAt from session_phase where turn_id = ?')
      .get(id) as { sealedAt: number | null } | null;
    return { id, startedAt: turn?.startedAt, sealedAt: phase?.sealedAt ?? undefined };
  })
  .filter((r) => r.startedAt && r.sealedAt)
  .map((r) => r.sealedAt! - r.startedAt!);
const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

// Per-decision latency from the decision receipts (primed hosts write decisions.jsonl; exec runs write codex-text.json).
const receipts = join(project, '.foundry', 'decision-receipts');
const decisions: number[] = [];
let hedged = 0,
  fallbacks = 0,
  receiptsSeen = 0;
for (const entry of existsSync(receipts) ? readdirSync(receipts) : []) {
  const jsonl = join(receipts, entry, 'decisions.jsonl'),
    exec = join(receipts, entry, 'codex-text.json');
  if (existsSync(jsonl))
    for (const line of readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      receiptsSeen++;
      if (r.hedged) hedged++;
      if (r.transportFallback) fallbacks++;
      if (r.valid && r.prime === 'warm' && r.finishedAt) decisions.push(r.finishedAt - r.startedAt);
    }
  if (existsSync(exec))
    for (const call of JSON.parse(readFileSync(exec, 'utf8')).calls ?? [])
      if (call.valid && call.finishedAt) decisions.push(call.finishedAt - call.startedAt);
}
// Turns sealed by the safety net (every late decision cut at the deadline) are provider stalls, reported apart.
const budget = await import(
  join(foundry, 'packages/foundry/src/providers/decision-budget.ts')
).catch(() => undefined);
const deadline = budget?.DECISION_DEADLINE_MS ?? 10_000;
const served = rows.filter((ms) => ms < deadline);
const budgetCheck =
  budget?.DECISION_LATENCY_BUDGET && served.length
    ? {
        messageToWorkerP95Ms: budget.DECISION_LATENCY_BUDGET.messageToWorkerP95Ms,
        servedP95: pct(served, 0.95),
        met: pct(served, 0.95)! <= budget.DECISION_LATENCY_BUDGET.messageToWorkerP95Ms,
        safetyNetTurns: rows.length - served.length,
      }
    : undefined;
console.log(
  JSON.stringify({
    foundry,
    experts: DOMAINS.length,
    runs: rows.length,
    gapMs,
    messageToWorkerStartMs: {
      p50: pct(rows, 0.5),
      p95: pct(rows, 0.95),
      max: Math.max(...rows),
      all: rows,
    },
    ...(budgetCheck ? { budget: budgetCheck } : {}),
    decisionMs: decisions.length
      ? { count: decisions.length, p50: pct(decisions, 0.5), p95: pct(decisions, 0.95) }
      : undefined,
    decisions: { total: receiptsSeen, hedged, websocketFallbacks: fallbacks },
    workerLaunch: /in use or unavailable/.test(foundryInstance.output)
      ? 'refused: another Foundry holds the Claude worker lock'
      : 'attempted',
  }),
);
