import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { localArchive } from '@inixiative/archive/remote';
import {
  type CorrectionClassification,
  SUBSCRIPTION_DECISION_MODELS,
} from '@inixiative/foundry-core';
import { decisionHost, privateDirectory } from '../providers/decision-host';
import {
  renderReport,
  renderShareMarkdown,
  renderShareText,
  repeatReport,
  reportItems,
} from './repeats';

export const REPEATS_USAGE = `foundry repeats [options]

Lists the corrections you gave your coding agents more than once, from your local Claude Code
and Codex sessions. Everything runs on this machine; the share outputs hold rule text and counts only.

  --days N             window in days (default 30)
  --scan-model ID      cheap model that classifies candidates (default claude-haiku-5-5)
  --polish-model ID    stronger model that groups and sharpens rules (default claude-opus-5-5)
  --runtime R          decision runtime: claude (default) or codex
  --scan-batch N       candidates per scan call (default 10)
  --polish-batch N     statements per polish call (default 40)
  --concurrency N      scan calls at once (default 8)
  --min-score X        prefilter threshold, 0-1 (default 0.4)
  --share FORMAT       print only the top five: text or markdown
  --json               print the repeated rules as JSON (local: includes quotes and paths)
  --quotes             show what you wrote under each rule
  --limit N            rules to show (default 25)
  --no-archive         read only the harness files, not this machine's Archive
  --no-history         skip ~/.claude/history.jsonl
  --no-cache           classify every candidate again (answers are still recorded)`;

const STATE = join(homedir(), '.foundry', 'repeats');
/** The heavier decision models subscription-decisions.md names for roles that need them. */
const POLISH_MODELS = { claude: 'claude-opus-5-5', codex: 'gpt-6-astra' } as const;
const CACHE = join(STATE, 'classifications.jsonl');

/** This machine's Archive, when it is set up and answering; the harness files cover the rest. */
async function reachableArchive() {
  const archive = localArchive();
  if (!archive) return undefined;
  try {
    await Promise.race([
      archive.sourceId(),
      Bun.sleep(10_000).then(() => {
        throw Error('timeout');
      }),
    ]);
    return archive;
  } catch {
    return undefined;
  }
}

function loadCache() {
  const cache = new Map<string, CorrectionClassification>();
  if (!existsSync(CACHE)) return cache;
  for (const line of readFileSync(CACHE, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const { key, value } = JSON.parse(line) as { key: string; value: CorrectionClassification };
      cache.set(key, value);
    } catch {}
  }
  return cache;
}

/** Written whole to a temporary file and renamed, so an interrupted run never truncates it. */
function saveCache(cache: Map<string, CorrectionClassification>) {
  privateDirectory(STATE);
  const temporary = `${CACHE}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    [...cache].map(([key, value]) => JSON.stringify({ key, value })).join('\n'),
    { mode: 0o600 },
  );
  renameSync(temporary, CACHE);
}

const positive = (value: string | undefined, fallback: number, name: string) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw Error(`--${name} must be a positive number`);
  return parsed;
};

export async function runRepeats(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      days: { type: 'string' },
      'scan-model': { type: 'string' },
      'polish-model': { type: 'string' },
      runtime: { type: 'string' },
      'scan-batch': { type: 'string' },
      'polish-batch': { type: 'string' },
      concurrency: { type: 'string' },
      'min-score': { type: 'string' },
      share: { type: 'string' },
      json: { type: 'boolean' },
      quotes: { type: 'boolean' },
      limit: { type: 'string' },
      'no-history': { type: 'boolean' },
      'no-archive': { type: 'boolean' },
      'no-cache': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(REPEATS_USAGE);
    return 0;
  }
  const runtime = values.runtime ?? 'claude';
  if (runtime !== 'claude' && runtime !== 'codex') throw Error('--runtime is claude or codex');
  if (values.share && values.share !== 'text' && values.share !== 'markdown')
    throw Error('--share is text or markdown');
  const concurrency = Math.min(32, Math.floor(positive(values.concurrency, 8, 'concurrency')));
  const minScore = values['min-score'] === undefined ? 0.4 : Number(values['min-score']);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)
    throw Error('--min-score is a number from 0 to 1');
  // The scan runs on the runtime's decision model; polish on a stronger model of the same runtime.
  const scanModel = values['scan-model'] ?? SUBSCRIPTION_DECISION_MODELS[runtime];
  const polishModel = values['polish-model'] ?? POLISH_MODELS[runtime];
  const scanHost = decisionHost(scanModel, runtime, concurrency, STATE);
  const polishHost =
    polishModel === scanModel ? scanHost : decisionHost(polishModel, runtime, 1, STATE);
  const cache = loadCache();
  const archive = values['no-archive'] ? undefined : await reachableArchive();
  const progress = process.stderr.isTTY
    ? (line: string) => process.stderr.write(`\r\x1b[2K${line}`)
    : undefined;
  try {
    const report = await repeatReport({
      days: positive(values.days, 30, 'days'),
      minScore,
      claudeProjects: join(homedir(), '.claude', 'projects'),
      codexSessions: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
      ...(values['no-history'] ? {} : { history: join(homedir(), '.claude', 'history.jsonl') }),
      ...(archive ? { archive } : {}),
      scan: {
        provider: scanHost.provider,
        model: scanModel,
        batch: Math.floor(positive(values['scan-batch'], 10, 'scan-batch')),
        concurrency,
      },
      polish: {
        provider: polishHost.provider,
        model: polishModel,
        batch: Math.floor(positive(values['polish-batch'], 40, 'polish-batch')),
      },
      cache,
      refresh: Boolean(values['no-cache']),
      progress,
    });
    if (progress) process.stderr.write('\r\x1b[2K');
    if (values.json) console.log(JSON.stringify(reportItems(report), null, 2));
    else if (values.share === 'markdown') console.log(renderShareMarkdown(report));
    else if (values.share === 'text') console.log(renderShareText(report));
    else
      console.log(
        `${renderReport(report, {
          quotes: values.quotes,
          limit: values.limit ? Math.floor(positive(values.limit, 25, 'limit')) : undefined,
        })}\n\nShare your top five (rule text and counts only):\n\n${renderShareText(report)}`,
      );
    return 0;
  } finally {
    saveCache(cache);
    await Promise.all([
      scanHost.shutdown(),
      ...(polishHost === scanHost ? [] : [polishHost.shutdown()]),
    ]);
  }
}
