import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ArchiveSnapshot } from '@inixiative/archive';
import { typedPrompt } from '@inixiative/archive/import';
import { importTranscriptFile } from '@inixiative/archive/import-file';
import type { ArchiveClient } from '@inixiative/archive/remote';
import {
  CORRECTION_CLASSIFY_PREFIX,
  type CorrectionCategory,
  type CorrectionClassification,
  type CorrectionEvent,
  correctionClassifyMessages,
  extractCorrections,
  FEEDBACK_TAGS,
  type FeedbackTag,
  type LLMProvider,
  parseCorrectionClassifications,
  scrubSecrets,
  sumTokenCounts,
  type TokenCounts,
  type TranscriptTurn,
} from '@inixiative/foundry-core';
import { DECISION_PRIORITY } from '../providers/decision-priority';

// The repeat report: corrections a person gave their agents more than once, from local Claude Code
// and Codex history. Tiered: the Prospector's deterministic prefilter, a cheap model to classify
// candidates in batches, and a stronger model only to group statements into rules and sharpen them.

export type Harness = 'claude-code' | 'codex' | 'foundry' | 'history';

/** Where one correction came from: enough to open the turn, never shared. */
export interface RepeatEvidence {
  id: string;
  harness: Harness;
  file: string;
  /** `line:N` in the file. */
  sourceRef?: string;
  sessionId: string;
  project: string;
  at: number;
  signal: CorrectionEvent['signal'];
  category: CorrectionCategory;
  /** The person's message, scrubbed and shortened; local output only. */
  quote: string;
}

export interface RepeatRule {
  statement: string;
  tags: FeedbackTag[];
  category: CorrectionCategory;
  /** Distinct messages that gave this correction. */
  count: number;
  sessions: number;
  projects: string[];
  first: number;
  last: number;
  evidence: RepeatEvidence[];
}

export interface StageUsage {
  stage: 'scan' | 'polish';
  model: string;
  calls: number;
  failed: number;
  /** Why calls failed, with counts. */
  errors: Record<string, number>;
  tokens: TokenCounts;
}

function failure(usage: StageUsage, error: unknown) {
  usage.failed++;
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 160);
  usage.errors[reason] = (usage.errors[reason] ?? 0) + 1;
}

export interface RepeatReport {
  days: number;
  since: number;
  until: number;
  sources: Record<Harness, number>;
  /** Sessions read from Archive rather than from the harness's own files. */
  fromArchive: number;
  failedSources: number;
  /** Messages the person typed in the window. */
  messages: number;
  candidates: number;
  corrections: number;
  statements: number;
  /** Every rule, most repeated first. */
  rules: RepeatRule[];
  usage: StageUsage[];
}

export interface RepeatOptions {
  days: number;
  now?: number;
  claudeProjects?: string;
  codexSessions?: string;
  /** Claude Code's prompt history: typed prompts outliving their transcripts. */
  history?: string;
  /** The machine's Archive: the source of sessions; the harness files fill what it lacks. */
  archive?: Pick<ArchiveClient, 'list' | 'read'>;
  /** Candidacy threshold on the detector's score. */
  minScore?: number;
  /** Cheap model: classifies candidates. */
  scan: { provider: LLMProvider; model: string; batch: number; concurrency: number };
  /** Stronger model: groups statements into rules and sharpens them. */
  polish: { provider: LLMProvider; model: string; batch: number };
  /** Classifications by candidate id from earlier runs; updated in place. */
  cache?: Map<string, CorrectionClassification>;
  progress?: (line: string) => void;
}

