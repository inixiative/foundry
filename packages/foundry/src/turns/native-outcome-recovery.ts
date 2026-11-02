/**
 * @atlas
 * @kind service
 * @partOf feature:threads, primitive:nativeSessions
 */
/**
 * Settles a turn Foundry lost track of (a restart mid-turn, `recoverInterrupted`) from the native
 * session's own record, so a thread never dead-ends on "outcome unknown" (Aron, 2026-11-02).
 *
 * Claude Code writes every session to `<config dir>/projects/<cwd>/<session id>.jsonl`; Codex to
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. The record says whether the
 * turn finished (`end_turn`; `task_complete`) or stopped part-way. "Stopped" is only concluded once
 * the file has been quiet for a while, because a native process orphaned by the restart may still
 * be finishing it. What the record cannot settle stays unsettled, and the thread shows the owner a
 * Continue / Retry card (`/api/threads/:id/recovery`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AdmissionSettlement,
  LocalSessionStore,
  UnsettledAdmission,
} from '../persistence/local-session-store';

/** A record untouched this long belongs to no running native process. */
export const NATIVE_RECORD_QUIET_MS = 60_000;
/** A tool call with no result yet may be a long command or subagent: wait much longer before calling it dead. */
export const NATIVE_TOOL_QUIET_MS = 15 * 60_000;
/**
 * The native prompt is written after Foundry registers the admission on the same machine, so only a
 * small allowance is needed. A wide one would let the previous turn's ending pass for this one's.
 */
const ADMISSION_SKEW_MS = 1_000;
const CLAUDE_DONE = new Set(['end_turn', 'stop_sequence', 'refusal']);

export type NativeRecordReading =
  | { outcome: 'completed' | 'interrupted'; detail: string; neverReached?: boolean }
  | { outcome: 'undecided'; detail: string };

const lines = (text: string): Array<Record<string, unknown>> =>
  text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
    } catch {
      return []; // a line cut off by the process dying mid-write
    }
  });

const time = (entry: Record<string, unknown>) =>
  typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;

const blocks = (entry: Record<string, unknown>): Array<{ type?: unknown }> => {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Array<{ type?: unknown }>) : [];
};

/** A message someone sent the session, not a tool result, a meta line or a compaction summary. */
const isPrompt = (entry: Record<string, unknown>) => {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' || blocks(entry).some((block) => block.type === 'text');
};

const stillWorking = {
  outcome: 'undecided',
  detail: 'the native session may still be working',
} as const;

/**
 * A Claude Code transcript: did the turn admitted at `admittedAt` finish? Only what follows this
 * turn's own prompt counts; `quietForMs` is how long the session's files have been untouched.
 */
export function readClaudeTranscript(
  text: string,
  admittedAt: number,
  quietForMs: number,
): NativeRecordReading {
  const entries = lines(text).filter(
    (entry) => (entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain,
  );
  const prompt = entries.findIndex(
    (entry) => isPrompt(entry) && !(time(entry) < admittedAt - ADMISSION_SKEW_MS),
  );
  if (prompt < 0)
    return quietForMs >= NATIVE_RECORD_QUIET_MS
      ? {
          outcome: 'interrupted',
          detail: 'the message never reached the native session',
          neverReached: true,
        }
      : { outcome: 'undecided', detail: 'the native session has not recorded the message yet' };
  const last = entries.at(-1)!;
  if (
    last.type === 'assistant' &&
    CLAUDE_DONE.has(String((last.message as { stop_reason?: unknown } | undefined)?.stop_reason)) &&
    !blocks(last).some((block) => block.type === 'tool_use')
  )
    return { outcome: 'completed', detail: 'the native session finished its answer' };
  const toolPending =
    last.type === 'assistant' && blocks(last).some((block) => block.type === 'tool_use');
  if (quietForMs < (toolPending ? NATIVE_TOOL_QUIET_MS : NATIVE_RECORD_QUIET_MS))
    return stillWorking;
  return { outcome: 'interrupted', detail: 'the native session stopped part-way through the turn' };
}

/** A Codex rollout: the task events after this turn's own `task_started` say how it ended. */
export function readCodexRollout(
  text: string,
  admittedAt: number,
  quietForMs: number,
): NativeRecordReading {
  const events = lines(text)
    .filter(
      (entry) => entry.type === 'event_msg' && !(time(entry) < admittedAt - ADMISSION_SKEW_MS),
    )
    .map((entry) => (entry.payload as { type?: unknown } | undefined)?.type)
    .filter(
      (type) => type === 'task_started' || type === 'task_complete' || type === 'turn_aborted',
    );
  const started = events.indexOf('task_started');
  if (started < 0)
    return quietForMs >= NATIVE_RECORD_QUIET_MS
      ? {
          outcome: 'interrupted',
          detail: 'the message never reached the native session',
          neverReached: true,
        }
      : { outcome: 'undecided', detail: 'the native session has not recorded the message yet' };
  const last = events.at(-1);
  if (last === 'task_complete')
    return { outcome: 'completed', detail: 'the native session finished its answer' };
  if (last === 'turn_aborted')
    return { outcome: 'interrupted', detail: 'the native session aborted the turn' };
  if (quietForMs < NATIVE_RECORD_QUIET_MS) return stillWorking;
  return { outcome: 'interrupted', detail: 'the native session stopped part-way through the turn' };
}

/** The newest write among a record and what its session keeps beside it (`<id>/subagents/…`, tool results). */
const lastWrite = (path: string): number => {
  let newest = statSync(path).mtimeMs;
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(child, depth - 1);
      } else
        try {
          newest = Math.max(newest, statSync(child).mtimeMs);
        } catch {
          /* gone meanwhile */
        }
    }
  };
  walk(path.replace(/\.jsonl$/, ''), 2);
  return newest;
};

