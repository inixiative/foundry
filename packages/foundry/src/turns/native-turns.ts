/**
 * @atlas
 * @kind service
 * @partOf feature:threadTree
 */
import type { EventStream, NativeEvidence, ThreadMeta } from '@inixiative/foundry-core';
import { sha256Hex } from '@inixiative/foundry-core';
import type { LocalSessionStore } from '../persistence/local-session-store';
import type { NativeTurnControl, NativeTurnSink } from '../providers/session-backed';

interface ThreadRecord {
  readonly id: string;
  readonly meta: ThreadMeta;
}

type Lifecycle = NonNullable<Parameters<NativeTurnSink>[2]>;

export interface NativeTurnRecorderDeps {
  readonly store: LocalSessionStore;
  /** A thread known to this Foundry (the executor's thread the session runs under). */
  readonly thread: (id: string) => ThreadRecord | undefined;
  readonly events?: EventStream;
  /** A turn the runtime started ended on the thread: make the thread's new state visible. */
  readonly arrived?: (
    thread: ThreadRecord,
    turnId: string,
    outcome: 'completed' | 'failed',
  ) => void;
  /**
   * A turn the session started opened: make it live (Working, holding the thread's queue, stoppable).
   * Returns the handle that ends it, or null when the thread is already running a turn of its own.
   */
  readonly opened?: (
    thread: ThreadRecord,
    turnId: string,
    control: NativeTurnControl,
  ) => NativeTurnHandle | null;
  /** A tool call of the turn, paired with its result: what the turn did, for its guard. */
  readonly toolCalled?: (thread: ThreadRecord, turnId: string, call: NativeToolCall) => void;
  /** The turn ended with its final text: guard what it did and hand back what it said. */
  readonly ended?: (
    thread: ThreadRecord,
    turnId: string,
    outcome: 'completed' | 'failed',
    text: string,
  ) => void;
}

/** Ends a live native turn. */
export interface NativeTurnHandle {
  end(outcome: 'completed' | 'failed', text: string): void;
}

/** One tool call a native turn made, with its result once it came (`SubagentToolCall`'s shape). */
export interface NativeToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly ok?: boolean;
}

interface Open {
  readonly turnId: string;
  lastText?: string;
  live?: NativeTurnHandle | null;
  readonly calls: Map<string, { tool: string; input: Record<string, unknown> }>;
}

// `unknown` is a wake a message of the person's ended by starting: what it said stands.
const FAILED = new Set([
  'failed',
  'interrupted',
  'cancelled',
  'error',
  'timedOut',
  'rejected',
  'killed',
]);
/** The turns that run live on the thread: a Claude wake. Muse's own turns are only journalled. */
const LIVE_KINDS = new Set(['claude-wake']);
const idOf = (...parts: string[]) => sha256Hex(parts.join('\0')).slice(0, 24);

/**
 * Turns a thread's native session starts on its own, with no send from Foundry: Claude Code's wakes on a
 * background task's notification, Muse Code's cron firings, monitor and background-terminal wakes, goals
 * and messages from its other clients. Each becomes a turn on the thread itself (its trigger as the
 * opening message, its events as native evidence, its final text as the agent's answer), journalled and
 * pushed to the live stream the way an observed subagent's turn is (`turns/subagents.ts`, the same store
 * calls). It is live as Foundry's own turns are (`opened`: Working, the thread's queue held, stoppable,
 * paused by a restart), and its Wardens run on what it did (`toolCalled`, `ended`: guard, milestone and
 * hand-back). No advice is composed for it: no message was sent.
 */
export class NativeTurnRecorder {
  private readonly open = new Map<string, Open>();
  /** What woke each turn (its trigger), before its first event opens it. */
  private readonly woke = new Map<string, string>();
  /** Turns whose trigger described itself: a later bare kind never replaces those words. */
  private readonly described = new Set<string>();
  /** Each turn's kind, from its `started` lifecycle, which comes before any of its events. */
  private readonly kinds = new Map<string, string>();

  constructor(private readonly deps: NativeTurnRecorderDeps) {}

  /** One event of a turn the session under `threadId` started itself. */
  observe(
    threadId: string,
    evidence: NativeEvidence,
    task?: Lifecycle,
    control: NativeTurnControl = {},
  ): void {
    const thread = this.deps.thread(threadId);
    if (!thread) return;
    // The session ended: a turn it never reported the end of is closed as failed, never left active.
    if (evidence.kind === 'session_end') {
      for (const key of [...this.open.keys()])
        if (key.startsWith(`${thread.id}:`))
          this.end(thread, key, {
            phase: 'ended',
            taskId: key.slice(thread.id.length + 1),
            taskType: 'muse-turn',
            status: 'interrupted',
            reason: 'The session ended before the turn did.',
          });
      return;
    }
    const native = task?.taskId ?? evidence.turnId;
    if (!native) return;
    const key = `${thread.id}:${native}`;
    if (task) {
      if (task.taskType) this.kinds.set(key, task.taskType);
      // What woke it: the trigger's own words, else the trigger's kind once it is known.
      if (task.description) this.woke.set(key, task.description);
      else if (!this.described.has(key) && task.taskType !== 'muse-turn') {
        const trigger = triggerOfKind(task.taskType);
        if (trigger) this.woke.set(key, trigger);
        else this.woke.delete(key);
      }
      if (task.description) this.described.add(key);
      if (task.phase === 'ended') this.end(thread, key, task);
      return;
    }
    const run = this.start(thread, key, control);
    if (evidence.kind === 'text' && evidence.text && !evidence.parentToolUseId)
      run.lastText = evidence.text;
    this.deps.store.appendObservedNative(thread, run.turnId, evidence);
    this.changed(thread, run.turnId);
    if (!evidence.parentToolUseId) this.toolActivity(thread, run, evidence);
  }