const HOME = homedir();
const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);
const ARCHIVE_SOURCE_ID = '00000000-0000-4000-8000-000000000000';
const MARKER = /^\s*\[Request interrupted by user/;

/** Session files touched since `since`: Claude Code projects (not subagents) and Codex sessions. */
export function sessionFiles(
  options: Pick<RepeatOptions, 'claudeProjects' | 'codexSessions'>,
  since: number,
): { harness: 'claude-code' | 'codex'; file: string }[] {
  const found: { harness: 'claude-code' | 'codex'; file: string }[] = [];
  const walk = (harness: 'claude-code' | 'codex', path: string) => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const name = basename(path);
      // Subagent transcripts are written by agents; Foundry's primed decision sessions are its own.
      if (name === 'subagents' || name.includes('decision-receipts')) return;
      for (const entry of readdirSync(path).sort()) walk(harness, join(path, entry));
    } else if (stat.isFile() && path.endsWith('.jsonl') && stat.mtimeMs >= since)
      found.push({ harness, file: path });
  };
  if (options.claudeProjects) walk('claude-code', options.claudeProjects);
  if (options.codexSessions) walk('codex', options.codexSessions);
  return found;
}

/** A short project label: the Claude Code project directory, or the Codex session's working directory. */
function projectOf(harness: 'claude-code' | 'codex', file: string): string {
  if (harness === 'claude-code')
    return basename(dirname(file)).replace(HOME.replace(/[/.]/g, '-'), '~');
  const buffer = Buffer.alloc(Math.min(lstatSync(file).size, 64_000));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  try {
    const meta = JSON.parse(buffer.toString('utf8').split('\n')[0] ?? '');
    if (typeof meta?.payload?.cwd === 'string') return tilde(meta.payload.cwd);
  } catch {}
  return 'codex';
}

/** The transcript as turns: what the person typed, the agent's prose, and interruptions. */
export function snapshotTurns(snapshot: ArchiveSnapshot): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of snapshot.entries) {
    const timestamp = entry.timestamp === null ? '' : new Date(entry.timestamp).toISOString();
    if (entry.kind === 'assistant') turns.push({ role: 'assistant', text: entry.text, timestamp });
    else if ((entry.kind === 'user' || entry.kind === 'event') && MARKER.test(entry.text))
      turns.push({ role: 'user', text: '', timestamp, interrupted: true });
    else if (entry.kind === 'user') {
      const text = typedPrompt(entry.text);
      if (text)
        turns.push({ role: 'user', id: entry.id, text, timestamp, sourceRef: entry.sourceRef });
    }
  }
  return turns;
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

interface Candidate {
  event: CorrectionEvent;
  harness: Harness;
  file: string;
  project: string;
}

