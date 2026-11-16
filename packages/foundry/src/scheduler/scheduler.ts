/**
 * @atlas
 * @kind service
 * @partOf feature:scheduler
 */
import { contentHash } from '../persistence/journal-content';
import type { FoundryConfig } from '../viewer/config';
import { dueBetween, nextDueAfter, onceMissed } from './due';
import {
  type Schedule,
  type ScheduleBook,
  type ScheduleRun,
  type SchedulerSettings,
  type ScheduleView,
  type ScheduleWhere,
  whenRefusal,
} from './types';

/** The run history the scheduler keeps (`LocalSessionStore`'s `scheduler_runs`). */
export interface ScheduleRunStore {
  claimScheduleRun(run: {
    id: string;
    scheduleId: string;
    dueAt: number;
    manual: boolean;
  }): boolean;
  settleScheduleRun(
    id: string,
    outcome: ScheduleRun['outcome'],
    detail?: { reason?: string; threadId?: string },
  ): void;
  /** The thread a claimed run started, recorded as soon as it exists (before its first turn is accepted). */
  noteScheduleRunThread(id: string, threadId: string): void;
  scheduleRuns(scheduleId: string, limit?: number): ScheduleRun[];
  lastScheduledDue(scheduleId: string): number | undefined;
  /** The newest thread any other run of the schedule recorded, whatever its outcome. */
  latestScheduleRunThread(scheduleId: string, exceptRunId: string): string | undefined;
}

export interface SchedulerDeps {
  config(): FoundryConfig;
  /**
   * Commit a settings edit (`ConfigStore.update`: validated, persisted, audited). `author` is the
   * audit actor: absent, the owner; `thread:<id>` for an agent's edit.
   */
  update(edit: (draft: FoundryConfig) => void, author?: string): Promise<unknown>;
  store: ScheduleRunStore;
  /** Start one run: a new thread at the schedule's Where, its first turn the prompt. Its thread id; throws with why when it can't. */
  startRun(run: {
    schedule: Schedule;
    where: ScheduleWhere;
    runId: string;
    dueAt: number;
    /** Call once the run's thread exists, so a crash before its first turn still names it. */
    made(threadId: string): void;
  }): Promise<string>;
  /** Whether a thread has a turn queued or running. */
  busy(threadId: string): boolean;
  /** Runs changed: the viewer refreshes (settings edits reach it through `ConfigStore.onChange`). */
  changed(): void;
  now?: () => number;
}

/** A schedule's Where read back from its place in settings. */
const whereOf = (schedule: Schedule, projectId?: string): ScheduleWhere =>
  projectId
    ? { kind: 'project', projectId }
    : schedule.scope
      ? { kind: 'scope', scope: schedule.scope }
      : { kind: 'global' };

/** The settings slot a Where's schedules live in. */
function slot(config: FoundryConfig, where: ScheduleWhere): SchedulerSettings | undefined {
  return where.kind === 'project'
    ? config.projects?.[where.projectId]?.scheduler
    : config.scheduler;
}

/**
 * Starts schedules' runs when they are due, once per due time across ticks and restarts
 * (`scheduler_runs`), and keeps their history, skips included. A run is an ordinary thread at the
 * schedule's Where; what it does from there (finishing, asking the owner, failing) is the thread's.
 *
 * Missed due times (Foundry was off): a recurring schedule runs once, at its latest due time (under
 * one interval late by construction), and says how many it caught up on; a once-only one runs if
 * under an hour late, otherwise it is recorded missed. A run whose previous run is still working is
 * recorded skipped (overlap), never queued behind it.
 */
export class Scheduler implements ScheduleBook {
  private ticking: Promise<void> | null = null;
  /**
   * Schedules seen off because their project was (disabled or archived), and when each came back
   * on: due times count from then, so nothing missed while the project was off runs. In memory: a
   * project turned back on while Foundry was off reads as Foundry having been off.
   */
  private readonly projectOff = new Set<string>();
  private readonly projectBackOn = new Map<string, number>();

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Every schedule in settings with its Where, top-level first, then each project's. */
  all(): Array<{ schedule: Schedule; where: ScheduleWhere }> {
    const config = this.deps.config();
    return [
      ...(config.scheduler?.schedules ?? []).map((schedule) => ({
        schedule,
        where: whereOf(schedule),
      })),
      ...Object.entries(config.projects ?? {}).flatMap(([projectId, project]) =>
        (project?.scheduler?.schedules ?? []).map((schedule) => ({
          schedule,
          where: whereOf(schedule, projectId),
        })),
      ),
    ];
  }

