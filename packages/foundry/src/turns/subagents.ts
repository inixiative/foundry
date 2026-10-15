import { createHash } from 'node:crypto';
import type { EventStream, NativeEvidence, ThreadMeta } from '@inixiative/foundry-core';
import type { LocalSessionStore } from '../persistence/local-session-store';

/**
 * Native subagents as observed child threads (docs/THREAD-TREE.md spec A, docs/reference/SUBAGENTS.md
 * §4): each run the executor's session spawns (a Claude Agent/Task, a Codex sub-agent) becomes a
 * child thread tied to its parent — the main thread, or the subagent that spawned it — with a
 * `handoff` row in the parent when it starts and a `handoff-return` row when it ends. Its own
 * activity is recorded on the child, never on the parent's turn. No Foundry middleware runs on it.
 */

interface ThreadRecord {
  readonly id: string;
  readonly meta: ThreadMeta;
}

export interface SubagentRecorderDeps {
  readonly store: LocalSessionStore;
  /** A thread known to this Foundry (the executor's thread a session runs under). */
  readonly thread: (id: string) => ThreadRecord | undefined;
  /** A new observed child thread: make it visible (directory, streams). */
  readonly adopt?: (child: ThreadRecord) => void;
  readonly events?: EventStream;
}

interface Run {
  readonly key: string;
  readonly child: ThreadRecord;
  readonly parent: ThreadRecord;
  readonly handoffId: string;
  readonly parentTurnId: string | null;
  readonly codex: boolean;
  turnId?: string;
  turns: number;
  lastText?: string;
}

const TASK_EXCERPT = 2_000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const idOf = (...parts: string[]) => sha(parts.join('\0')).slice(0, 24);

export class SubagentRecorder {
  /** Runs by the spawning tool call (`<root>:<tool use id>`) and by native task id. */
  private readonly byToolUse = new Map<string, Run>();
  private readonly byTask = new Map<string, Run>();
  /** A spawn issued inside a subagent: its call id, to the run that issued it (nesting). */
  private readonly spawnedInside = new Map<string, Run>();

  constructor(private readonly deps: SubagentRecorderDeps) {}

  /** One event from the executor's session running under `threadId` (the root of its tree). */
  observe(threadId: string, evidence: NativeEvidence): void {
    const root = this.deps.thread(threadId);
    if (!root) return;
    if (evidence.kind === 'subagent' && evidence.subagent) {
      this.lifecycle(root, evidence);
      return;
    }
    const parentCall = evidence.parentToolUseId;
    if (!parentCall) return;
    const run = this.byToolUse.get(`${root.id}:${parentCall}`);
    if (!run) return;
    // A spawn issued by this subagent: its child nests under it.
    if (evidence.kind === 'tool_use' && evidence.callId)
      this.spawnedInside.set(`${root.id}:${evidence.callId}`, run);
    if (!run.turnId) this.openTurn(run, '');
    if ((evidence.kind === 'text' || evidence.kind === 'result') && evidence.text)
      run.lastText = evidence.text;
    this.deps.store.appendObservedNative(run.child, run.turnId!, evidence);
    this.changed(run.child, run.turnId!);
    // A Codex child turn's end comes as a lifecycle update; Claude's as `ended`.
  }

  private lifecycle(root: ThreadRecord, evidence: NativeEvidence): void {
    const life = evidence.subagent!;
    const taskKey = `${root.id}:${life.taskId}`;
    let run = this.byTask.get(taskKey);
    if (life.phase === 'started' && !run) run = this.start(root, evidence);
    if (!run) return;
    if (life.phase === 'ended') this.end(run, life.status, life.summary, life.usage);
    else if (life.phase === 'updated' && run.codex && life.status && life.status !== 'inProgress')
      // A Codex child's turn ended; the sub-agent may get another (send input).
      this.closeTurn(run, life.status);
  }