const directories = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
};

/** Codex shards rollouts by date; walk only what can hold one. */
const findRollout = (root: string, id: string, depth = 4): string | undefined => {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries)
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`${id}.jsonl`))
      return join(root, entry.name);
  if (depth === 0) return undefined;
  for (const entry of entries)
    if (entry.isDirectory()) {
      const found = findRollout(join(root, entry.name), id, depth - 1);
      if (found) return found;
    }
  return undefined;
};

/** The native record of a session, searched in each profile home (a Claude config dir or a CODEX_HOME). */
export function locateNativeRecord(
  sessionId: string,
  homes: readonly string[],
): { kind: 'claude' | 'codex'; path: string } | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  for (const home of homes) {
    for (const project of directories(join(home, 'projects'))) {
      const path = join(project, `${sessionId}.jsonl`);
      try {
        if (statSync(path).isFile()) return { kind: 'claude', path };
      } catch {
        /* not in this project */
      }
    }
    for (const folder of ['sessions', 'archived_sessions']) {
      const path = findRollout(join(home, folder), sessionId);
      if (path) return { kind: 'codex', path };
    }
  }
  return undefined;
}

/**
 * Every home a native session of this machine may have written to: the default Claude and Codex
 * homes, each configured login's profile (`nativeAuthentication`), and the Foundry-owned homes under the config directory
 * (private CODEX_HOMEs, Kingdom pool logins).
 */
export function nativeHomes(foundryDir: string): string[] {
  const home = process.env.HOME || homedir();
  let profileDirectories: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(join(foundryDir, 'settings.json'), 'utf8')) as {
      nativeAuthentication?: Array<{ profileDirectory?: unknown }>;
    };
    profileDirectories = (settings.nativeAuthentication ?? []).flatMap((login) =>
      typeof login.profileDirectory === 'string' ? [login.profileDirectory] : [],
    );
  } catch {
    /* no settings yet: the default homes only */
  }
  const found = new Set<string>([
    ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []),
    join(home, '.claude'),
    ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []),
    join(home, '.codex'),
    ...profileDirectories,
  ]);
  // Foundry-owned homes sit a few levels down (runtime-profiles/<id>/codex-home-user, logins/…).
  const walk = (dir: string, depth: number) => {
    for (const child of directories(dir)) {
      const names = new Set(directories(child).map((path) => path.slice(child.length + 1)));
      if (names.has('projects') || names.has('sessions')) found.add(child);
      else if (depth > 0 && !names.has('node_modules')) walk(child, depth - 1);
    }
  };
  walk(foundryDir, 3);
  return [...found];
}

export interface NativeOutcomeRecoveryOptions {
  store: LocalSessionStore;
  /** Profile homes to search, read on each pass so a login added later is found. */
  homes: () => readonly string[];
  /** Native session ids bound to a thread (the external-session bindings), for an admission that died before any native event named one. */
  boundSessions?: (threadId: string) => readonly string[];
  /** When this Foundry process started: admissions after it are its own, live or not. */
  bootedAt: number;
  now?: () => number;
}

