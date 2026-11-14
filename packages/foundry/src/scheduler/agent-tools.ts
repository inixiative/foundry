/**
 * @atlas
 * @kind service
 * @partOf feature:scheduler
 */
import type { ThreadMeta } from '@inixiative/foundry-core';
import { z } from 'zod';
import { scopeOfRole } from '../prompts/instruction-settings';
import type { Scheduler, ScheduleView } from './scheduler';
import { type ScheduleWhere, scheduleSchema, scheduleWhereSchema } from './types';

/** `set_schedule`: a schedule as the agent writes it; Foundry keeps its due times and draft mark. */
export const setScheduleSchema = scheduleSchema
  .omit({ since: true, draft: true, scope: true })
  .extend({ where: scheduleWhereSchema.optional() });
export type SetScheduleInput = z.infer<typeof setScheduleSchema>;
export const removeScheduleSchema = z.strictObject({ id: z.string().min(1).max(63) });

/** What the agent tools reach: the scheduler, and whether the running turn is the owner's own. */
export interface ScheduleAgentDeps {
  scheduler: Pick<Scheduler, 'find' | 'list' | 'save' | 'remove'>;
  /** The owner typed the message that opened the running turn, and it took in no other party's words. */
  ownerInstructed(threadId: string): boolean;
  /** Ask the owner on the proposing thread (Needs-you), so a draft shows in Attention. */
  askOwner(threadId: string, text: string): void;
}

/** A thread's own Where: its project, else its scope, else Global. */
export const threadWhere = (meta: Pick<ThreadMeta, 'projectId' | 'role'>): ScheduleWhere => {
  if (meta.projectId) return { kind: 'project', projectId: meta.projectId };
  const scope = scopeOfRole(meta.role);
  return scope ? { kind: 'scope', scope } : { kind: 'global' };
};

/** The Needs-you line on a thread whose schedule waits for the owner. */
export const draftAsk = (name: string) => `Accept the schedule "${name}"? (Scheduled view)`;

const describeWhere = (where: ScheduleWhere) =>
  where.kind === 'project'
    ? `project ${where.projectId}`
    : where.kind === 'scope'
      ? `the ${where.scope} scope`
      : 'Global';

const describeView = (view: ScheduleView) =>
  `"${view.schedule.name}" (${view.schedule.id}) in ${describeWhere(view.where)}${
    view.schedule.draft
      ? ', a draft waiting for the owner'
      : view.schedule.paused
        ? ', paused'
        : view.nextDueAt
          ? `, next run ${new Date(view.nextDueAt).toISOString()}`
          : ''
  }`;

/**
 * Make or change a schedule for the agent. In a turn the owner's own message opened, it is made at
 * once: he told the agent to. Otherwise the agent decided on its own (or a run, a member's post or a
 * fork's task asked it), so it is saved as a draft that never runs until he accepts it, and the
 * thread asks him. A schedule that already runs is only the owner's to change.
 */
export async function setScheduleAsAgent(
  deps: ScheduleAgentDeps,
  threadId: string,
  meta: Pick<ThreadMeta, 'projectId' | 'role'>,
  input: SetScheduleInput,
): Promise<string> {
  const { where: asked, ...schedule } = input;
  const owner = deps.ownerInstructed(threadId);
  const existing = deps.scheduler.find(schedule.id);
  if (existing && !owner && existing.schedule.draft?.threadId !== threadId)
    throw Error(
      `${schedule.id} is ${existing.schedule.draft ? 'another thread’s draft' : 'already scheduled'}; only the owner changes it. Ask him, or pick another id.`,
    );
  const where = asked ?? existing?.where ?? threadWhere(meta);
  const saved = await deps.scheduler.save(
    { ...schedule, ...(owner ? {} : { draft: { threadId } }) },
    where,
  );
  if (owner) return `Scheduled ${describeView(saved)}. Its runs show in the Scheduled view.`;
  deps.askOwner(threadId, draftAsk(schedule.name));
  return `Drafted ${describeView(saved)}. It runs only once the owner accepts it in the Scheduled view; this thread now asks him. This turn was not his own instruction, so nothing was scheduled.`;
}

/** Remove a schedule for the agent: the owner's instruction, or its own draft. */
export async function removeScheduleAsAgent(
  deps: ScheduleAgentDeps,
  threadId: string,
  id: string,
): Promise<string> {
  const existing = deps.scheduler.find(id);
  if (!existing) throw Error(`No schedule ${id}`);
  if (!deps.ownerInstructed(threadId) && existing.schedule.draft?.threadId !== threadId)
    throw Error(`Only the owner removes ${id}: ask him, or he removes it in the Scheduled view.`);
  await deps.scheduler.remove(id);
  return `Removed ${existing.schedule.name} (${id}); its past runs stay in the history.`;
}

/** Every schedule, one line each, for the agent to read before it adds or changes one. */
export function listSchedulesForAgent(deps: ScheduleAgentDeps): string {
  const views = deps.scheduler.list();
  if (!views.length) return 'No schedules.';
  return views
    .map((view) => {
      const last = view.lastRun
        ? `; last run ${new Date(view.lastRun.dueAt).toISOString()} ${view.lastRun.outcome}${view.lastRun.reason ? ` (${view.lastRun.reason})` : ''}`
        : '';
      return `- ${describeView(view)}: ${JSON.stringify(view.schedule.when)}${last}`;
    })
    .join('\n');
}