/** Candidates from Archive, the harness files it lacks, and prompt history, deduplicated, in the window. */
export async function collectCandidates(options: RepeatOptions, since: number) {
  const sources: Record<Harness, number> = { 'claude-code': 0, codex: 0, foundry: 0, history: 0 };
  let failedSources = 0;
  let fromArchive = 0;
  let messages = 0;
  const typed = new Set<string>();
  const candidates: Candidate[] = [];
  const inWindow = (event: CorrectionEvent) => Date.parse(event.timestamp) >= since;
  const take = (
    snapshot: ArchiveSnapshot,
    harness: Exclude<Harness, 'history'>,
    file: string,
    project: string,
  ) => {
    const turns = snapshotTurns(snapshot);
    const typedTurns = turns.filter(
      (turn) => turn.role === 'user' && turn.text && Date.parse(turn.timestamp) >= since,
    );
    if (!typedTurns.length) return 0;
    sources[harness]++;
    messages += typedTurns.length;
    for (const turn of typedTurns) typed.add(normalized(turn.text));
    const { corrections } = extractCorrections(snapshot.sessionId, turns, {
      minScore: options.minScore,
    });
    for (const event of corrections.filter(inWindow))
      candidates.push({ event, harness, file, project });
    return typedTurns.length;
  };
  // Archive first: it keeps sessions after the harness deletes them. When to capture is the collector's call.
  const archived = new Map<string, { capturedAt: number; messages: number }>();
  if (options.archive) {
    for (const listing of await options.archive.list()) {
      if (listing.capturedAt < since || listing.sessionId.includes('/agent-')) continue;
      if (
        listing.source !== 'claude-code' &&
        listing.source !== 'codex' &&
        listing.source !== 'foundry'
      )
        continue;
      const read = await options.archive.read(listing.id).catch(() => undefined);
      if (!read) {
        failedSources++;
        continue;
      }
      const counted = take(
        read.snapshot,
        listing.source,
        `archive:${listing.id}`,
        listing.projectId ?? listing.source,
      );
      archived.set(`${listing.source}:${listing.sessionId}`, {
        capturedAt: listing.capturedAt,
        messages: counted,
      });
      if (counted) fromArchive++;
    }
  }
  for (const { harness, file } of sessionFiles(options, since)) {
    let snapshot: ArchiveSnapshot;
    try {
      snapshot = importTranscriptFile(file, { source: harness, sourceId: ARCHIVE_SOURCE_ID });
    } catch {
      failedSources++;
      continue;
    }
    // A session Archive captured after the file last changed is already counted.
    const captured = archived.get(`${harness}:${snapshot.sessionId}`);
    if (captured && captured.capturedAt >= lstatSync(file).mtimeMs) continue;
    // The file moved on since Archive's capture: it replaces that copy.
    if (captured?.messages) {
      messages -= captured.messages;
      sources[harness]--;
      fromArchive--;
      for (let i = candidates.length - 1; i >= 0; i--)
        if (
          candidates[i]!.event.sessionId === snapshot.sessionId &&
          candidates[i]!.harness === harness
        )
          candidates.splice(i, 1);
    }
    take(snapshot, harness, file, projectOf(harness, file));
  }
  if (options.history && existsSync(options.history)) {
    const byProject = new Map<string, TranscriptTurn[]>();
    for (const line of readLines(options.history)) {
      let row: {
        display?: unknown;
        timestamp?: unknown;
        project?: unknown;
        pastedContents?: unknown;
      };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof row.display !== 'string' || typeof row.timestamp !== 'number') continue;
      if (row.timestamp < since || row.display.startsWith('/')) continue;
      const text = expandPastes(row.display, row.pastedContents);
      if (!text.trim() || typed.has(normalized(text))) continue;
      typed.add(normalized(text));
      const project = typeof row.project === 'string' ? tilde(row.project) : 'history';
      const turns = byProject.get(project) ?? [];
      turns.push({
        role: 'user',
        id: String(row.timestamp),
        text,
        timestamp: new Date(row.timestamp).toISOString(),
      });
      byProject.set(project, turns);
    }
    for (const [project, turns] of byProject) {
      sources.history += turns.length;
      messages += turns.length;
      const { corrections } = extractCorrections(`history:${project}`, turns, {
        minScore: options.minScore,
      });
      for (const event of corrections)
        candidates.push({ event, harness: 'history', file: options.history, project });
    }
  }
  return { sources, fromArchive, failedSources, messages, candidates };
}

function* readLines(file: string): Generator<string> {
  const fd = openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let pending = '';
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      pending += buffer.toString('utf8', 0, count);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      yield* lines;
    }
    if (pending) yield pending;
  } finally {
    closeSync(fd);
  }
}

/** Claude Code history stores long pastes apart: `[Pasted text #1 +20 lines]` plus the content. */
function expandPastes(display: string, pasted: unknown): string {
  if (!pasted || typeof pasted !== 'object') return display;
  return display.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (marker, id: string) => {
    const content = (pasted as Record<string, { content?: unknown }>)[id]?.content;
    return typeof content === 'string' ? content : marker;
  });
}

async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}

export const classificationKey = (id: string) =>
  `${id}#${createHash('sha256').update(CORRECTION_CLASSIFY_PREFIX).digest('hex').slice(0, 8)}`;

