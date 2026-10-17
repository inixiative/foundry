import { createHash } from 'node:crypto';
import type { EventStream, NativeEvidence, ThreadMeta } from '@inixiative/foundry-core';
import type { LocalSessionStore } from '../persistence/local-session-store';

/**
 * Native subagents as observed child threads (docs/THREAD-TREE.md spec A): each run the executor's session spawns (a Claude Agent/Task, a Codex sub-agent) becomes a
 * child thread tied to its parent — the main thread, or the subagent that spawned it — with a
 * `handoff` row in the parent when it starts and a `handoff-return` row when it ends. Its own
 * activity is recorded on the child, never on the parent's turn. The child runs no Wardens of its
 * own: the root thread's chorus briefs the handoff when it starts (`onSpawn`, the subagent-spawn
 * trigger) and, in the in-session runtime, guards each of its turns once when the turn ends
 * (`observeTool` holds the calls, `onTurnEnd` fires the guard), on the child's node.
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
  /**
   * A subagent's tool call and its result: the root thread's Wardens guard it like the main
   * thread's own, and journal on the subagent's node.
   */
  readonly observeTool?: (rootThreadId: string, call: SubagentToolCall) => void;
  /** A subagent's turn ended: the root thread's guard runs once over the calls held for it. */
  readonly onTurnEnd?: (rootThreadId: string, turn: SubagentTurnEnd) => void;
  /** A subagent started: the root thread's Wardens brief the handoff from the task it was given. */
  readonly onSpawn?: (rootThreadId: string, spawn: SubagentSpawn) => void;
}

/** One observed subagent turn that ended, for the root thread's guard. */
export interface SubagentTurnEnd {
  readonly node: ThreadRecord;
  readonly turnId: string;
  readonly outcome: 'completed' | 'failed';
}

/** One handoff the executor made, as the subagent-spawn trigger sees it. */
export interface SubagentSpawn {
  /** The child thread the subagent became. */
  readonly node: ThreadRecord;
  /** The node that issued the spawn: the root thread, or a subagent. */
  readonly parent: ThreadRecord;
  readonly parentTurnId: string | null;
  readonly handoffId: string;
  readonly description?: string;
  readonly agentType?: string;
  /** The task text the subagent starts from. */
  readonly prompt: string;
}

/** One finished tool call of an observed subagent, for the root thread's guard Wardens. */
export interface SubagentToolCall {
  readonly node: ThreadRecord;
  readonly turnId: string | null;
  readonly callId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly ok?: boolean;
}

interface Run {
  readonly key: string;
  /** The thread the session runs under (the root of the tree). */
  readonly root: string;
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
  /** Tool calls a subagent began, by `<root>:<call id>`, until their result. */
  private readonly toolCalls = new Map<string, { tool: string; input: Record<string, unknown> }>();

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
    this.guard(root, run, evidence);
    // A Codex child turn's end comes as a lifecycle update; Claude's as `ended`.
  }

  /** Pair a subagent's tool call with its result and hand it to the root thread's guards. */
  private guard(root: ThreadRecord, run: Run, evidence: NativeEvidence): void {
    if (!this.deps.observeTool || !evidence.callId) return;
    const key = `${root.id}:${evidence.callId}`;
    if (evidence.kind === 'tool_use' && evidence.toolName) {
      this.toolCalls.set(key, {
        tool: evidence.toolServer
          ? `${evidence.toolServer}/${evidence.toolName}`
          : evidence.toolName,
        input: (evidence.toolInput as Record<string, unknown> | undefined) ?? {},
      });
      return;
    }
    if (evidence.kind !== 'tool_result') return;
    const call = this.toolCalls.get(key);
    if (!call) return;
    this.toolCalls.delete(key);
    try {
      this.deps.observeTool(root.id, {
        node: run.child,
        turnId: run.turnId ?? null,
        callId: evidence.callId,
        ...call,
        ...(evidence.toolOutput !== undefined ? { output: evidence.toolOutput } : {}),
        ...(evidence.toolError !== undefined ? { ok: !evidence.toolError } : {}),
      });
    } catch {
      /* a guard's failure never touches the record */
    }
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
    // Codex reports a spawn with its parent thread's identity; Claude subagent events carry none.
    const codex = !!evidence.threadId;
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
      root: root.id,
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
    try {
      this.deps.onSpawn?.(root.id, {
        node: child,
        parent,
        parentTurnId,
        handoffId,
        ...(life.description ? { description: life.description } : {}),
        ...(life.agentType ? { agentType: life.agentType } : {}),
        prompt: task,
      });
    } catch {
      /* a brief's failure never touches the record */
    }
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
    try {
      this.deps.onTurnEnd?.(run.root, {
        node: run.child,
        turnId: run.turnId,
        outcome: failed ? 'failed' : 'completed',
      });
    } catch {
      /* a guard's failure never touches the record */
    }
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
    const call = run.child.meta.spawn?.toolCallId;
    if (call) this.byToolUse.delete(`${run.root}:${call}`);
    for (const [key, owner] of this.spawnedInside)
      if (owner === run) this.spawnedInside.delete(key);
    // The directory's thread shows the run ended.
    this.deps.adopt?.(run.child);
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
