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
/** Clock skew allowed between Foundry's admission time and the runtime's own timestamps. */
const ADMISSION_SKEW_MS = 5_000;
const CLAUDE_DONE = new Set(['end_turn', 'stop_sequence', 'refusal']);

export type NativeRecordReading =
  | { outcome: 'completed' | 'interrupted'; detail: string }
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

/** A Claude Code transcript: did the turn admitted at `admittedAt` finish? */
export function readClaudeTranscript(
  text: string,
  admittedAt: number,
  quiet: boolean,
): NativeRecordReading {
  const turn = lines(text).filter(
    (entry) =>
      (entry.type === 'user' || entry.type === 'assistant') &&
      !(time(entry) < admittedAt - ADMISSION_SKEW_MS),
  );
  if (!turn.some((entry) => entry.type === 'user'))
    return quiet
      ? { outcome: 'interrupted', detail: 'the message never reached the native session' }
      : { outcome: 'undecided', detail: 'the native session has not recorded the message yet' };
  const last = turn.at(-1)!;
  const message = last.message as { stop_reason?: unknown } | undefined;
  if (last.type === 'assistant' && CLAUDE_DONE.has(String(message?.stop_reason)))
    return { outcome: 'completed', detail: 'the native session finished its answer' };
  return quiet
    ? { outcome: 'interrupted', detail: 'the native session stopped part-way through the turn' }
    : { outcome: 'undecided', detail: 'the native session may still be working' };
}

/** A Codex rollout: the last task event after the admission says how the turn ended. */
export function readCodexRollout(
  text: string,
  admittedAt: number,
  quiet: boolean,
): NativeRecordReading {
  const events = lines(text)
    .filter(
      (entry) => entry.type === 'event_msg' && !(time(entry) < admittedAt - ADMISSION_SKEW_MS),
    )
    .map((entry) => (entry.payload as { type?: unknown } | undefined)?.type)
    .filter(
      (type) => type === 'task_started' || type === 'task_complete' || type === 'turn_aborted',
    );
  const last = events.at(-1);
  if (last === 'task_complete')
    return { outcome: 'completed', detail: 'the native session finished its answer' };
  if (last === 'turn_aborted')
    return { outcome: 'interrupted', detail: 'the native session aborted the turn' };
  if (!quiet) return { outcome: 'undecided', detail: 'the native session may still be working' };
  return {
    outcome: 'interrupted',
    detail: last
      ? 'the native session stopped part-way through the turn'
      : 'the message never reached the native session',
  };
}

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
  quietMs?: number;
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
    const unsettled = store.unsettledAdmissions(threadId);
    if (!unsettled.length) return pass;
    const homes = this.options.homes();
    for (const admission of unsettled) {
      const reading = this.read(threadId, admission, homes);
      if (reading.outcome === 'undecided') {
        pass.undecided.push({ turnId: admission.turnId, detail: reading.detail });
        continue;
      }
      store.settleAdmission(threadId, admission.admissionId, {
        outcome: reading.outcome,
        by: 'native-record',
        detail: reading.detail,
        ...(reading.sessionId ? { nativeSessionId: reading.sessionId } : {}),
      });
      pass.settled.push({ turnId: admission.turnId, outcome: reading.outcome });
    }
    return pass;
  }

  /** The owner decides: `continue` accepts the lost turn as it stands, `retry` settles it to send again. */
  resolveByOwner(threadId: string, action: 'continue' | 'retry'): UnsettledAdmission[] {
    const unsettled = this.options.store.unsettledAdmissions(threadId);
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
    const ids = [
      admission.nativeSessionId,
      admission.externalSessionId,
      ...(this.options.boundSessions?.(threadId) ?? []),
    ].filter((id, index, all): id is string => !!id && all.indexOf(id) === index);
    for (const id of ids) {
      const record = locateNativeRecord(id, homes);
      if (!record) continue;
      let text: string;
      let modified: number;
      try {
        text = readFileSync(record.path, 'utf8');
        modified = statSync(record.path).mtimeMs;
      } catch {
        continue;
      }
      const quiet =
        (this.options.now?.() ?? Date.now()) - modified >=
        (this.options.quietMs ?? NATIVE_RECORD_QUIET_MS);
      const reading =
        record.kind === 'claude'
          ? readClaudeTranscript(text, admission.admittedAt, quiet)
          : readCodexRollout(text, admission.admittedAt, quiet);
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