  private start(root: ThreadRecord, evidence: NativeEvidence): Run {
    const life = evidence.subagent!;
    const codex = !!evidence.threadId && evidence.threadId === life.taskId;
    // The parent: the subagent that issued the spawn (by its task, or by the spawning call), else
    // the thread the session runs under.
    const parentRun =
      (life.parentTaskId ? this.byTask.get(`${root.id}:${life.parentTaskId}`) : undefined) ??
      (life.toolUseId ? this.spawnedInside.get(`${root.id}:${life.toolUseId}`) : undefined);
    const parent = parentRun?.child ?? root;
    const parentTurnId = parentRun?.turnId ?? this.deps.store.openTurn(parent.id)?.id ?? null;
    const childId = `sub_${idOf(root.id, life.taskId)}`;
    const handoffId = `handoff:${childId}`;
    const now = Date.now();
    const child: ThreadRecord = {
      id: childId,
      meta: {
        description: life.description ?? life.agentType ?? 'subagent',
        tags: [],
        status: 'active',
        ...(parent.meta.cwd ? { cwd: parent.meta.cwd } : {}),
        ...(parent.meta.branch ? { branch: parent.meta.branch } : {}),
        parentThreadId: parent.id,
        ...(parentTurnId ? { parentTurnId } : {}),
        spawn: {
          via: codex ? 'native-codex' : 'native-claude',
          ...(life.toolUseId ? { toolCallId: life.toolUseId } : {}),
          nativeTaskId: life.taskId,
          ...(life.agentType ? { agentType: life.agentType } : {}),
          ...(life.description ? { description: life.description } : {}),
          handoffId,
          observed: true,
        },
        depth: (parent.meta.depth ?? 0) + 1,
        ...(parent.meta.projectId ? { projectId: parent.meta.projectId } : {}),
        createdAt: now,
        lastActiveAt: now,
      },
    };
    this.deps.store.saveThread(child);
    const task = life.prompt ?? '';
    this.deps.store.appendPhase(parent, {
      id: handoffId,
      turnId: parentTurnId,
      dispatchId: null,
      phase: 'handoff',
      record: {
        childThreadId: childId,
        via: child.meta.spawn!.via,
        ...(life.toolUseId ? { toolCallId: life.toolUseId } : {}),
        nativeTaskId: life.taskId,
        ...(life.agentType ? { agentType: life.agentType } : {}),
        ...(life.description ? { description: life.description } : {}),
        depth: child.meta.depth,
        ...(typeof life.backgrounded === 'boolean' ? { backgrounded: life.backgrounded } : {}),
        task: { hash: sha(task), excerpt: task.slice(0, TASK_EXCERPT) },
        // The harness composed what this child received; Foundry did not.
        composition: null,
        observed: true,
      },
    });
    const run: Run = {
      key: `${root.id}:${life.taskId}`,
      child,
      parent,
      handoffId,
      parentTurnId,
      codex,
      turns: 0,
    };
    this.byTask.set(run.key, run);
    if (life.toolUseId) this.byToolUse.set(`${root.id}:${life.toolUseId}`, run);
    this.deps.adopt?.(child);
    this.openTurn(run, task);
    this.changed(parent, parentTurnId);
    return run;
  }

  private openTurn(run: Run, task: string): void {
    run.turns++;
    run.turnId = `turn_${idOf(run.child.id, String(run.turns))}`;
    this.deps.store.startObservedTurn(run.child, run.turnId, task);
  }

  private closeTurn(run: Run, status: string | undefined): void {
    if (!run.turnId) return;
    const failed = status === 'failed' || status === 'killed' || status === 'interrupted';
    this.deps.store.endObservedTurn(
      run.child,
      run.turnId,
      run.lastText ?? '',
      failed ? 'failed' : 'completed',
    );
    this.changed(run.child, run.turnId);
    run.turnId = undefined;
    run.lastText = undefined;
  }

  private end(
    run: Run,
    status: string | undefined,
    summary: string | undefined,
    usage: NonNullable<NativeEvidence['subagent']>['usage'],
  ): void {
    if (summary && !run.lastText) run.lastText = summary;
    const text = run.lastText ?? '';
    this.closeTurn(run, status);
    run.child.meta.status = 'idle';
    run.child.meta.lastActiveAt = Date.now();
    this.deps.store.saveThread(run.child);
    this.deps.store.appendPhase(run.parent, {
      id: `handoff-return:${run.child.id}`,
      turnId: run.parentTurnId,
      dispatchId: null,
      phase: 'handoff-return',
      record: {
        childThreadId: run.child.id,
        handoff: run.handoffId,
        outcome: status ?? 'completed',
        text: { hash: sha(text), excerpt: text.slice(0, TASK_EXCERPT) },
        turns: run.turns,
        ...(usage ? { usage } : {}),
        observed: true,
      },
    });
    this.byTask.delete(run.key);
    this.changed(run.parent, run.parentTurnId);
  }

  private changed(thread: ThreadRecord, turnId: string | null): void {
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