export interface RecoveryPass {
  settled: Array<{ turnId: string; outcome: AdmissionSettlement['outcome'] }>;
  undecided: Array<{ turnId: string; detail: string }>;
}

export class NativeOutcomeRecovery {
  constructor(private readonly options: NativeOutcomeRecoveryOptions) {}

  /** Settle every thread's lost turns the native records can settle (startup, and once records go quiet). */
  settleAll(): RecoveryPass {
    const pass: RecoveryPass = { settled: [], undecided: [] };
    for (const threadId of this.options.store.threadsWithUnknownAdmissions()) {
      const one = this.settle(threadId);
      pass.settled.push(...one.settled);
      pass.undecided.push(...one.undecided);
    }
    return pass;
  }

  /** Settle what the native record can settle for one thread; report the rest. */
  settle(threadId: string): RecoveryPass {
    const pass: RecoveryPass = { settled: [], undecided: [] };
    const { store } = this.options;
    // Only what an earlier run of Foundry admitted: an admission of this run still has its observer,
    // and an unknown outcome there means "not finished yet", not "lost".
    const unsettled = store
      .unsettledAdmissions(threadId)
      .filter((admission) => admission.admittedAt < this.options.bootedAt);
    if (!unsettled.length) return pass;
    const homes = this.options.homes();
    for (const admission of unsettled) {
      const reading = this.read(threadId, admission, homes);
      if (reading.outcome === 'undecided') {
        if (admission.main)
          pass.undecided.push({ turnId: admission.turnId, detail: reading.detail });
        continue;
      }
      store.settleAdmission(threadId, admission.admissionId, {
        outcome: reading.outcome,
        by: 'native-record',
        detail: reading.detail,
        ...(reading.sessionId ? { nativeSessionId: reading.sessionId } : {}),
      });
      if (admission.main) pass.settled.push({ turnId: admission.turnId, outcome: reading.outcome });
    }
    return pass;
  }

  /** The owner decides: `continue` accepts the lost turn as it stands, `retry` settles it to send again. */
  resolveByOwner(threadId: string, action: 'continue' | 'retry'): UnsettledAdmission[] {
    const unsettled = this.options.store
      .unsettledAdmissions(threadId)
      .filter((admission) => admission.admittedAt < this.options.bootedAt);
    for (const admission of unsettled)
      this.options.store.settleAdmission(threadId, admission.admissionId, {
        outcome: action === 'continue' ? 'continued' : 'retried',
        by: 'owner',
        detail:
          action === 'continue'
            ? 'the owner accepted the turn as it stands'
            : 'the owner sent the turn again',
      });
    return unsettled;
  }

  private read(
    threadId: string,
    admission: UnsettledAdmission,
    homes: readonly string[],
  ): NativeRecordReading & { sessionId?: string } {
    const named = [admission.nativeSessionId, admission.externalSessionId].filter(
      (id): id is string => !!id,
    );
    // The thread's bindings (every login and runtime it ran on) only stand in for the executor's own
    // session when no native event named one; a bound session that shows no sign of this turn says nothing.
    const bound =
      admission.main && !named.length ? (this.options.boundSessions?.(threadId) ?? []) : [];
    const ids = [...named, ...bound].filter((id, index, all) => all.indexOf(id) === index);
    for (const id of ids) {
      const record = locateNativeRecord(id, homes);
      if (!record) continue;
      let text: string;
      let modified: number;
      try {
        text = readFileSync(record.path, 'utf8');
        modified = lastWrite(record.path);
      } catch {
        continue;
      }
      const quietFor = (this.options.now?.() ?? Date.now()) - modified;
      const reading =
        record.kind === 'claude'
          ? readClaudeTranscript(text, admission.admittedAt, quietFor)
          : readCodexRollout(text, admission.admittedAt, quietFor);
      if (reading.outcome !== 'undecided' && reading.neverReached && !named.includes(id)) continue;
      return { ...reading, sessionId: id };
    }
    return {
      outcome: 'undecided',
      detail: ids.length
        ? "the native session's record was not found on this machine"
        : 'no native session was recorded for the turn',
    };
  }
}