/** The scan stage: classify candidates in batches on the cheap model. */
async function scan(
  candidates: Candidate[],
  options: RepeatOptions,
  usage: StageUsage,
  tokens: TokenCounts[],
) {
  const results = new Map<string, CorrectionClassification>();
  const pending: Candidate[] = [];
  for (const candidate of candidates) {
    const cached = options.cache?.get(classificationKey(candidate.event.id));
    if (cached) results.set(candidate.event.id, cached);
    else pending.push(candidate);
  }
  const batches: Candidate[][] = [];
  for (let i = 0; i < pending.length; i += options.scan.batch)
    batches.push(pending.slice(i, i + options.scan.batch));
  let done = 0;
  const classify = async (batch: Candidate[]): Promise<void> => {
    usage.calls++;
    try {
      const messages = correctionClassifyMessages(batch.map((candidate) => candidate.event));
      const result = await options.scan.provider.complete(messages, {
        threadId: 'repeats:scan',
        stablePrefix: CORRECTION_CLASSIFY_PREFIX,
        tools: false,
        maxTurns: 1,
        priority: DECISION_PRIORITY.review,
      });
      if (result.tokens) tokens.push(result.tokens);
      const parsed = parseCorrectionClassifications(result.content, batch.length);
      const missing = batch.filter((_, index) => !parsed[index]);
      batch.forEach((candidate, index) => {
        const classification = parsed[index];
        if (!classification) return;
        results.set(candidate.event.id, classification);
        options.cache?.set(classificationKey(candidate.event.id), classification);
      });
      // A partial answer re-asks only what it missed, one at a time.
      if (missing.length && missing.length < batch.length)
        for (const candidate of missing) await classify([candidate]);
      else if (missing.length) failure(usage, 'unparseable answer');
    } catch (error) {
      failure(usage, error);
      if (batch.length > 1)
        for (const half of [batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1)])
          await classify(half);
    }
  };
  await pool(batches, options.scan.concurrency, async (batch) => {
    await classify(batch);
    done += batch.length;
    options.progress?.(`scan ${done}/${pending.length} candidates`);
  });
  return results;
}

export const REPEAT_GROUP_PROMPT = `You group rules a person gave an AI coding agent into distinct behaviors.

You get the rules so far (R1, R2, ...; possibly none) and new statements (S1, S2, ...). Put every new statement under the existing rule that asks for the same behavior, even when it is worded differently or arose in a different project, or start a new rule for it. Different behaviors stay apart: when unsure, start a new rule, because merging different corrections hides the ones that keep failing.

A new rule's statement: one imperative sentence of at most 160 characters that says when it applies ("When X, do Y." or "Never X."), general enough to cover its statements. tags: one to three of ${FEEDBACK_TAGS.join(', ')}.

Respond with JSON only:
{ "assign": { "S1": "R3", "S2": "N1" }, "new": { "N1": { "statement": string, "tags": string[] } } }`;

export const REPEAT_POLISH_PROMPT = `You review rules a person gave an AI coding agent, each with how often they gave it. Merge rules that ask for the same behavior, and rewrite each surviving rule as one crisp imperative sentence of at most 160 characters that says when it applies ("When X, do Y." or "Never X."), in the person's terms. Keep different behaviors apart. tags: one to three of ${FEEDBACK_TAGS.join(', ')}.

Respond with JSON only, listing every input rule id exactly once across "ids":
{ "rules": [ { "ids": ["R1", "R4"], "statement": string, "tags": string[] } ] }`;

interface Draft {
  statement: string;
  tags: FeedbackTag[];
  members: { candidate: Candidate; classification: CorrectionClassification }[];
}

const tagsOf = (value: unknown): FeedbackTag[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((tag): tag is FeedbackTag => FEEDBACK_TAGS.includes(tag)))].slice(
        0,
        3,
      )
    : [];
const sentence = (value: unknown) =>
  typeof value === 'string' && value.trim()
    ? scrubSecrets(value.trim()).text.slice(0, 160)
    : undefined;
