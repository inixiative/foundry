/**
 * @atlas
 * @kind adapter
 * @partOf feature:threads, primitive:tools
 */
import type {
  ApiRequest,
  ApiResponse,
  ApiTool,
  OwnershipScope,
  Thread,
  ThreadLoop,
  ThreadMeta,
  ThreadPlan,
  ToolResult,
} from '@inixiative/foundry-core';
import { threadTitle } from '@inixiative/foundry-core';
import { z } from 'zod';

/**
 * The thread's own record, written by its agent through Foundry's MCP tools: the plan (`set_plan`,
 * `get_plan`, `clear_plan`), the loop (`set_loop`, `loop_round`, `stop_loop`), its name
 * (`rename_thread`) and where it stands (`set_status`). Each operation is a function of the thread
 * here; the viewer finds the live thread, runs it, then persists and publishes (`ThreadRecords`).
 * A technical row is the CLAUDE.md rule made visible: per concern, the existing primitive it uses
 * (reuse / extend / combine / refactor / migrate, with where it lives) or, for `new`, why none fits
 * and what would have made the closest one fit.
 */

const item = z.strictObject({
  text: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(4_000).optional(),
});
const outcomeStatus = z.enum(['todo', 'doing', 'done', 'you']);
export const planPatchSchema = z
  .strictObject({
    outcomes: z
      .array(item.extend({ status: outcomeStatus }))
      .max(40)
      .optional(),
    pains: z.array(item).max(20).optional(),
    strategy: z.array(item).max(30).optional(),
    reasons: z.array(item).max(20).optional(),
    technical: z
      .array(
        z.strictObject({
          concern: z.string().trim().min(1).max(120),
          decision: z.enum(['reuse', 'extend', 'new', 'combine', 'refactor', 'migrate', 'none']),
          system: z.string().trim().min(1).max(200),
          path: z.string().trim().min(1).max(400).optional(),
          reason: z.string().trim().min(1).max(2_000),
        }),
      )
      .max(40)
      .optional(),
    /** Move outcomes to a status without resending the list: each names an outcome by its text or its 1-based number. */
    mark: z
      .array(z.strictObject({ outcome: z.string().trim().min(1).max(300), status: outcomeStatus }))
      .max(40)
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Give at least one section');
export type PlanPatch = z.infer<typeof planPatchSchema>;

export const loopSchema = z.strictObject({
  goal: z.string().trim().min(1).max(300),
  steps: z.array(item).min(1).max(12),
  until: z.string().trim().min(1).max(500),
  maxRounds: z.number().int().min(1).max(100).optional(),
});
export type LoopDefinition = z.infer<typeof loopSchema>;

export const loopRoundSchema = z.strictObject({
  result: z.enum(['pass', 'fail', 'partial']),
  note: z.string().trim().min(1).max(2_000),
});
export const loopStopSchema = z.strictObject({
  result: z.enum(['done', 'stopped']),
  reason: z.string().trim().min(1).max(2_000),
});

/** A thread name an agent gives: the outcome in a few plain words (the labeling rules). */
export const renameSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .refine((text) => !/\p{Cc}/u.test(text), 'No control characters'),
});

/** What the agent may say about where it stands. Working, queued, failed, approvals and archived are Foundry's. */
export const statusSchema = z.strictObject({
  status: z.enum(['needs-you', 'blocked', 'done', 'clear']),
  text: z.string().trim().min(1).max(300).optional(),
});

/** Apply a patch to a thread's plan: given sections replace, others stay; empty sections start empty. */
export function applyPlanPatch(
  current: ThreadPlan | undefined,
  patch: PlanPatch,
  now = Date.now(),
  draftedBy: 'agent' | 'foundry' = 'agent',
): ThreadPlan {
  // The agent's first plan replaces a Foundry draft whole: no section of the draft survives as the agent's.
  const base = current?.draftedBy === 'foundry' && draftedBy === 'agent' ? undefined : current;
  let outcomes = patch.outcomes ?? base?.outcomes ?? [];
  for (const { outcome, status } of patch.mark ?? []) {
    const index = /^\d+$/.test(outcome)
      ? Number(outcome) - 1
      : outcomes.findIndex((o) => o.text === outcome);
    if (index < 0 || index >= outcomes.length)
      throw Error(`No outcome "${outcome}" in the plan: name it by its exact text or its number`);
    outcomes = outcomes.map((o, i) => (i === index ? { ...o, status } : o));
  }
  return {
    outcomes,
    pains: patch.pains ?? base?.pains ?? [],
    strategy: patch.strategy ?? base?.strategy ?? [],
    reasons: patch.reasons ?? base?.reasons ?? [],
    technical: patch.technical ?? base?.technical ?? [],
    draftedBy,
    updatedAt: now,
  };
}

/** A plan whose work is finished: it has outcomes and every one is done. */
const finished = (plan: ThreadPlan) =>
  plan.outcomes.length > 0 && plan.outcomes.every((o) => o.status === 'done');

