/**
 * @atlas
 * @kind service
 * @partOf feature:threads
 */
import type { TaskLifecycle } from '@inixiative/agent-session';
import type { NativeEvidence } from '@inixiative/foundry-core';

/**
 * The background processes each thread's agent started (Claude Code background shells, monitors),
 * from the session's `task` lifecycle (agent-session `TaskLifecycle`). The command and its label
 * are the starting tool call's input (`toolUseId` → the journalled `tool_use`), read when listed.
 * Held in memory: a daemon restart ends the sessions, and their tasks with them.
 */

export interface RunningProcess {
  readonly taskId: string;
  readonly taskType: string;
  /** `running` until the task's end; then the native status (completed, failed, stopped, killed). */
  readonly state: string;
  readonly command: string | null;
  /** The starting call's own description, else the task's. */
  readonly label: string | null;
  readonly toolUseId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly summary: string | null;
  /** The session that runs it can stop it (Claude Code's `stop_task`). */
  readonly stoppable: boolean;
}

interface Entry {
  task: TaskLifecycle;
  startedAt: number;
  endedAt?: number;
  status?: string;
  summary?: string;
  stop?: () => Promise<void>;
  call?: NativeEvidence;
}

/** Finished tasks kept per thread, newest first beyond the running ones. */
const KEEP_FINISHED = 20;

export class RunningTasks {
  private readonly threads = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly toolUse: (
      threadId: string,
      callId: string,
    ) => NativeEvidence | undefined = () => undefined,
  ) {}

  observe(threadId: string, task: TaskLifecycle, at: number, stop?: () => Promise<void>): void {
    const tasks = this.threads.get(threadId) ?? new Map<string, Entry>();
    this.threads.set(threadId, tasks);
    const entry = tasks.get(task.taskId) ?? { task, startedAt: at };
    entry.task = { ...entry.task, ...task };
    if (stop) entry.stop = stop;
    if (task.phase === 'ended') {
      entry.endedAt = at;
      entry.status = task.status ?? 'completed';
      if (task.summary) entry.summary = task.summary;
      delete entry.stop;
    }
    tasks.set(task.taskId, entry);
    const finished = [...tasks.values()].filter((e) => e.endedAt !== undefined);
    for (const old of finished
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(KEEP_FINISHED))
      tasks.delete(old.task.taskId);
  }

  /** Running first (oldest first), then finished (newest first). */
  list(threadId: string): RunningProcess[] {
    const entries = [...(this.threads.get(threadId)?.values() ?? [])];
    const running = entries.filter((e) => e.endedAt === undefined);
    const finished = entries.filter((e) => e.endedAt !== undefined);
    return [
      ...running.sort((a, b) => a.startedAt - b.startedAt),
      ...finished.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    ].map((e) => this.view(threadId, e));
  }

  /** Ask the task's session to stop it; its end arrives as the task's lifecycle. */
  async stop(
    threadId: string,
    taskId: string,
  ): Promise<'stopping' | 'not-found' | 'ended' | 'unsupported'> {
    const entry = this.threads.get(threadId)?.get(taskId);
    if (!entry) return 'not-found';
    if (entry.endedAt !== undefined) return 'ended';
    if (!entry.stop) return 'unsupported';
    await entry.stop();
    return 'stopping';
  }

  private view(threadId: string, e: Entry): RunningProcess {
    if (!e.call && e.task.toolUseId) e.call = this.toolUse(threadId, e.task.toolUseId);
    const input = (e.call?.toolInput ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return {
      taskId: e.task.taskId,
      taskType: e.task.taskType,
      state: e.endedAt === undefined ? 'running' : (e.status ?? 'completed'),
      command: text(input.command) ?? text(input.cmd),
      label: text(input.description) ?? text(e.task.description),
      toolUseId: e.task.toolUseId ?? null,
      startedAt: e.startedAt,
      endedAt: e.endedAt ?? null,
      summary: e.summary ?? null,
      stoppable: e.endedAt === undefined && !!e.stop,
    };
  }
}