function firstJson(content: string): Record<string, unknown> | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(content.slice(start, end + 1));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The polish stage: group statements into rules, then merge and sharpen the rules that repeat. */
async function polish(
  statements: { text: string; candidate: Candidate; classification: CorrectionClassification }[],
  options: RepeatOptions,
  usage: StageUsage,
  tokens: TokenCounts[],
): Promise<Draft[]> {
  const drafts: Draft[] = [];
  const call = async (system: string, user: string) => {
    usage.calls++;
    const result = await options.polish.provider.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        threadId: 'repeats:polish',
        tools: false,
        maxTurns: 1,
        priority: DECISION_PRIORITY.review,
      },
    );
    if (result.tokens) tokens.push(result.tokens);
    return firstJson(result.content);
  };
  for (let i = 0; i < statements.length; i += options.polish.batch) {
    const batch = statements.slice(i, i + options.polish.batch);
    const rules = drafts.map((draft, index) => `R${index + 1}: ${draft.statement}`).join('\n');
    const input = batch.map((item, index) => `S${index + 1}: ${item.text}`).join('\n');
    let answer: Record<string, unknown> | undefined;
    try {
      answer = await call(
        REPEAT_GROUP_PROMPT,
        `## Rules so far\n${rules || '(none)'}\n\n## New statements\n${input}`,
      );
      if (!answer) failure(usage, 'unparseable answer');
    } catch (error) {
      failure(usage, error);
    }
    const assign = (answer?.assign ?? {}) as Record<string, unknown>;
    const created = (answer?.new ?? {}) as Record<string, { statement?: unknown; tags?: unknown }>;
    const newIds = new Map<string, Draft>();
    batch.forEach((item, index) => {
      const target = assign[`S${index + 1}`];
      let draft: Draft | undefined;
      if (typeof target === 'string' && /^R\d+$/.test(target))
        draft = drafts[Number(target.slice(1)) - 1];
      else if (typeof target === 'string' && created[target]) {
        draft = newIds.get(target);
        if (!draft) {
          draft = {
            statement: sentence(created[target]?.statement) ?? item.text,
            tags: tagsOf(created[target]?.tags),
            members: [],
          };
          newIds.set(target, draft);
          drafts.push(draft);
        }
      }
      // Unassigned statements stay their own rule: under-merging is safer than over-merging.
      if (!draft) {
        draft = { statement: item.text, tags: [], members: [] };
        drafts.push(draft);
      }
      draft.members.push({ candidate: item.candidate, classification: item.classification });
    });
    options.progress?.(
      `polish ${Math.min(i + options.polish.batch, statements.length)}/${statements.length} statements`,
    );
  }
  // Merge and sharpen the rules given more than once (the ones the report shows).
  const repeated = drafts.filter((draft) => messageCount(draft) >= 2);
  for (let i = 0; i < repeated.length; i += 80) {
    const slice = repeated.slice(i, i + 80);
    let answer: Record<string, unknown> | undefined;
    try {
      answer = await call(
        REPEAT_POLISH_PROMPT,
        slice
          .map((draft, index) => `R${index + 1} (×${messageCount(draft)}): ${draft.statement}`)
          .join('\n'),
      );
    } catch (error) {
      failure(usage, error);
      continue;
    }
    const merged = Array.isArray(answer?.rules) ? answer.rules : undefined;
    if (!merged) {
      failure(usage, 'unparseable answer');
      continue;
    }
    const used = new Set<number>();
    for (const rule of merged as { ids?: unknown; statement?: unknown; tags?: unknown }[]) {
      const ids = Array.isArray(rule.ids)
        ? rule.ids
            .map((id) => (typeof id === 'string' ? Number(id.replace(/^R/, '')) - 1 : -1))
            .filter((index) => index >= 0 && index < slice.length && !used.has(index))
        : [];
      if (!ids.length) continue;
      for (const index of ids) used.add(index);
      const [keep, ...rest] = ids.map((index) => slice[index]!);
      keep!.statement = sentence(rule.statement) ?? keep!.statement;
      keep!.tags = tagsOf(rule.tags).length ? tagsOf(rule.tags) : keep!.tags;
      for (const other of rest) {
        keep!.members.push(...other.members);
        other.members = [];
      }
    }
  }
  return drafts.filter((draft) => draft.members.length);
}

const messageCount = (draft: Draft) =>
  new Set(draft.members.map((member) => member.candidate.event.id)).size;

function majority<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