/**
 * Whether new work on this thread is due its agent's plan: none recorded, only Foundry's draft, or
 * the last plan's outcomes all done (the next task starts). Foundry asks for one on such a turn.
 */
export function needsPlan(meta: Pick<ThreadMeta, 'plan'>): boolean {
  const plan = meta.plan;
  return !plan || plan.draftedBy === 'foundry' || finished(plan);
}

/** Whether Foundry should draft one after such a turn: its agent recorded none and no draft is there. */
export function wantsDraft(meta: Pick<ThreadMeta, 'plan'>): boolean {
  const plan = meta.plan;
  return !plan || (plan.draftedBy !== 'foundry' && finished(plan));
}

/** Record a plan on the thread. An outcome the agent newly marks done is a milestone: the thread shows it as done. */
export function recordPlan(
  thread: Thread,
  patch: PlanPatch,
  draftedBy: 'agent' | 'foundry' = 'agent',
): ThreadPlan {
  const before = new Set(
    (thread.meta.plan?.outcomes ?? []).filter((o) => o.status === 'done').map((o) => o.text),
  );
  const plan = applyPlanPatch(thread.meta.plan, patch, Date.now(), draftedBy);
  thread.meta.plan = plan;
  const reached =
    draftedBy === 'agent'
      ? plan.outcomes.filter((o) => o.status === 'done' && !before.has(o.text)).at(-1)
      : undefined;
  if (reached) thread.meta.done = { kind: 'milestone', text: reached.text, at: Date.now() };
  return plan;
}

/** Start a loop, or revise the running one (its rounds so far are kept). */
export function recordLoop(thread: Thread, definition: LoopDefinition): ThreadLoop {
  const now = Date.now();
  const running = thread.meta.loop?.state === 'running' ? thread.meta.loop : undefined;
  const loop: ThreadLoop = {
    goal: definition.goal,
    steps: definition.steps,
    until: definition.until,
    ...(definition.maxRounds ? { maxRounds: definition.maxRounds } : {}),
    rounds: running?.rounds ?? [],
    state: 'running',
    startedAt: running?.startedAt ?? now,
    updatedAt: now,
  };
  thread.meta.loop = loop;
  return loop;
}

/** Record a round of the running loop. */
export function recordLoopRound(
  thread: Thread,
  round: z.infer<typeof loopRoundSchema>,
): ThreadLoop {
  const loop = thread.meta.loop;
  if (loop?.state !== 'running')
    throw Error('No loop is running on this thread: start one with set_loop');
  const now = Date.now();
  const next: ThreadLoop = {
    ...loop,
    rounds: [...loop.rounds, { round: loop.rounds.length + 1, ...round, at: now }],
    updatedAt: now,
  };
  thread.meta.loop = next;
  return next;
}

/** End the running loop: `done` when its stop condition held, `stopped` otherwise. */
export function stopLoop(thread: Thread, stop: z.infer<typeof loopStopSchema>): ThreadLoop {
  const loop = thread.meta.loop;
  if (loop?.state !== 'running') throw Error('No loop is running on this thread');
  const next: ThreadLoop = {
    ...loop,
    state: stop.result,
    stopReason: stop.reason,
    updatedAt: Date.now(),
  };
  thread.meta.loop = next;
  return next;
}

/** Rename the thread as its agent: the Foundry name. A person's name is theirs and stays. */
export function renameThread(thread: Thread, name: string): string {
  if (thread.meta.name?.text)
    throw Error(
      `The person named this thread "${thread.meta.name.text}"; it keeps their name. Ask them if it should change.`,
    );
  thread.meta.foundryName = { text: name, updatedAt: Date.now(), by: 'agent' };
  return name;
}

/** Set where the agent says the thread stands. */
export function setAgentStatus(thread: Thread, change: z.infer<typeof statusSchema>): string {
  const { status, text } = change;
  if (status === 'clear') {
    delete thread.meta.agentStatus;
    if (thread.meta.done?.kind === 'milestone') delete thread.meta.done;
    return 'Status cleared: Foundry shows what it sees.';
  }
  if (!text)
    throw Error(
      `Say in a line what ${status === 'done' ? 'is done' : status === 'blocked' ? 'blocks you' : 'you need from the person'}`,
    );
  if (status === 'done') {
    delete thread.meta.agentStatus;
    thread.meta.done = { kind: 'milestone', text, at: Date.now() };
    return `Status: done (${text}).`;
  }
  thread.meta.agentStatus = { state: status, text, at: Date.now() };
  return `Status: ${status === 'needs-you' ? 'needs the person' : 'blocked'} (${text}). The owner's next message clears it.`;
}

/** The thread as Foundry shows it: name, status, plan and loop. */
export function describeRecord(thread: Thread): string {
  const meta = thread.meta;
  const title = threadTitle(meta);
  return JSON.stringify({
    name: title
      ? { text: title.text, by: title.source === 'human' ? 'person' : title.source }
      : null,
    status: meta.agentStatus ?? (meta.done ? { state: 'done', text: meta.done.text } : null),
    plan: meta.plan ?? null,
    loop: meta.loop ?? null,
  });
}

