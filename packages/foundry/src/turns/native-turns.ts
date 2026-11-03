/**
 * @atlas
 * @kind service
 * @partOf feature:threadTree
 */
import type { EventStream, NativeEvidence, ThreadMeta } from '@inixiative/foundry-core';
import { sha256Hex } from '@inixiative/foundry-core';
import type { LocalSessionStore } from '../persistence/local-session-store';
import type { NativeTurnSink } from '../providers/session-backed';

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
}

interface Open {
  readonly turnId: string;
  lastText?: string;
}

const FAILED = new Set(['failed', 'interrupted', 'cancelled', 'error', 'timedOut', 'rejected']);
const idOf = (...parts: string[]) => sha256Hex(parts.join('\0')).slice(0, 24);

/**
 * Turns a thread's native session starts on its own, with no send from Foundry: Muse Code's cron
 * firings, monitor and background-terminal wakes, goals and messages from its other clients. Each
 * becomes an observed turn on the thread itself (its trigger as the opening message, its events as
 * native evidence, its final text as the agent's answer), journalled and pushed to the live stream the
 * way an observed subagent's turn is (`turns/subagents.ts`, the same store calls). It runs no Wardens:
 * Foundry did not send it, so nothing was composed for it.
 */
export class NativeTurnRecorder {
  private readonly open = new Map<string, Open>();
  /** What woke each turn, before its first event opens it. */
  private readonly woke = new Map<string, string>();
  /** Turns whose trigger described itself: a later bare kind never replaces those words. */
  private readonly described = new Set<string>();

  constructor(private readonly deps: NativeTurnRecorderDeps) {}

  /** One event of a turn the session under `threadId` started itself. */
  observe(threadId: string, evidence: NativeEvidence, task?: Lifecycle): void {
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
      // What woke it: the trigger's own words, else the trigger's kind once it is known.
      if (task.description) this.woke.set(key, opening(task.description));
      else if (!this.described.has(key) && task.taskType !== 'muse-turn')
        this.woke.set(key, describe(task.taskType));
      if (task.description) this.described.add(key);
      if (task.phase === 'ended') this.end(thread, key, task);
      return;
    }
    const run = this.start(thread, key);
    if (evidence.kind === 'text' && evidence.text && !evidence.parentToolUseId)
      run.lastText = evidence.text;
    this.deps.store.appendObservedNative(thread, run.turnId, evidence);
    this.changed(thread, run.turnId);
  }

  private start(thread: ThreadRecord, key: string): Open {
    const known = this.open.get(key);
    if (known) return known;
    const run: Open = { turnId: `turn_${idOf(key)}` };
    this.open.set(key, run);
    this.deps.store.startObservedTurn(thread, run.turnId, this.woke.get(key) ?? describe());
    this.changed(thread, run.turnId);
    return run;
  }

  private end(thread: ThreadRecord, key: string, task: Lifecycle): void {
    const outcome = task.status && FAILED.has(task.status) ? 'failed' : 'completed';
    // A turn Muse dropped from its queue before it ran, or one that finished having emitted and said
    // nothing (Muse's skill, goal and verify reminders after every turn), left nothing to record.
    const empty = !this.open.has(key) && !task.summary;
    if (empty && (task.status === 'unqueued' || outcome === 'completed')) {
      this.woke.delete(key);
      this.described.delete(key);
      return;
    }
    const run = this.start(thread, key);
    const text = task.summary ?? run.lastText ?? task.reason ?? '';
    this.deps.store.endObservedTurn(thread, run.turnId, text, outcome);
    this.open.delete(key);
    this.woke.delete(key);
    this.described.delete(key);
    this.changed(thread, run.turnId);
    try {
      this.deps.arrived?.(thread, run.turnId, outcome);
    } catch {
      /* an observer's failure never touches the record */
    }
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
 * no one typed it: the agent started the turn, woken by its trigger.
 */
function opening(trigger: string): string {
  return `The agent started this turn itself, woken by ${trigger}.`;
}

/** The opening line from the trigger's kind alone (`muse-cron` → "a scheduled run"). */
function describe(taskType?: string): string {
  const what: Record<string, string> = {
    'muse-cron': 'a scheduled run',
    'muse-monitor': 'a monitor',
    'muse-background-terminal': 'a background terminal finishing',
    'muse-overdue': 'an overdue notice',
    'muse-message': "a message from another of the session's clients",
    'muse-goal': 'its goal',
  };
  const trigger = taskType ? what[taskType] : undefined;
  return trigger ? opening(trigger) : 'The agent started this turn itself.';
}
