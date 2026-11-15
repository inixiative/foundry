/**
 * @atlas
 * @kind type
 * @partOf feature:scheduler
 */
import { REASONING_EFFORTS } from '@inixiative/foundry-core';
import { z } from 'zod';
import { SCOPE_ROLES } from '../prompts/instruction-settings';

/**
 * When a schedule is due: every N minutes, hours or days from when it was set; a cron line (five
 * fields, in a time zone); or once, at a time.
 */
export const scheduleWhenSchema = z.union([
  z.strictObject({
    every: z.string().regex(/^[1-9]\d{0,3}[mhd]$/, 'is a count and a unit: 15m, 2h, 1d'),
  }),
  z.strictObject({ cron: z.string().min(9).max(120), tz: z.string().min(1).max(64).optional() }),
  z.strictObject({ at: z.iso.datetime({ offset: true }) }),
]);
export type ScheduleWhen = z.infer<typeof scheduleWhenSchema>;

/** The shortest `every`: a schedule is work, not a poll. */
export const MIN_EVERY_MS = 5 * 60_000;

export const scheduleSchema = z.strictObject({
  /** Unique across this Foundry's schedules: the run ids and the history key on it. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'is lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(200),
  /** What each run is asked: the first message of its thread. */
  prompt: z.string().trim().min(1).max(20_000),
  when: scheduleWhenSchema,
  /** The worker, role, model and effort its runs start on; absent, the Where's defaults. */
  worker: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(REASONING_EFFORTS).optional(),
  /** A top-level schedule's scope (Forge Master, Feedback); absent, Global. Never on a project's. */
  scope: z.enum(Object.keys(SCOPE_ROLES) as [keyof typeof SCOPE_ROLES]).optional(),
  paused: z.boolean().optional(),
  /**
   * Due times count from here (epoch ms): set when the schedule is made, and again when its time
   * changes or it is resumed, so nothing it missed while off runs.
   */
  since: z.number().int().nonnegative(),
  /**
   * An agent proposed it in a turn the owner didn't open: it never runs until he accepts it in the
   * viewer (or the thread's prompt). The thread that proposed it.
   */
  draft: z.strictObject({ threadId: z.string().min(1) }).optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** The `scheduler` setting: this Foundry's own (Global and scopes) or a project's. Never in a repository. */
export const schedulerSettingsSchema = z.strictObject({
  schedules: z.array(scheduleSchema).max(200).optional(),
});
export type SchedulerSettings = z.infer<typeof schedulerSettingsSchema>;

/** Where a schedule lives, and so where its runs go: a project, Global, or a scope. */
export const scheduleWhereSchema = z.union([
  z.strictObject({ kind: z.literal('project'), projectId: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('scope'),
    scope: z.enum(Object.keys(SCOPE_ROLES) as [keyof typeof SCOPE_ROLES]),
  }),
]);
export type ScheduleWhere = z.infer<typeof scheduleWhereSchema>;

/** What happened at one due time. `started` has a thread; the rest say why not. */
export type ScheduleRunOutcome = 'started' | 'skipped' | 'failed';
export type ScheduleSkipReason = 'missed' | 'overlap';

export interface ScheduleRun {
  /** `schedule:<scheduleId>:<dueAt>`, or `…:now:<at>` for a run asked for by hand. */
  id: string;
  scheduleId: string;
  dueAt: number;
  outcome: ScheduleRunOutcome;
  /** A skip's reason, a failure's error, or how many earlier due times a run caught up on. */
  reason?: string;
  threadId?: string;
  recordedAt: number;
}

export function validateSchedulerSettings(where: string, value: unknown, topLevel: boolean): void {
  if (value === undefined) return;
  const parsed = schedulerSettingsSchema.safeParse(value);
  if (!parsed.success)
    throw Error(
      `${where}: ${parsed.error.issues.map((issue) => `${[where, ...issue.path].join('.')} ${issue.message}`).join('; ')}`,
    );
  const ids = new Set<string>();
  for (const [index, schedule] of (parsed.data.schedules ?? []).entries()) {
    const at = `${where}.schedules.${index}`;
    if (ids.has(schedule.id)) throw Error(`${at}.id ${schedule.id} is used twice`);
    ids.add(schedule.id);
    if (!topLevel && schedule.scope)
      throw Error(`${at}.scope: a project's schedule runs in the project; scopes are top-level`);
    if (schedule.scope && schedule.role)
      throw Error(`${at}.role: a ${schedule.scope} schedule's runs take the scope's role`);
    const refused = whenRefusal(schedule.when);
    if (refused) throw Error(`${at}.when ${refused}`);
  }
}

const CRON_SAMPLE = 64;

/** Why a `when` can't be scheduled, or undefined. */
export function whenRefusal(when: ScheduleWhen): string | undefined {
  if ('every' in when) {
    return everyMs(when.every) < MIN_EVERY_MS ? 'every is at least 5m' : undefined;
  }
  if ('cron' in when) {
    // The 5m floor holds for a cron too: its next fire times, sampled, never come closer.
    const options = when.tz ? { tz: when.tz } : undefined;
    try {
      let at = Bun.cron.parse(when.cron, new Date(), options);
      if (!at) return 'cron never fires';
      for (let i = 0; i < CRON_SAMPLE; i++) {
        const next = Bun.cron.parse(when.cron, at, options);
        if (!next) return undefined;
        if (next.getTime() - at.getTime() < MIN_EVERY_MS) return 'cron runs at least 5m apart';
        at = next;
      }
      return undefined;
    } catch (error) {
      return `cron ${(error as Error).message}`;
    }
  }
  return Number.isNaN(Date.parse(when.at)) ? 'at is not a time' : undefined;
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const everyMs = (every: string): number =>
  Number(every.slice(0, -1)) * UNIT_MS[every.at(-1) as keyof typeof UNIT_MS];

export interface ScheduleView {
  schedule: Schedule;
  where: ScheduleWhere;
  /** The next due time it would run at, when it is on (not paused, not a draft, project running). */
  nextDueAt?: number;
  lastRun?: ScheduleRun;
}

/** What an agent's schedule tools need from the scheduler: its schedules, read and written. */
export interface ScheduleBook {
  find(id: string): { schedule: Schedule; where: ScheduleWhere } | undefined;
  list(): ScheduleView[];
  /** `author`: the audit actor; absent, the owner. */
  save(
    input: Omit<Schedule, 'since'>,
    where: ScheduleWhere,
    author?: string,
  ): Promise<ScheduleView>;
  remove(id: string, author?: string): Promise<void>;
}