/** What the record tool reaches: the live thread, changed by `change`, then persisted and published. */
export interface ThreadRecords {
  update<T>(threadId: string, change: (thread: Thread) => T): T;
  read(threadId: string): Thread;
}

export const THREAD_RECORD_TOOL_DESCRIPTION =
  "The thread's own record: plan, loop, name and status. url = the operation (set_plan, get_plan, clear_plan, set_loop, loop_round, stop_loop, rename_thread, set_status), body = its arguments.";

/** Each operation: its argument schema and what it does to the thread, as the sentence the agent reads back. */
const OPERATIONS: Record<
  string,
  { schema: z.ZodType; write: boolean; run: (thread: Thread, body: never) => string }
> = {
  set_plan: {
    schema: planPatchSchema,
    write: true,
    run: (thread, patch: PlanPatch) => {
      const plan = recordPlan(thread, patch);
      return `Plan recorded: ${plan.outcomes.length} outcomes, ${plan.technical.length} technical decisions.`;
    },
  },
  get_plan: { schema: z.strictObject({}), write: false, run: (thread) => describeRecord(thread) },
  clear_plan: {
    schema: z.strictObject({}),
    write: true,
    run: (thread) => {
      delete thread.meta.plan;
      return 'Plan cleared.';
    },
  },
  set_loop: {
    schema: loopSchema,
    write: true,
    run: (thread, definition: LoopDefinition) => {
      const loop = recordLoop(thread, definition);
      return `Loop running: ${loop.steps.length} steps a round, until ${loop.until}${loop.rounds.length ? ` (${loop.rounds.length} rounds so far)` : ''}.`;
    },
  },
  loop_round: {
    schema: loopRoundSchema,
    write: true,
    run: (thread, round: z.infer<typeof loopRoundSchema>) => {
      const loop = recordLoopRound(thread, round);
      const n = loop.rounds.length;
      if (loop.maxRounds && n >= loop.maxRounds && round.result !== 'pass')
        return `Round ${n} recorded (${round.result}). That is the loop's limit of ${loop.maxRounds}: stop it (stop_loop) and tell the person where it stands.`;
      return `Round ${n} recorded (${round.result}).`;
    },
  },
  stop_loop: {
    schema: loopStopSchema,
    write: true,
    run: (thread, stop: z.infer<typeof loopStopSchema>) => {
      const loop = stopLoop(thread, stop);
      return `Loop ${loop.state} after ${loop.rounds.length} rounds.`;
    },
  },
  rename_thread: {
    schema: renameSchema,
    write: true,
    run: (thread, { name }: { name: string }) => `Thread renamed: ${renameThread(thread, name)}.`,
  },
  set_status: {
    schema: statusSchema,
    write: true,
    run: (thread, change: z.infer<typeof statusSchema>) => setAgentStatus(thread, change),
  },
};

export const THREAD_RECORD_OPERATIONS = Object.keys(OPERATIONS);

export class ThreadRecordTool implements ApiTool {
  readonly id = 'thread';
  readonly kind = 'api' as const;
  readonly capability = 'net:api' as const;
  constructor(
    private readonly resolve: () => ThreadRecords | null,
    private readonly scope: OwnershipScope = {},
  ) {}
  scoped(scope: OwnershipScope): ThreadRecordTool {
    return new ThreadRecordTool(this.resolve, scope);
  }
  async request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>> {
    const started = performance.now();
    try {
      const threadId = this.scope.threadId;
      if (!threadId) throw Error('This tool runs only inside a thread');
      const operation = OPERATIONS[req.url];
      if (!operation) throw Error(`Use one of ${THREAD_RECORD_OPERATIONS.join(', ')}`);
      const records = this.resolve();
      if (!records) throw Error("This Foundry is not recording threads' plans");
      const parsed = operation.schema.safeParse(req.body ?? {});
      if (!parsed.success)
        throw Error(
          `Not recorded: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      const run = (thread: Thread) => operation.run(thread, parsed.data as never);
      const summary = operation.write ? records.update(threadId, run) : run(records.read(threadId));
      return {
        ok: true,
        summary,
        data: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: { result: summary } as T,
          durationMs: Math.round(performance.now() - started),
        },
      };
    } catch (error) {
      return { ok: false, summary: (error as Error).message, error: (error as Error).message };
    }
  }
  get<T = unknown>(url: string) {
    return this.request<T>({ url, method: 'GET' });
  }
  post<T = unknown>(url: string, body: unknown) {
    return this.request<T>({ url, body, method: 'POST' });
  }
  put<T = unknown>(url: string, body: unknown) {
    return this.request<T>({ url, body, method: 'PUT' });
  }
  delete<T = unknown>(url: string) {
    return this.request<T>({ url, method: 'DELETE' });
  }
}
