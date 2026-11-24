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
  ThreadArtifact,
  ThreadLoop,
  ThreadMeta,
  ThreadPlan,
  ToolResult,
} from '@inixiative/foundry-core';
import { SECRET_REFERENCE_PATTERN, scrubSecrets, threadTitle } from '@inixiative/foundry-core';
import { z } from 'zod';
import {
  listSchedulesForAgent,
  removeScheduleAsAgent,
  removeScheduleSchema,
  type ScheduleAgentDeps,
  type SetScheduleInput,
  setScheduleAsAgent,
  setScheduleSchema,
} from '../scheduler/agent-tools';

/**
 * The thread's own record, written by its agent through Foundry's MCP tools: the plan (`set_plan`,
 * `get_plan`, `clear_plan`), the loop (`set_loop`, `loop_round`, `stop_loop`), its name
 * (`rename_thread`) and where it stands (`set_status`). Each operation is a function of the thread
 * here; the viewer finds the live thread, runs it, then persists and publishes (`ThreadRecords`).
 * Artifacts (`set_artifact`) are what the agent makes to show the person: the thread lists them, and
 * each version's content is a journal row (`ARTIFACT_PHASE`), so the list stays small.
 * A technical row is the CLAUDE.md rule made visible: per concern, the existing primitive it uses
 * (reuse / extend / combine / refactor / migrate, with where it lives) or, for `new`, why none fits
 * and what would have made the closest one fit.
 */

const item = z.strictObject({
  text: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(4_000).optional(),
});
const outcomeStatus = z.enum(['todo', 'doing', 'done', 'you']);
/** One mark: an outcome named by its text or 1-based number, moved to a status. */
const planMarkItemSchema = z.strictObject({
  outcome: z.string().trim().min(1).max(300),
  status: outcomeStatus,
});
export const planPatchSchema = z
  .strictObject({
    outcomes: z
      .array(
        item.extend({
          status: outcomeStatus,
          group: z.string().trim().min(1).max(80).optional(),
        }),
      )
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
    mark: z.array(planMarkItemSchema).max(40).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Give at least one section');
export type PlanPatch = z.infer<typeof planPatchSchema>;

/** One outcome's move, as the person makes it by ticking in the Plan tab: the mark, with its actor. */
export const planMarkSchema = planMarkItemSchema;
export type PlanMark = z.infer<typeof planMarkSchema>;

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

/** The journal phase an artifact version is written to; its record is an `ArtifactVersionRecord`. */
export const ARTIFACT_PHASE = 'artifact' as const;
/** Bound on one version's content, in characters. */
export const ARTIFACT_CONTENT_LIMIT = 200_000;

export const artifactSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'a short slug: lowercase letters, digits and hyphens'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((text) => !/\p{Cc}/u.test(text), 'No control characters'),
  kind: z.enum(['markdown', 'mermaid', 'blueprint', 'html', 'code']),
  language: z.string().trim().min(1).max(40).optional(),
  content: z.string().min(1).max(ARTIFACT_CONTENT_LIMIT),
});
export type ArtifactInput = z.infer<typeof artifactSchema>;

/** One version of an artifact as the journal holds it. */
export interface ArtifactVersionRecord extends ArtifactInput {
  version: number;
}

/** Where artifact versions are kept: the thread's journal. */
export interface ArtifactJournal {
  /** Write one version; the turn that is running, if any, is recorded with it and returned. */
  write(thread: Thread, record: ArtifactVersionRecord): { turnId: string | null };
}

/** The journal row id of one artifact version. */
export const artifactVersionId = (threadId: string, artifactId: string, version: number) =>
  `${threadId}:artifact:${artifactId}:v${version}`;

/**
 * Write a version of an artifact: a new one, or the next version of the one with this id. The same
 * content, title and kind again is not a new version. The journal row is written before the list
 * changes, so the list never names a version the journal lacks.
 */