  find(id: string): { schedule: Schedule; where: ScheduleWhere } | undefined {
    return this.all().find((entry) => entry.schedule.id === id);
  }

  /** Whether a schedule runs on its own now: not paused, not a draft, its project on. */
  private active(schedule: Schedule, where: ScheduleWhere): boolean {
    if (schedule.paused || schedule.draft) return false;
    if (where.kind !== 'project') return true;
    const project = this.deps.config().projects?.[where.projectId];
    const on = !!project && project.enabled !== false && project.status !== 'archived';
    if (!on) this.projectOff.add(schedule.id);
    else if (this.projectOff.delete(schedule.id)) this.projectBackOn.set(schedule.id, this.now());
    return on;
  }

  private cursor(schedule: Schedule): number {
    return Math.max(
      schedule.since,
      this.deps.store.lastScheduledDue(schedule.id) ?? 0,
      this.projectBackOn.get(schedule.id) ?? 0,
    );
  }

  view(schedule: Schedule, where: ScheduleWhere): ScheduleView {
    const nextDueAt = this.active(schedule, where)
      ? nextDueAfter(schedule.when, schedule.since, Math.max(this.cursor(schedule), this.now()))
      : undefined;
    const lastRun = this.deps.store.scheduleRuns(schedule.id, 1)[0];
    return {
      schedule,
      where,
      version: scheduleVersion(schedule, where),
      ...(nextDueAt === undefined ? {} : { nextDueAt }),
      ...(lastRun ? { lastRun } : {}),
    };
  }

  list(): ScheduleView[] {
    return this.all().map(({ schedule, where }) => this.view(schedule, where));
  }

  runs(id: string, limit?: number): ScheduleRun[] {
    return this.deps.store.scheduleRuns(id, limit);
  }

  /** Check every schedule once; a tick still running when the next comes is not doubled. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.checkAll().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async checkAll(): Promise<void> {
    let changed = false;
    for (const { schedule, where } of this.all()) {
      if (!this.active(schedule, where)) continue;
      const now = this.now();
      const due = dueBetween(schedule.when, schedule.since, this.cursor(schedule), now);
      if (!due) continue;
      changed = true;
      const runId = `schedule:${schedule.id}:${due.latest}`;
      if (
        !this.deps.store.claimScheduleRun({
          id: runId,
          scheduleId: schedule.id,
          dueAt: due.latest,
          manual: false,
        })
      )
        continue;
      if (onceMissed(schedule.when, due.latest, now)) {
        this.deps.store.settleScheduleRun(runId, 'skipped', {
          reason: `missed: Foundry was off when it was due`,
        });
        continue;
      }
      const caughtUp =
        due.earlier > 0
          ? `caught up: ${due.earlier} earlier due time${due.earlier === 1 ? '' : 's'} missed while Foundry was off`
          : undefined;
      await this.start(schedule, where, runId, due.latest, caughtUp);
    }
    if (changed) this.deps.changed();
  }

  /** Run a schedule now, by hand, whatever its time (a paused one too; never a draft). */
  async runNow(id: string): Promise<ScheduleRun> {
    const found = this.find(id);
    if (!found) throw Error(`no schedule ${id}`);
    if (found.schedule.draft) throw Error(`${id} is a draft: accept it first`);
    const now = this.now();
    const runId = `schedule:${id}:now:${now}`;
    if (!this.deps.store.claimScheduleRun({ id: runId, scheduleId: id, dueAt: now, manual: true }))
      throw Error(`${id} was just run`);
    await this.start(found.schedule, found.where, runId, now, 'run by hand');
    this.deps.changed();
    return this.deps.store.scheduleRuns(id, 50).find((run) => run.id === runId)!;
  }