export async function repeatReport(options: RepeatOptions): Promise<RepeatReport> {
  const until = options.now ?? Date.now();
  const since = until - options.days * 86_400_000;
  options.progress?.('reading sessions');
  const collected = await collectCandidates(options, since);
  options.progress?.(
    `${collected.messages} typed messages, ${collected.candidates.length} candidates`,
  );
  const scanUsage: StageUsage = {
    stage: 'scan',
    model: options.scan.model,
    calls: 0,
    failed: 0,
    errors: {},
    tokens: { input: 0, output: 0 },
  };
  const polishUsage: StageUsage = {
    stage: 'polish',
    model: options.polish.model,
    calls: 0,
    failed: 0,
    errors: {},
    tokens: { input: 0, output: 0 },
  };
  const scanTokens: TokenCounts[] = [];
  const polishTokens: TokenCounts[] = [];
  const classified = await scan(collected.candidates, options, scanUsage, scanTokens);
  const statements: {
    text: string;
    candidate: Candidate;
    classification: CorrectionClassification;
  }[] = [];
  let corrections = 0;
  for (const candidate of collected.candidates) {
    const classification = classified.get(candidate.event.id);
    if (!classification?.isCorrection) continue;
    corrections++;
    for (const text of classification.statements)
      statements.push({ text, candidate, classification });
  }
  const drafts = await polish(statements, options, polishUsage, polishTokens);
  scanUsage.tokens = sumTokenCounts(scanTokens);
  polishUsage.tokens = sumTokenCounts(polishTokens);
  const rules = drafts
    .map((draft): RepeatRule => {
      const byMessage = new Map<string, Draft['members'][number]>();
      for (const member of draft.members) byMessage.set(member.candidate.event.id, member);
      const evidence = [...byMessage.values()]
        .map(({ candidate, classification }) => ({
          id: candidate.event.id,
          harness: candidate.harness,
          file: candidate.file,
          ...(candidate.event.sourceRef ? { sourceRef: candidate.event.sourceRef } : {}),
          sessionId: candidate.event.sessionId,
          project: candidate.project,
          at: Date.parse(candidate.event.timestamp),
          signal: candidate.event.signal,
          category: classification.category,
          quote: candidate.event.correction.replace(/\s+/g, ' ').slice(0, 240),
        }))
        .sort((a, b) => a.at - b.at);
      return {
        statement: draft.statement,
        tags: draft.tags,
        category: majority(evidence.map((item) => item.category)),
        count: evidence.length,
        sessions: new Set(evidence.map((item) => item.sessionId)).size,
        projects: [...new Set(evidence.map((item) => item.project))],
        first: evidence[0]!.at,
        last: evidence.at(-1)!.at,
        evidence,
      };
    })
    .sort((a, b) => b.count - a.count || b.sessions - a.sessions || b.last - a.last);
  return {
    days: options.days,
    since,
    until,
    sources: collected.sources,
    fromArchive: collected.fromArchive,
    failedSources: collected.failedSources,
    messages: collected.messages,
    candidates: collected.candidates.length,
    corrections,
    statements: statements.length,
    rules,
    usage: [scanUsage, polishUsage],
  };
}

// ---------------------------------------------------------------------------
// Rendering. The share outputs carry rule text and counts only, never session content.
// ---------------------------------------------------------------------------

const day = (at: number) => new Date(at).toISOString().slice(5, 10);
const thousands = (value: number) => value.toLocaleString('en-US');
const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : String(value);

export const repeated = (report: RepeatReport) => report.rules.filter((rule) => rule.count >= 2);