export function recordArtifact(
  thread: Thread,
  input: ArtifactInput,
  journal: ArtifactJournal,
  last?: ArtifactVersionRecord,
): { artifact: ThreadArtifact; written: boolean } {
  const artifacts = thread.meta.artifacts ?? [];
  const current = artifacts.find((a) => a.id === input.id);
  if (
    current &&
    last &&
    last.content === input.content &&
    last.title === input.title &&
    last.kind === input.kind &&
    last.language === input.language
  )
    return { artifact: current, written: false };
  const version = (current?.versions.at(-1)?.version ?? 0) + 1;
  const { turnId } = journal.write(thread, { ...input, version });
  const at = Date.now();
  const artifact: ThreadArtifact = {
    id: input.id,
    title: input.title,
    kind: input.kind,
    versions: [...(current?.versions ?? []), { version, turnId, at }],
    updatedAt: at,
  };
  thread.meta.artifacts = [...artifacts.filter((a) => a.id !== input.id), artifact];
  return { artifact, written: true };
}

/** Apply a patch to a thread's plan: given sections replace, others stay; empty sections start empty. */
export function applyPlanPatch(
  current: ThreadPlan | undefined,
  patch: PlanPatch,
  now = Date.now(),
): ThreadPlan {
  let outcomes = patch.outcomes ?? current?.outcomes ?? [];
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
    pains: patch.pains ?? current?.pains ?? [],
    strategy: patch.strategy ?? current?.strategy ?? [],
    reasons: patch.reasons ?? current?.reasons ?? [],
    technical: patch.technical ?? current?.technical ?? [],
    updatedAt: now,
  };
}

/** A plan whose work is finished: it has outcomes and every one is done. */
const finished = (plan: ThreadPlan) =>
  plan.outcomes.length > 0 && plan.outcomes.every((o) => o.status === 'done');

/**
 * Whether new work on this thread is due its agent's plan: none recorded, or the last plan's
 * outcomes all done (the next task starts). Foundry asks for one on such a turn.
 */
export function needsPlan(meta: Pick<ThreadMeta, 'plan'>): boolean {
  const plan = meta.plan;
  return !plan || finished(plan);
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'on',
  'with',
  'by',
  'from',
]);
// Greetings and pleasantries: a message made only of these carries no work to name a thread after.
const FILLER_WORDS = new Set([
  'hi',
  'hello',
  'hey',
  'hiya',
  'howdy',
  'yo',
  'sup',
  'there',
  'thanks',
  'thank',
  'thx',
  'you',
  'ok',
  'okay',
  'cool',
  'great',
  'nice',
  'good',
  'morning',
  'afternoon',
  'evening',
  'please',
  'how',
  'are',
  'is',
  'it',
  'going',
  'doing',
  'today',
  'test',
  'testing',
  'ping',
  'yes',
  'no',
  'sure',
]);

/** Whether a person's message names any work: something beyond greetings, pleasantries and filler. */
export function hasWorkContent(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some(
      (w) => w && !STOP_WORDS.has(w) && !FILLER_WORDS.has(w) && (w.length >= 3 || /\p{N}/u.test(w)),
    );
}

/** The longest name Foundry makes from a first message, in characters. */
export const FIRST_MESSAGE_NAME_MAX_CHARS = 60;

/** A scrubbed credential's marker (`[REDACTED:api-key]`, from `scrubSecrets`): never work to name a thread after. */
const REDACTED_MARKER = /\[REDACTED:[a-z-]+\]/g;

/**
 * A thread's first name, made from its first message's words with no model call (R-2026-11-19-10:
 * "As you're typing, the first sentence seems fine, and then the first turn should name it"). The name reaches places the message does not (sibling listings, Kingdom's
 * review link, local members' wake text), so credentials are scrubbed (`scrubSecrets`), lifted
 * secret references and code-fence markers dropped, and control and format characters (bidi
 * overrides, zero-width marks) removed. One line, cut at a word boundary to
 * `FIRST_MESSAGE_NAME_MAX_CHARS` code points, with an ellipsis when cut. Empty when nothing is left.
 */