  private async start(
    schedule: Schedule,
    where: ScheduleWhere,
    runId: string,
    dueAt: number,
    note: string | undefined,
  ): Promise<void> {
    const previous = this.deps.store.latestScheduleRunThread(schedule.id, runId);
    if (previous && this.deps.busy(previous)) {
      this.deps.store.settleScheduleRun(runId, 'skipped', {
        reason: 'overlap: its previous run is still working',
        threadId: previous,
      });
      return;
    }
    try {
      const threadId = await this.deps.startRun({
        schedule,
        where,
        runId,
        dueAt,
        made: (made) => this.deps.store.noteScheduleRunThread(runId, made),
      });
      this.deps.store.settleScheduleRun(runId, 'started', {
        threadId,
        ...(note ? { reason: note } : {}),
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const threadId = (error as { threadId?: string }).threadId;
      this.deps.store.settleScheduleRun(runId, 'failed', {
        reason: message,
        ...(threadId ? { threadId } : {}),
      });
    }
  }

  /**
   * Make or replace a schedule at its Where. Its due times count from now when it is new, when its
   * time changes, or when it comes off pause or out of draft, so nothing it missed while off runs.
   * A schedule moved to another Where leaves the old one.
   */
  async save(
    input: Omit<Schedule, 'since'>,
    where: ScheduleWhere,
    author?: string,
  ): Promise<ScheduleView> {
    const refused = whenRefusal(input.when);
    if (refused) throw Error(`when ${refused}`);
    if ('at' in input.when && Date.parse(input.when.at) <= this.now() && !this.find(input.id))
      throw Error('when.at is in the past');
    if (where.kind === 'project' && input.scope)
      throw Error("a project's schedule runs in the project; scopes are top-level");
    const now = this.now();
    await this.deps.update((draft) => {
      const prior = this.locate(draft, input.id);
      const restart =
        !prior ||
        JSON.stringify(prior.schedule.when) !== JSON.stringify(input.when) ||
        (prior.schedule.paused && !input.paused) ||
        (prior.schedule.draft && !input.draft);
      const next: Schedule = {
        ...input,
        ...(where.kind === 'scope' ? { scope: where.scope } : {}),
        since: restart ? now : prior.schedule.since,
      };
      if (where.kind !== 'scope') delete next.scope;
      if (prior) prior.list.splice(prior.index, 1);
      const settings = this.ensureSlot(draft, where);
      const at =
        prior && prior.list === settings.schedules ? prior.index : settings.schedules!.length;
      settings.schedules!.splice(at, 0, next);
    }, author);
    const saved = this.find(input.id)!;
    return this.view(saved.schedule, saved.where);
  }

  /**
   * Accept an agent's draft: it runs from now on. `version` is the one the owner saw, so a draft the
   * agent rewrote after he read it is never what he accepts.
   */
  async accept(id: string, version: string): Promise<ScheduleView> {
    const found = this.find(id);
    if (!found) throw Error(`no schedule ${id}`);
    if (!found.schedule.draft) throw Error(`${id} is not a draft`);
    if (scheduleVersion(found.schedule, found.where) !== version)
      throw Error(`${id} changed since you saw it; look at it again before accepting`);
    const { draft: _draft, since: _since, ...rest } = found.schedule;
    return this.save(rest, found.where);
  }

  async setPaused(id: string, paused: boolean): Promise<ScheduleView> {
    const found = this.find(id);
    if (!found) throw Error(`no schedule ${id}`);
    const { since: _since, paused: _paused, ...rest } = found.schedule;
    return this.save(paused ? { ...rest, paused } : rest, found.where);
  }

  /** Remove a schedule; its past runs stay in the history. */
  async remove(id: string, author?: string): Promise<void> {
    if (!this.find(id)) throw Error(`no schedule ${id}`);
    await this.deps.update((draft) => {
      const prior = this.locate(draft, id);
      if (prior) prior.list.splice(prior.index, 1);
    }, author);
  }

  private locate(
    config: FoundryConfig,
    id: string,
  ): { list: Schedule[]; index: number; schedule: Schedule } | undefined {
    const lists = [
      config.scheduler?.schedules,
      ...Object.values(config.projects ?? {}).map((project) => project?.scheduler?.schedules),
    ];
    for (const list of lists) {
      const index = list?.findIndex((schedule) => schedule.id === id) ?? -1;
      if (list && index >= 0) return { list, index, schedule: list[index]! };
    }
    return undefined;
  }

  private ensureSlot(config: FoundryConfig, where: ScheduleWhere): SchedulerSettings {
    if (where.kind === 'project') {
      const project = config.projects?.[where.projectId];
      if (!project) throw Error(`project not found: ${where.projectId}`);
      project.scheduler ??= {};
      project.scheduler.schedules ??= [];
      return project.scheduler;
    }
    config.scheduler ??= {};
    config.scheduler.schedules ??= [];
    return config.scheduler;
  }

  /** The schedules slot a Where reads (for tests and the view). */
  static slot = slot;
}

/** A schedule's version: what it does and where, never when it was last enabled. */
export function scheduleVersion(schedule: Schedule, where: ScheduleWhere): string {
  const { since: _since, ...rest } = schedule;
  return contentHash(JSON.stringify({ schedule: rest, where }));
}