export function renderReport(
  report: RepeatReport,
  options: { quotes?: boolean; limit?: number } = {},
) {
  const shown = repeated(report).slice(0, options.limit ?? 25);
  const sessions = report.sources['claude-code'] + report.sources.codex + report.sources.foundry;
  const lines = [
    `Last ${report.days} days · ${thousands(sessions)} sessions (Claude Code ${report.sources['claude-code']}, Codex ${report.sources.codex}${report.sources.foundry ? `, Foundry ${report.sources.foundry}` : ''}; ${report.fromArchive} from Archive)${report.sources.history ? ` + ${thousands(report.sources.history)} history prompts` : ''} · ${thousands(report.messages)} messages you typed`,
    `${repeated(report).reduce((sum, rule) => sum + rule.count, 0)} corrections you gave more than once, in ${repeated(report).length} rules`,
    '',
  ];
  if (!shown.length) lines.push('No correction repeated in this window.');
  const width = String(shown[0]?.count ?? 0).length;
  for (const rule of shown) {
    lines.push(
      ` ×${String(rule.count).padEnd(width)}  ${rule.statement}`,
      `   ${' '.repeat(width)}${[rule.tags.join(', ') || rule.category, `${rule.sessions} session${rule.sessions === 1 ? '' : 's'}`, `${rule.projects.length} project${rule.projects.length === 1 ? '' : 's'}`, `${day(rule.first)} → ${day(rule.last)}`].join(' · ')}`,
    );
    for (const item of rule.evidence.slice(-3).reverse()) {
      const where =
        item.harness === 'history'
          ? `${tilde(item.file)} @ ${new Date(item.at).toISOString()}`
          : `${tilde(item.file)}${item.sourceRef ? `:${item.sourceRef.replace(/^line:/, '')}` : ''}`;
      lines.push(`   ${' '.repeat(width)}  ${day(item.at)} ${where}`);
      if (options.quotes) lines.push(`   ${' '.repeat(width)}    “${item.quote}”`);
    }
    if (rule.evidence.length > 3)
      lines.push(`   ${' '.repeat(width)}  … ${rule.evidence.length - 3} more`);
    lines.push('');
  }
  lines.push(
    `${thousands(report.candidates)} candidates from the prefilter → ${thousands(report.corrections)} corrections → ${thousands(report.statements)} statements`,
  );
  for (const usage of report.usage)
    lines.push(
      `${usage.stage.padEnd(6)} ${usage.model}: ${usage.calls} calls${usage.failed ? ` (${usage.failed} failed)` : ''}, ${compact(usage.tokens.input + (usage.tokens.cacheRead ?? 0) + (usage.tokens.cacheWrite ?? 0))} in / ${compact(usage.tokens.output)} out`,
    );
  for (const usage of report.usage)
    for (const [reason, count] of Object.entries(usage.errors))
      lines.push(`  ${usage.stage} failure ×${count}: ${reason}`);
  if (report.failedSources) lines.push(`${report.failedSources} session files could not be read`);
  return lines.join('\n');
}

/** The top five as plain text, fit for a screenshot: rule text and counts only. */
export function renderShareText(report: RepeatReport) {
  const top = repeated(report).slice(0, 5);
  const width = String(top[0]?.count ?? 0).length;
  return [
    `What I kept telling my coding agents (last ${report.days} days)`,
    '',
    ...top.map(
      (rule, index) => `${index + 1}. ×${String(rule.count).padEnd(width)}  ${rule.statement}`,
    ),
    '',
    'Counted locally from my Claude Code and Codex sessions with `foundry repeats`.',
  ].join('\n');
}

/** The top five as markdown: rule text and counts only. */
export function renderShareMarkdown(report: RepeatReport) {
  const top = repeated(report).slice(0, 5);
  return [
    `**What I kept telling my coding agents** (last ${report.days} days)`,
    '',
    '| | Correction | Times |',
    '|---|---|---|',
    ...top.map(
      (rule, index) => `| ${index + 1} | ${rule.statement.replace(/\|/g, '\\|')} | ${rule.count} |`,
    ),
    '',
    '_Counted locally from my Claude Code and Codex sessions with `foundry repeats`._',
  ].join('\n');
}

/** Rules for `foundry feedback import`: statement, tags, category, count and quotes (local only). */
export function reportItems(report: RepeatReport) {
  return repeated(report).map((rule) => ({
    statement: rule.statement,
    tags: rule.tags,
    category: rule.category,
    count: rule.count,
    first: new Date(rule.first).toISOString(),
    last: new Date(rule.last).toISOString(),
    quotes: rule.evidence.map((item) => item.quote),
    refs: rule.evidence.map((item) => ({
      harness: item.harness,
      file: item.file,
      sourceRef: item.sourceRef,
      at: new Date(item.at).toISOString(),
    })),
  }));
}
