import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ArchiveSnapshot } from '@inixiative/archive';
import { sessionMetadata, transcriptFiles } from '@inixiative/archive/collector';
import { cwdRunTag, exemptRun } from '@inixiative/archive/exemption';
import { importTranscriptFile } from '@inixiative/archive/import-file';
import type { ArchiveClient } from '@inixiative/archive/remote';
import {
  CORRECTION_CLASSIFY_PREFIX,
  CORRECTION_CLASSIFY_PROMPT,
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
import { snapshotTurns } from '@inixiative/foundry-core/archive';
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
  /** The machine's Archive: the source of sessions; the harness files fill what it lacks. Test and eval runs never count. */
  archive?: Pick<ArchiveClient, 'list' | 'read'>;
  /** Candidacy threshold on the detector's score. */
  minScore?: number;
  /** Cheap model: classifies candidates. */
  scan: { provider: LLMProvider; model: string; batch: number; concurrency: number };
  /** Stronger model: groups statements into rules and sharpens them. */
  polish: { provider: LLMProvider; model: string; batch: number };
  /** Classifications from earlier runs; updated in place. */
  cache?: Map<string, CorrectionClassification>;
  /** Classify every candidate again (the cache still records the answers). */
  refresh?: boolean;
  progress?: (line: string) => void;
}

const HOME = homedir();
const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);
const ARCHIVE_SOURCE_ID = '00000000-0000-4000-8000-000000000000';

/** Session files touched since `since` (Archive's collector walk): no subagent or Foundry decision sessions. */
export function sessionFiles(
  options: Pick<RepeatOptions, 'claudeProjects' | 'codexSessions'>,
  since: number,
): { harness: 'claude-code' | 'codex'; file: string }[] {
  const found: { harness: 'claude-code' | 'codex'; file: string }[] = [];
  for (const [harness, directory] of [
    ['claude-code', options.claudeProjects],
    ['codex', options.codexSessions],
  ] as const) {
    if (!directory || !existsSync(directory)) continue;
    for (const file of transcriptFiles(directory))
      if (
        !/[/\\](?:subagents[/\\]|[^/\\]*decision-receipts)/.test(file) &&
        lstatSync(file).mtimeMs >= since
      )
        found.push({ harness, file });
  }
  return found;
}

/** The session's working directory, as Archive's collector reads it. */
const projectOf = (harness: 'claude-code' | 'codex', file: string) => {
  const cwd = sessionMetadata(file, harness)?.cwd;
  return cwd ? tilde(cwd) : harness;
};

const normalized = (text: string) =>
  scrubSecrets(text).text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
/** The same message reaches us twice when two sources hold it (Archive and a file, history, a Foundry thread). */
const SAME_MESSAGE_MS = 120_000;

export interface Candidate {
  event: CorrectionEvent;
  harness: Harness;
  file: string;
  project: string;
}