export function firstMessageName(message: string): string {
  const words = scrubSecrets(
    message
      .replace(SECRET_REFERENCE_PATTERN, ' ')
      .replace(/(?:```|~~~)[\w+-]*/g, ' ')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' '),
  )
    .text.replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(words);
  if (points.length <= FIRST_MESSAGE_NAME_MAX_CHARS) return words;
  const cut = points.slice(0, FIRST_MESSAGE_NAME_MAX_CHARS + 1);
  const boundary = cut.lastIndexOf(' ');
  return `${cut
    .slice(0, boundary > 0 ? boundary : FIRST_MESSAGE_NAME_MAX_CHARS)
    .join('')
    .trimEnd()}…`;
}

/**
 * Name an unnamed thread from a person's message that names work (`hasWorkContent`, judged on what
 * would be the name; a greeting, or a message that is only a secret or a code fence, waits for the
 * next): the Foundry name, its first message's words. On a wrapped thread whose worker holds
 * Foundry's tools, its agent is asked to name it properly on that turn (`needsNameCheck`); an
 * unwrapped one keeps these words until its agent or person renames it. Returns whether it was named.
 */
export function nameThreadFromMessage(thread: Thread, message: string): boolean {
  if (thread.disposed || thread.meta.name?.text || thread.meta.foundryName) return false;
  const name = firstMessageName(message);
  if (!hasWorkContent(name.replace(REDACTED_MARKER, ' '))) return false;
  thread.meta.foundryName = { text: name, updatedAt: Date.now() };
  return true;
}

/** How long a thread's name stands before Foundry asks its agent to check it (Aron, 2026-11-18: "every 30 minutes"). */
export const NAME_CHECK_AFTER_MS = 30 * 60_000;

/**
 * Whether a turn asks the agent to name the thread: at once while it has only its first message's
 * words (`nameThreadFromMessage`), and for a name the agent gave, once it is `NAME_CHECK_AFTER_MS`
 * old. Either way at most once per `NAME_CHECK_AFTER_MS` (`askedAt`, when it was last asked). A
 * person's name is theirs; an unnamed thread has nothing to check yet.
 */
export function needsNameCheck(
  meta: Pick<ThreadMeta, 'name' | 'foundryName'>,
  askedAt: number,
  now: number = Date.now(),
): boolean {
  const named = meta.foundryName;
  if (meta.name?.text || !named) return false;
  const since = named.by === 'agent' ? Math.max(named.updatedAt, askedAt) : askedAt;
  return now - since >= NAME_CHECK_AFTER_MS;
}

/** Record a plan on the thread. An outcome the agent newly marks done is a milestone: the thread shows it as done. */
export function recordPlan(thread: Thread, patch: PlanPatch): ThreadPlan {
  const before = new Set(
    (thread.meta.plan?.outcomes ?? []).filter((o) => o.status === 'done').map((o) => o.text),
  );
  const plan = applyPlanPatch(thread.meta.plan, patch, Date.now());
  thread.meta.plan = plan;
  const reached = plan.outcomes.filter((o) => o.status === 'done' && !before.has(o.text)).at(-1);
  if (reached) thread.meta.done = { kind: 'milestone', text: reached.text, at: Date.now() };
  return plan;
}

/**
 * A person ticking an outcome in the Plan tab: the same `mark` through `applyPlanPatch`, but the
 * person is the actor, so it never creates the milestone an agent's newly-done outcome does in
 * `recordPlan`.
 */
export function markPlanOutcomeByPerson(
  thread: Thread,
  outcome: string,
  status: PlanMark['status'],
): ThreadPlan {
  const current = thread.meta.plan?.outcomes ?? [];
  const index = /^\d+$/.test(outcome)
    ? Number(outcome) - 1
    : current.findIndex((o) => o.text === outcome);
  const text = index >= 0 ? current[index]?.text : outcome;
  const plan = applyPlanPatch(thread.meta.plan, { mark: [{ outcome, status }] }, Date.now());
  thread.meta.plan = plan;
  // Reopening the outcome a milestone stands for clears it: the thread is not done with it any more.
  if (status !== 'done' && thread.meta.done?.kind === 'milestone' && thread.meta.done.text === text)
    delete thread.meta.done;
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

/** The thread as Foundry shows it: name, status, plan, loop and its artifacts (ids and newest versions). */
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
    artifacts: (meta.artifacts ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      version: a.versions.at(-1)?.version ?? 1,
    })),
  });
}

/** What the record tool reaches: the live thread, changed by `change`, then persisted and published. */
export interface ThreadRecords {
  update<T>(threadId: string, change: (thread: Thread) => T): T;
  read(threadId: string): Thread;
  /** The journal artifact versions go to; absent where nothing is journalled. */
  artifacts?: ArtifactJournal & {
    /** The newest version of one artifact, when it has one. */
    latest(threadId: string, artifactId: string): ArtifactVersionRecord | undefined;
  };
  /** This Foundry's schedules (scheduler/agent-tools.ts); absent where nothing is journalled. */
  schedules?: ScheduleAgentDeps;
}

export const THREAD_RECORD_TOOL_DESCRIPTION =
  "The thread's own record: plan, loop, name, status and artifacts. url = the operation (set_plan, get_plan, clear_plan, set_loop, loop_round, stop_loop, rename_thread, set_status, set_artifact, set_schedule, remove_schedule, list_schedules), body = its arguments.";

const scheduler = (records: ThreadRecords): ScheduleAgentDeps => {
  if (!records.schedules) throw Error('This Foundry keeps no journal, so it cannot hold schedules');
  return records.schedules;
};

/**
 * Each operation: its argument schema and what it does, as the sentence the agent reads back. `run`
 * reads or (with `write`) changes the thread's record; `act` reaches past it (its schedules).
 */
const OPERATIONS: Record<
  string,
  { schema: z.ZodType } & (
    | { write: boolean; run: (thread: Thread, body: never, records: ThreadRecords) => string }
    | { act: (thread: Thread, body: never, records: ThreadRecords) => Promise<string> }
  )
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
  set_artifact: {
    schema: artifactSchema,
    write: true,
    run: (thread, input: ArtifactInput, records) => {
      const journal = records.artifacts;
      if (!journal) throw Error('This Foundry keeps no journal, so it cannot hold artifacts');
      const { artifact, written } = recordArtifact(
        thread,
        input,
        journal,
        journal.latest(thread.id, input.id),
      );
      const version = artifact.versions.at(-1)!.version;
      return written
        ? `Artifact "${artifact.title}" saved as version ${version}; the person sees it in the Artifacts view and as a card on this turn.`
        : `Artifact "${artifact.title}" is unchanged at version ${version}.`;
    },
  },
  set_schedule: {
    schema: setScheduleSchema,
    act: (thread, input: SetScheduleInput, records) =>
      setScheduleAsAgent(scheduler(records), thread.id, thread.meta, input),
  },
  remove_schedule: {
    schema: removeScheduleSchema,
    act: (thread, { id }: { id: string }, records) =>
      removeScheduleAsAgent(scheduler(records), thread.id, id),
  },
  list_schedules: {
    schema: z.strictObject({}),
    write: false,
    run: (_thread, _body, records) => listSchedulesForAgent(scheduler(records)),
  },
};

export const THREAD_RECORD_OPERATIONS = Object.keys(OPERATIONS);

/** The tool ids `FeedbackInboxTool` answers, in the order the bridge registers them. */
export const FEEDBACK_TOOL_NAMES = ['feedback_inbox', 'feedback_item', 'feedback_status'] as const;

/**
 * Foundry's own tools that only write the thread's own record (plan, loop, name, status) or read
 * Foundry's context: bookkeeping the briefing asks for, not an action on the user's world, so they
 * never wait on an approval in any mode: the tool gate allows them (`turns/tool-gate.ts`) and a Codex thread's
 * launch pre-approves them (`appServerBridgeConfiguration`). A user's structural rule naming one still holds. Sends,
 * the conch, forks and Kingdom access are not here: they keep their own owner gates and the host's mode.
 */
export const FOUNDRY_OWN_TOOLS: ReadonlySet<string> = new Set([
  ...THREAD_RECORD_OPERATIONS,
  'ask_herald',
  'foundry_threads',
  'foundry_query',
  'foundry_conventions',
  'foundry_memory',
  'foundry_device',
  // A Feedback thread's inbox: reads, and archive or reopen (journalled, reversible).
  ...FEEDBACK_TOOL_NAMES,
  // The scratch pad's own tool only writes the person's secret where the agent says; secret_pipe runs a command, so it keeps the host's mode.
  'secret_scratch',
]);

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
      const body = parsed.data as never;
      const summary =
        'act' in operation
          ? await operation.act(records.read(threadId), body, records)
          : operation.write
            ? records.update(threadId, (thread) => operation.run(thread, body, records))
            : operation.run(records.read(threadId), body, records);
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