  /** Pairs a tool call with its result and reports it once the result arrives. */
  private toolActivity(thread: ThreadRecord, run: Open, evidence: NativeEvidence): void {
    if (!this.deps.toolCalled || !evidence.callId) return;
    if (evidence.kind === 'tool_use' && evidence.toolName) {
      run.calls.set(evidence.callId, {
        tool: evidence.toolServer
          ? `${evidence.toolServer}/${evidence.toolName}`
          : evidence.toolName,
        input: (evidence.toolInput as Record<string, unknown> | undefined) ?? {},
      });
      return;
    }
    if (evidence.kind !== 'tool_result') return;
    const call = run.calls.get(evidence.callId);
    if (!call) return;
    run.calls.delete(evidence.callId);
    this.report(thread, run.turnId, {
      callId: evidence.callId,
      ...call,
      ...(evidence.toolOutput !== undefined ? { output: evidence.toolOutput } : {}),
      ...(evidence.toolError !== undefined ? { ok: !evidence.toolError } : {}),
    });
  }

  private report(thread: ThreadRecord, turnId: string, call: NativeToolCall): void {
    try {
      this.deps.toolCalled?.(thread, turnId, call);
    } catch {
      /* an observer's failure never touches the record */
    }
  }

  private start(thread: ThreadRecord, key: string, control: NativeTurnControl = {}): Open {
    const known = this.open.get(key);
    if (known) {
      // The thread was busy when it opened: it goes live once the thread is free.
      if (!known.live) this.goLive(thread, key, known, control);
      return known;
    }
    const run: Open = { turnId: `turn_${idOf(key)}`, calls: new Map() };
    this.open.set(key, run);
    const { content, foundryLine } = opening(this.woke.get(key));
    this.deps.store.startObservedTurn(thread, run.turnId, content, foundryLine);
    this.goLive(thread, key, run, control);
    this.changed(thread, run.turnId);
    return run;
  }

  private goLive(thread: ThreadRecord, key: string, run: Open, control: NativeTurnControl): void {
    const kind = this.kinds.get(key);
    if (!kind || !LIVE_KINDS.has(kind)) return;
    try {
      run.live = this.deps.opened?.(thread, run.turnId, control) ?? null;
    } catch {
      run.live = null;
    }
  }

  private end(thread: ThreadRecord, key: string, task: Lifecycle): void {
    const outcome = task.status && FAILED.has(task.status) ? 'failed' : 'completed';
    // A turn Muse dropped from its queue before it ran, or one that finished having emitted and said
    // nothing (Muse's skill, goal and verify reminders after every turn), left nothing to record.
    const empty = !this.open.has(key) && !task.summary;
    if (empty && (task.status === 'unqueued' || outcome === 'completed')) {
      this.forget(key);
      return;
    }
    const run = this.open.get(key) ?? this.start(thread, key);
    const text = task.summary ?? run.lastText ?? task.reason ?? '';
    this.deps.store.endObservedTurn(thread, run.turnId, text, outcome);
    this.open.delete(key);
    this.forget(key);
    this.changed(thread, run.turnId);
    // Calls whose result never came are still what the turn did.
    for (const [callId, call] of run.calls) this.report(thread, run.turnId, { callId, ...call });
    run.calls.clear();
    try {
      run.live?.end(outcome, text);
    } catch {
      /* the live view's failure never touches the record */
    }
    try {
      this.deps.ended?.(thread, run.turnId, outcome, text);
    } catch {
      /* an observer's failure never touches the record */
    }
    try {
      this.deps.arrived?.(thread, run.turnId, outcome);
    } catch {
      /* an observer's failure never touches the record */
    }
  }

  private forget(key: string): void {
    this.woke.delete(key);
    this.described.delete(key);
    this.kinds.delete(key);
  }

  private changed(thread: ThreadRecord, turnId: string): void {
    this.deps.events?.push({
      kind: 'journal',
      threadId: thread.id,
      projectId: thread.meta.projectId,
      turnId,
      scope: 'phase',
      outcome: 'durable',
      timestamp: Date.now(),
    });
  }
}

/**
 * The turn's opening message. It is stored where a person's message would be, so it says plainly that
 * no one typed it: the agent started the turn, woken by its trigger. Foundry's line names the trigger.
 */
function opening(trigger: string | undefined): { content: string; foundryLine: string } {
  return trigger
    ? {
        content: `The agent started this turn itself, woken by ${trigger}.`,
        foundryLine: `woken by ${clipped(trigger)}`,
      }
    : {
        content: 'The agent started this turn itself.',
        foundryLine: 'started by the agent session',
      };
}

const FOUNDRY_LINE_TRIGGER_MAX = 160;

/** A trigger short enough for the message list's summary, which drops long strings. */
function clipped(trigger: string): string {
  return trigger.length > FOUNDRY_LINE_TRIGGER_MAX
    ? `${trigger.slice(0, FOUNDRY_LINE_TRIGGER_MAX - 1)}…`
    : trigger;
}

/** The trigger from its kind alone (`muse-cron` → "a scheduled run"). */
function triggerOfKind(taskType?: string): string | undefined {
  const what: Record<string, string> = {
    'muse-cron': 'a scheduled run',
    'muse-monitor': 'a monitor',
    'muse-background-terminal': 'a background terminal finishing',
    'muse-overdue': 'an overdue notice',
    'muse-message': "a message from another of the session's clients",
    'muse-goal': 'its goal',
    'claude-wake': 'a background task finishing',
  };
  return taskType ? what[taskType] : undefined;
}