/** Candidates from Archive, the harness files it lacks, and prompt history, deduplicated, in the window. */
export async function collectCandidates(
  options: Pick<
    RepeatOptions,
    'archive' | 'claudeProjects' | 'codexSessions' | 'history' | 'minScore'
  >,
  since: number,
  until: number,
) {
  const sources: Record<Harness, number> = { 'claude-code': 0, codex: 0, foundry: 0, history: 0 };
  let failedSources = 0;
  let fromArchive = 0;
  let messages = 0;
  const candidates: Candidate[] = [];
  const inWindow = (at: number) => at >= since && at <= until;
  const seen = new Map<string, { at: number; session: string }[]>();
  /** True when another session already gave this message within two minutes; records it otherwise. */
  const repeatOf = (text: string, at: number, session: string) => {
    const key = normalized(text);
    const earlier = seen.get(key) ?? [];
    if (
      earlier.some((item) => item.session !== session && Math.abs(item.at - at) <= SAME_MESSAGE_MS)
    )
      return true;
    earlier.push({ at, session });
    seen.set(key, earlier);
    return false;
  };
  const take = (
    snapshot: ArchiveSnapshot,
    harness: Exclude<Harness, 'history'>,
    file: string,
    project: string,
  ) => {
    const turns = snapshotTurns(snapshot);
    const session = `${harness}:${snapshot.sessionId}`;
    const copies = new Set<string>();
    const typedTurns = turns.filter((turn) => {
      if (turn.role !== 'user' || !turn.text || !inWindow(Date.parse(turn.timestamp))) return false;
      if (!repeatOf(turn.text, Date.parse(turn.timestamp), session)) return true;
      if (turn.id) copies.add(turn.id);
      return false;
    });
    if (!typedTurns.length) return 0;
    sources[harness]++;
    messages += typedTurns.length;
    const { corrections } = extractCorrections(snapshot.sessionId, turns, {
      minScore: options.minScore,
    });
    for (const event of corrections)
      if (inWindow(Date.parse(event.timestamp)) && !copies.has(event.messageId ?? ''))
        candidates.push({ event, harness, file, project });
    return typedTurns.length;
  };
  // Archive first: it keeps sessions after the harness deletes them. When to capture is the collector's call.
  const archived = new Map<string, { capturedAt: number; messages: number }>();
  // Test and eval runs are listed only so their harness files are skipped too.
  const listings = options.archive
    ? await options.archive.list({ exempt: 'include' }).catch(() => {
        failedSources++;
        return [];
      })
    : [];
  const exempt = new Set<string>();
  if (options.archive) {
    for (const listing of listings) {
      if (exemptRun(listing.tags)) {
        exempt.add(`${listing.source}:${listing.sessionId}`);
        continue;
      }
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
    const cwd = sessionMetadata(file, harness)?.cwd;
    if (cwd && cwdRunTag(cwd)) continue;
    let snapshot: ArchiveSnapshot;
    try {
      snapshot = importTranscriptFile(file, { source: harness, sourceId: ARCHIVE_SOURCE_ID });
    } catch {
      failedSources++;
      continue;
    }
    if (exempt.has(`${harness}:${snapshot.sessionId}`)) continue;
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
      if (!inWindow(row.timestamp) || row.display.startsWith('/')) continue;
      const text = expandPastes(row.display, row.pastedContents);
      if (!text.trim() || repeatOf(text, row.timestamp, 'history')) continue;
      if (typeof row.project === 'string' && cwdRunTag(row.project)) continue;
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

/** A classification is reused only for the same message, prompt and model. */
export const classificationKey = (event: CorrectionEvent, model: string) =>
  `${event.id}#${createHash('sha256')
    .update(
      `${CORRECTION_CLASSIFY_PROMPT}\0${CORRECTION_CLASSIFY_PREFIX}\0${model}\0${event.before}\0${event.correction}`,
    )
    .digest('hex')
    .slice(0, 16)}`;

/** The scan stage: classify candidates in batches on the cheap model, by event id. */
export async function scan(
  candidates: Candidate[],
  options: Pick<RepeatOptions, 'scan' | 'cache' | 'refresh' | 'progress'>,
  usage: StageUsage,
  tokens: TokenCounts[],
) {
  const results = new Map<string, CorrectionClassification>();
  const pending: Candidate[] = [];
  for (const candidate of candidates) {
    const cached = options.refresh
      ? undefined
      : options.cache?.get(classificationKey(candidate.event, options.scan.model));
    if (cached) results.set(candidate.event.id, cached);
    else pending.push(candidate);
  }
  const batches: Candidate[][] = [];
  for (let i = 0; i < pending.length; i += options.scan.batch)
    batches.push(pending.slice(i, i + options.scan.batch));
  let done = 0;
  // A run of failed calls means the login is limited or down: stop asking.
  let failedInARow = 0;
  const STOP_AFTER = 6;
  const split = async (batch: Candidate[]) => {
    if (batch.length > 1)
      for (const half of [batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1)])
        await classify(half);
  };
  const classify = async (batch: Candidate[]): Promise<void> => {
    if (failedInARow >= STOP_AFTER) return;
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
        options.cache?.set(classificationKey(candidate.event, options.scan.model), classification);
      });
      if (missing.length === batch.length) {
        failedInARow++;
        failure(usage, 'unparseable answer');
        await split(batch);
        return;
      }
      failedInARow = 0;
      // A partial answer re-asks only what it missed, one at a time.
      for (const candidate of missing) await classify([candidate]);
    } catch (error) {
      failedInARow++;
      failure(usage, error);
      await split(batch);
    }
  };
  await pool(batches, options.scan.concurrency, async (batch) => {
    await classify(batch);
    if (failedInARow >= STOP_AFTER && !usage.errors['stopped after repeated failures'])
      failure(usage, 'stopped after repeated failures');
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

const MAX_RULES_SHOWN = 200;
const SHARPEN_SLICE = 40;

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
  /** One grouping call; a failed batch is split and asked again, and a lone statement keeps its own rule. */
  const group = async (batch: typeof statements): Promise<void> => {
    // The rules so far, largest first and bounded, so a long window can't outgrow the decision deadline.
    const shown = [...drafts]
      .sort((a, b) => messageCount(b) - messageCount(a))
      .slice(0, MAX_RULES_SHOWN);
    const rules = shown.map((draft, index) => `R${index + 1}: ${draft.statement}`).join('\n');
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
    if (!answer && batch.length > 1) {
      for (const half of [batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1)])
        await group(half);
      return;
    }
    const assign = (answer?.assign ?? {}) as Record<string, unknown>;
    const created = (answer?.new ?? {}) as Record<string, { statement?: unknown; tags?: unknown }>;
    const newIds = new Map<string, Draft>();
    batch.forEach((item, index) => {
      const target = assign[`S${index + 1}`];
      let draft: Draft | undefined;
      if (typeof target === 'string' && /^R\d+$/.test(target))
        draft = shown[Number(target.slice(1)) - 1];
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
  };
  for (let i = 0; i < statements.length; i += options.polish.batch) {
    await group(statements.slice(i, i + options.polish.batch));
    options.progress?.(
      `polish ${Math.min(i + options.polish.batch, statements.length)}/${statements.length} statements`,
    );
  }
  /** Merge and sharpen rules given more than once (the ones the report shows); a failed slice is split. */
  const sharpen = async (slice: Draft[]): Promise<void> => {
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
    }
    const merged = Array.isArray(answer?.rules) ? answer.rules : undefined;
    if (!merged) {
      if (answer) failure(usage, 'unparseable answer');
      if (slice.length > 2)
        for (const half of [slice.slice(0, slice.length >> 1), slice.slice(slice.length >> 1)])
          await sharpen(half);
      return;
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
  };
  const repeatedDrafts = drafts
    .filter((draft) => messageCount(draft) >= 2)
    .sort((a, b) => messageCount(b) - messageCount(a));
  for (let i = 0; i < repeatedDrafts.length; i += SHARPEN_SLICE)
    await sharpen(repeatedDrafts.slice(i, i + SHARPEN_SLICE));
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
  const collected = await collectCandidates(options, since, until);
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
    for (const statement of classification.statements) {
      const text = sentence(statement);
      if (text) statements.push({ text, candidate, classification });
    }
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
    `${new Set(repeated(report).flatMap((rule) => rule.evidence.map((item) => item.id))).size} corrections you gave more than once, in ${repeated(report).length} rules`,
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

/**
 * Rule text fit to share: no paths, URLs, emails or credentials, and none of this run's project or
 * repository names. The model writes the rules, so the share outputs never trust them as written.
 */
export function shareable(report: RepeatReport, statement: string): string {
  const names = new Set<string>();
  for (const rule of report.rules)
    for (const project of rule.projects)
      for (const part of project.split(/[/\\]/).slice(-2))
        if (
          part.length >= 3 &&
          !/^(?:~|code|src|users?|home|projects?|claude|codex|foundry|history)$/i.test(part)
        )
          names.add(part.replace(/^-+/, ''));
  let text = scrubSecrets(statement)
    .text.replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*/g, '[path]');
  for (const name of [...names].sort((a, b) => b.length - a.length))
    text = text.replace(
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      '[project]',
    );
  return text;
}

/** The top five as plain text, fit for a screenshot: rule text and counts only. */
export function renderShareText(report: RepeatReport) {
  const top = repeated(report).slice(0, 5);
  const width = String(top[0]?.count ?? 0).length;
  return [
    `What I kept telling my coding agents (last ${report.days} days)`,
    '',
    ...top.map(
      (rule, index) =>
        `${index + 1}. ×${String(rule.count).padEnd(width)}  ${shareable(report, rule.statement)}`,
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
      (rule, index) =>
        `| ${index + 1} | ${shareable(report, rule.statement).replace(/\|/g, '\\|')} | ${rule.count} |`,
    ),
    '',
    '_Counted locally from my Claude Code and Codex sessions with `foundry repeats`._',
  ].join('\n');
}

/** The repeated rules as data, to seed feedback items: statement, tags, category, count, quotes and refs (local only). */
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
