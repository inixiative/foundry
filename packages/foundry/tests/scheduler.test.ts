import { describe, expect, test } from 'bun:test';
import { ActionQueue } from '@inixiative/foundry-core';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { CODER_ROLE, FEEDBACK_ROLE, FORGE_MASTER_ROLE } from '../src/prompts/instruction-settings';
import {
  listSchedulesForAgent,
  removeScheduleAsAgent,
  type ScheduleAgentDeps,
  setScheduleAsAgent,
  threadWhere,
} from '../src/scheduler/agent-tools';
import { DraftAsks, draftAsk } from '../src/scheduler/draft-asks';
import { dueBetween, nextDueAfter, ONCE_GRACE_MS } from '../src/scheduler/due';
import { Scheduler } from '../src/scheduler/scheduler';
import { type ScheduleWhere, whenRefusal } from '../src/scheduler/types';
import {
  defaultConfig,
  type FoundryConfig,
  validateConfig,
  validateRepositoryProject,
} from '../src/viewer/config';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-14T00:00:00Z');

interface Harness {
  scheduler: Scheduler;
  store: LocalSessionStore;
  config: () => FoundryConfig;
  /** Edit the settings outside the scheduler (the owner in Settings). */
  edit(fn: (config: FoundryConfig) => void): void;
  setNow(at: number): void;
  started: Array<{ id: string; dueAt: number; where: ScheduleWhere }>;
  busy: Set<string>;
  /** The next run makes its thread, then fails before it settles. */
  failNext: { error?: Error; afterThread?: boolean };
  /** The audit author of each settings edit (undefined: the owner). */
  authors: Array<string | undefined>;
  changes: () => number;
}

/** A valid config, with the given projects and scheduler over the defaults. */
const withSettings = (extra: Partial<FoundryConfig>): FoundryConfig => ({
  ...defaultConfig(),
  ...extra,
});

function harness(
  initial: FoundryConfig = defaultConfig(),
  store = new LocalSessionStore(':memory:'),
): Harness {
  let config = structuredClone(initial);
  let now = T0;
  let changes = 0;
  const started: Harness['started'] = [];
  const busy = new Set<string>();
  const failNext: Harness['failNext'] = {};
  const authors: Array<string | undefined> = [];
  const scheduler = new Scheduler({
    config: () => config,
    update: async (edit, author) => {
      const draft = structuredClone(config);
      edit(draft);
      validateConfig(draft);
      config = draft;
      authors.push(author);
    },
    store,
    startRun: async ({ schedule, where, dueAt, made }) => {
      if (failNext.error) {
        const error = failNext.error;
        const afterThread = failNext.afterThread;
        delete failNext.error;
        delete failNext.afterThread;
        if (afterThread) made(`thread-made-${dueAt}`);
        throw error;
      }
      started.push({ id: schedule.id, dueAt, where });
      made(`thread-${started.length}`);
      return `thread-${started.length}`;
    },
    busy: (threadId) => busy.has(threadId),
    changed: () => {
      changes++;
    },
    now: () => now,
  });
  return {
    scheduler,
    store,
    config: () => config,
    edit: (fn) => {
      const draft = structuredClone(config);
      fn(draft);
      validateConfig(draft);
      config = draft;
    },
    setNow: (at) => {
      now = at;
    },
    started,
    busy,
    failNext,
    authors,
    changes: () => changes,
  };
}

const base = { name: 'Nightly digest', prompt: 'Summarize what changed.' };
const GLOBAL: ScheduleWhere = { kind: 'global' };

describe('due times', () => {
  test('every counts from since, never at since itself', () => {
    expect(nextDueAfter({ every: '1h' }, T0, T0)).toBe(T0 + HOUR);
    expect(nextDueAfter({ every: '1h' }, T0, T0 + 90 * MIN)).toBe(T0 + 2 * HOUR);
    expect(dueBetween({ every: '1h' }, T0, T0, T0 + 59 * MIN)).toBeUndefined();
    expect(dueBetween({ every: '1h' }, T0, T0, T0 + HOUR)).toEqual({
      latest: T0 + HOUR,
      earlier: 0,
    });
  });

  test('every after a gap: only the latest, with how many it passed', () => {
    expect(dueBetween({ every: '1h' }, T0, T0 + HOUR, T0 + 5 * HOUR + 10 * MIN)).toEqual({
      latest: T0 + 5 * HOUR,
      earlier: 3,
    });
  });

  test('cron in a time zone', () => {
    const when = { cron: '0 9 * * *', tz: 'UTC' };
    expect(nextDueAfter(when, T0, T0)).toBe(T0 + 9 * HOUR);
    expect(dueBetween(when, T0, T0, T0 + 3 * 24 * HOUR)).toEqual({
      latest: T0 + 2 * 24 * HOUR + 9 * HOUR,
      earlier: 2,
    });
  });

  test('a once runs at its time and never again', () => {
    const when = { at: new Date(T0 + HOUR).toISOString() };
    expect(nextDueAfter(when, T0, T0)).toBe(T0 + HOUR);
    expect(nextDueAfter(when, T0, T0 + HOUR)).toBeUndefined();
    expect(dueBetween(when, T0, T0, T0 + 2 * HOUR)).toEqual({ latest: T0 + HOUR, earlier: 0 });
  });
});

describe('Scheduler ticks', () => {
  test('a due time runs once, across ticks and a restart', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.setNow(T0 + 30 * MIN);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(0);
    h.setNow(T0 + HOUR + MIN);
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.started).toEqual([{ id: 'digest', dueAt: T0 + HOUR, where: GLOBAL }]);

    const restarted = harness(h.config(), h.store);
    restarted.setNow(T0 + HOUR + 2 * MIN);
    await restarted.scheduler.tick();
    expect(restarted.started).toHaveLength(0);
    expect(h.scheduler.runs('digest')).toMatchObject([
      { id: `schedule:digest:${T0 + HOUR}`, outcome: 'started', threadId: 'thread-1' },
    ]);
  });

  test('missed while off: a recurring schedule runs its latest due time and says what it caught up on', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.setNow(T0 + HOUR);
    await h.scheduler.tick();
    h.setNow(T0 + 5 * HOUR + 10 * MIN);
    await h.scheduler.tick();
    expect(h.started.map((run) => run.dueAt)).toEqual([T0 + HOUR, T0 + 5 * HOUR]);
    expect(h.scheduler.runs('digest', 1)[0]).toMatchObject({
      outcome: 'started',
      reason: 'caught up: 3 earlier due times missed while Foundry was off',
    });
  });

  test('a once more than an hour late is recorded missed, not run', async () => {
    const h = harness();
    await h.scheduler.save(
      { id: 'once', ...base, when: { at: new Date(T0 + HOUR).toISOString() } },
      GLOBAL,
    );
    h.setNow(T0 + HOUR + ONCE_GRACE_MS + MIN);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(0);
    expect(h.scheduler.runs('once')).toMatchObject([
      { outcome: 'skipped', reason: 'missed: Foundry was off when it was due' },
    ]);
  });

  test('a once inside the grace still runs', async () => {
    const h = harness();
    await h.scheduler.save(
      { id: 'once', ...base, when: { at: new Date(T0 + HOUR).toISOString() } },
      GLOBAL,
    );
    h.setNow(T0 + HOUR + 30 * MIN);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(1);
  });

  test('a run whose previous run is still working is skipped, never queued', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.setNow(T0 + HOUR);
    await h.scheduler.tick();
    h.busy.add('thread-1');
    h.setNow(T0 + 2 * HOUR);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(1);
    expect(h.scheduler.runs('digest', 1)[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'overlap: its previous run is still working',
      threadId: 'thread-1',
    });
    h.busy.clear();
    h.setNow(T0 + 3 * HOUR);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(2);
  });

  test('overlap holds however many due times it has skipped', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '5m' } }, GLOBAL);
    h.setNow(T0 + 5 * MIN);
    await h.scheduler.tick();
    h.busy.add('thread-1');
    for (let i = 2; i <= 30; i++) {
      h.setNow(T0 + i * 5 * MIN);
      await h.scheduler.tick();
    }
    expect(h.started).toHaveLength(1);
    expect(h.scheduler.runs('digest', 100).filter((run) => run.outcome === 'skipped')).toHaveLength(
      29,
    );
  });

  test('a run whose thread was made before it failed still names it, and overlap sees it', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.failNext.error = Error('its first turn was refused');
    h.failNext.afterThread = true;
    h.setNow(T0 + HOUR);
    await h.scheduler.tick();
    expect(h.scheduler.runs('digest')).toMatchObject([
      { outcome: 'failed', threadId: `thread-made-${T0 + HOUR}` },
    ]);
    h.busy.add(`thread-made-${T0 + HOUR}`);
    h.setNow(T0 + 2 * HOUR);
    await h.scheduler.tick();
    expect(h.scheduler.runs('digest', 1)[0]).toMatchObject({ outcome: 'skipped' });
  });

  test('a project turned back on runs from then, not what it missed while off', async () => {
    const h = harness(
      withSettings({
        projects: { app: { id: 'app', path: '/tmp/app', enabled: false } },
      } as Partial<FoundryConfig>),
    );
    await h.scheduler.save(
      { id: 'digest', ...base, when: { every: '1h' } },
      { kind: 'project', projectId: 'app' },
    );
    h.setNow(T0 + 5 * HOUR);
    await h.scheduler.tick();
    h.edit((config) => {
      const app = config.projects?.app;
      if (app) app.enabled = true;
    });
    h.setNow(T0 + 5 * HOUR + 10 * MIN);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(0);
    expect(h.scheduler.find('digest') && h.scheduler.list()[0]?.nextDueAt).toBe(T0 + 6 * HOUR);
    h.setNow(T0 + 6 * HOUR);
    await h.scheduler.tick();
    expect(h.started.map((run) => run.dueAt)).toEqual([T0 + 6 * HOUR]);
  });

  test('a run that cannot start is recorded failed with why', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.failNext.error = Error('no login for codex');
    h.setNow(T0 + HOUR);
    await h.scheduler.tick();
    expect(h.scheduler.runs('digest')).toMatchObject([
      { outcome: 'failed', reason: 'no login for codex' },
    ]);
  });

  test('paused, drafted and disabled-project schedules do not run', async () => {
    const h = harness(
      withSettings({
        projects: { off: { id: 'off', path: '/tmp/off', enabled: false } },
      } as Partial<FoundryConfig>),
    );
    await h.scheduler.save({ id: 'paused', ...base, when: { every: '1h' }, paused: true }, GLOBAL);
    await h.scheduler.save(
      { id: 'drafted', ...base, when: { every: '1h' }, draft: { threadId: 't' } },
      GLOBAL,
    );
    await h.scheduler.save(
      { id: 'project', ...base, when: { every: '1h' } },
      { kind: 'project', projectId: 'off' },
    );
    h.setNow(T0 + 3 * HOUR);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(0);
    expect(h.scheduler.list().every((view) => view.nextDueAt === undefined)).toBe(true);
  });

  test('run now runs a paused schedule, never a draft', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'paused', ...base, when: { every: '1h' }, paused: true }, GLOBAL);
    await h.scheduler.save(
      { id: 'drafted', ...base, when: { every: '1h' }, draft: { threadId: 't' } },
      GLOBAL,
    );
    const run = await h.scheduler.runNow('paused');
    expect(run).toMatchObject({ outcome: 'started', reason: 'run by hand', threadId: 'thread-1' });
    await expect(h.scheduler.runNow('drafted')).rejects.toThrow('is a draft');
  });

  test('a run by hand does not move the schedule’s own due times', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.setNow(T0 + 10 * MIN);
    await h.scheduler.runNow('digest');
    h.setNow(T0 + HOUR);
    await h.scheduler.tick();
    expect(h.started.map((run) => run.dueAt)).toEqual([T0 + 10 * MIN, T0 + HOUR]);
  });
});

describe('Scheduler saves', () => {
  test('since restarts on a new time or a resume, and holds otherwise', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    h.setNow(T0 + 10 * MIN);
    await h.scheduler.save(
      { id: 'digest', ...base, name: 'Renamed', when: { every: '1h' } },
      GLOBAL,
    );
    expect(h.scheduler.find('digest')?.schedule.since).toBe(T0);
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '2h' } }, GLOBAL);
    expect(h.scheduler.find('digest')?.schedule.since).toBe(T0 + 10 * MIN);
    await h.scheduler.setPaused('digest', true);
    h.setNow(T0 + 5 * HOUR);
    await h.scheduler.setPaused('digest', false);
    expect(h.scheduler.find('digest')?.schedule).not.toHaveProperty('paused');
    expect(h.scheduler.find('digest')?.schedule.since).toBe(T0 + 5 * HOUR);
    await h.scheduler.tick();
    expect(h.started).toHaveLength(0);
  });

  test('a schedule moved to another Where leaves the old one; scopes are top-level only', async () => {
    const h = harness(
      withSettings({
        projects: { app: { id: 'app', path: '/tmp/app' } },
      } as Partial<FoundryConfig>),
    );
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    await h.scheduler.save(
      { id: 'digest', ...base, when: { every: '1h' } },
      { kind: 'project', projectId: 'app' },
    );
    expect(h.config().scheduler?.schedules).toEqual([]);
    expect(h.scheduler.find('digest')?.where).toEqual({ kind: 'project', projectId: 'app' });
    await h.scheduler.save(
      { id: 'digest', ...base, when: { every: '1h' } },
      { kind: 'scope', scope: 'feedback' },
    );
    expect(h.scheduler.find('digest')?.schedule.scope).toBe('feedback');
    await expect(
      h.scheduler.save(
        { id: 'scoped', ...base, when: { every: '1h' }, scope: 'feedback' },
        { kind: 'project', projectId: 'app' },
      ),
    ).rejects.toThrow('scopes are top-level');
  });

  test('a draft rewritten after the owner saw it is not what he accepts', async () => {
    const h = harness();
    const draft = { id: 'a', ...base, when: { every: '1h' }, draft: { threadId: 't1' } };
    const seen = (await h.scheduler.save(draft, GLOBAL)).version;
    await h.scheduler.save({ ...draft, prompt: 'something else' }, GLOBAL);
    await expect(h.scheduler.accept('a', seen)).rejects.toThrow('changed since you saw it');
    expect(h.scheduler.find('a')?.schedule.draft).toEqual({ threadId: 't1' });
  });

  test('accepting a draft, or the owner saving it, makes it live from then', async () => {
    const h = harness();
    await h.scheduler.save(
      { id: 'a', ...base, when: { every: '1h' }, draft: { threadId: 't1' } },
      GLOBAL,
    );
    await h.scheduler.save(
      { id: 'b', ...base, when: { every: '1h' }, draft: { threadId: 't2' } },
      GLOBAL,
    );
    h.setNow(T0 + 3 * HOUR);
    await h.scheduler.accept(
      'a',
      h.scheduler.list().find((view) => view.schedule.id === 'a')!.version,
    );
    await h.scheduler.save({ id: 'b', ...base, when: { every: '1h' } }, GLOBAL);
    expect(h.scheduler.find('b')?.schedule.draft).toBeUndefined();
    expect(h.scheduler.find('a')?.schedule).toMatchObject({ since: T0 + 3 * HOUR });
    expect(h.scheduler.find('a')?.schedule.draft).toBeUndefined();
    await expect(h.scheduler.accept('a', 'any')).rejects.toThrow('is not a draft');
    await h.scheduler.tick();
    expect(h.started).toHaveLength(0);
  });

  test('removing keeps the history', async () => {
    const h = harness();
    await h.scheduler.save({ id: 'digest', ...base, when: { every: '1h' } }, GLOBAL);
    await h.scheduler.runNow('digest');
    await h.scheduler.remove('digest');
    expect(h.scheduler.find('digest')).toBeUndefined();
    expect(h.scheduler.runs('digest')).toHaveLength(1);
  });

  test('cron is held to the same 5m floor, and one that never fires is refused', () => {
    expect(whenRefusal({ cron: '* * * * *' })).toBe('cron runs at least 5m apart');
    expect(whenRefusal({ cron: '0,1 9 * * *' })).toBe('cron runs at least 5m apart');
    expect(whenRefusal({ cron: '0 0 30 2 *' })).toBe('cron never fires');
    expect(whenRefusal({ cron: '*/5 * * * *' })).toBeUndefined();
    expect(whenRefusal({ cron: '0 9 * * 1-5', tz: 'Europe/London' })).toBeUndefined();
  });

  test('refuses a too-frequent every and a once in the past', async () => {
    const h = harness();
    await expect(
      h.scheduler.save({ id: 'x', ...base, when: { every: '1m' } }, GLOBAL),
    ).rejects.toThrow('every is at least 5m');
    await expect(
      h.scheduler.save(
        { id: 'x', ...base, when: { at: new Date(T0 - HOUR).toISOString() } },
        GLOBAL,
      ),
    ).rejects.toThrow('in the past');
  });
});

describe('settings', () => {
  test('ids are unique, roles stay off scopes', () => {
    const schedule = { id: 'a', ...base, when: { every: '1h' }, since: T0 };
    expect(() =>
      validateConfig(withSettings({ scheduler: { schedules: [schedule, schedule] } })),
    ).toThrow('is used twice');
    expect(() =>
      validateConfig(
        withSettings({
          scheduler: { schedules: [{ ...schedule, scope: 'forge', role: CODER_ROLE }] },
        }),
      ),
    ).toThrow("take the scope's role");
  });

  test('a repository never carries schedules', () => {
    expect(() => validateRepositoryProject({ scheduler: { schedules: [] } })).toThrow(
      'scheduler is not a repository setting',
    );
  });
});

describe('agent tools', () => {
  function agentDeps(h: Harness, owner: boolean) {
    const deps: ScheduleAgentDeps = {
      scheduler: h.scheduler,
      ownerInstructed: () => owner,
    };
    return { deps };
  }
  const input = { id: 'digest', ...base, when: { every: '1h' } as const };

  test('told by the owner, the agent schedules at once at its own Where', async () => {
    const h = harness(
      withSettings({
        projects: { app: { id: 'app', path: '/tmp/app' } },
      } as Partial<FoundryConfig>),
    );
    const { deps } = agentDeps(h, true);
    const text = await setScheduleAsAgent(deps, 't1', { projectId: 'app' }, input);
    expect(text).toStartWith('Scheduled "Nightly digest" (digest) in project app');
    expect(h.scheduler.find('digest')?.schedule.draft).toBeUndefined();
    // Audited as the thread's agent, not as the owner.
    expect(h.authors).toEqual(['thread:t1']);
  });

  test('on its own, the agent drafts', async () => {
    const h = harness();
    const { deps } = agentDeps(h, false);
    const text = await setScheduleAsAgent(deps, 't1', { role: FEEDBACK_ROLE }, input);
    expect(text).toContain('nothing was scheduled');
    expect(h.scheduler.find('digest')).toMatchObject({
      schedule: { draft: { threadId: 't1' } },
      where: { kind: 'scope', scope: 'feedback' },
    });
    await removeScheduleAsAgent(deps, 't1', 'digest');
    expect(h.authors).toEqual(['thread:t1', 'thread:t1']);
  });

  test('without the owner, an agent changes only its own draft', async () => {
    const h = harness();
    await setScheduleAsAgent(agentDeps(h, true).deps, 'owner-thread', {}, input);
    const { deps } = agentDeps(h, false);
    await expect(setScheduleAsAgent(deps, 't1', {}, input)).rejects.toThrow('already scheduled');
    await expect(removeScheduleAsAgent(deps, 't1', 'digest')).rejects.toThrow(
      'Only the owner removes',
    );

    await setScheduleAsAgent(deps, 't1', {}, { ...input, id: 'mine' });
    await expect(setScheduleAsAgent(deps, 't2', {}, { ...input, id: 'mine' })).rejects.toThrow(
      'another thread’s draft',
    );
    await setScheduleAsAgent(deps, 't1', {}, { ...input, id: 'mine', name: 'Changed' });
    expect(h.scheduler.find('mine')?.schedule.name).toBe('Changed');
    await removeScheduleAsAgent(deps, 't1', 'mine');
    expect(h.scheduler.find('mine')).toBeUndefined();
  });

  test('list reads every schedule with its state', async () => {
    const h = harness();
    const { deps } = agentDeps(h, false);
    expect(listSchedulesForAgent(deps)).toBe('No schedules.');
    await setScheduleAsAgent(deps, 't1', {}, input);
    expect(listSchedulesForAgent(deps)).toContain('a draft waiting for the owner');
  });

  test('a thread’s Where: project, then scope, then Global', () => {
    expect(threadWhere({ projectId: 'app', role: FEEDBACK_ROLE })).toEqual({
      kind: 'project',
      projectId: 'app',
    });
    expect(threadWhere({ role: FORGE_MASTER_ROLE })).toEqual({ kind: 'scope', scope: 'forge' });
    expect(threadWhere({ role: CODER_ROLE })).toEqual({ kind: 'global' });
  });
});

describe('draft asks', () => {
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 50 && !until(); i++) await Bun.sleep(5);
    expect(until()).toBe(true);
  };

  function asks(live = (_threadId: string) => true) {
    const h = harness(
      withSettings({
        scheduler: {
          schedules: [
            {
              id: 'sweep',
              ...base,
              name: 'Sweep',
              when: { every: '1h' },
              since: T0,
              draft: { threadId: 't1' },
            },
          ],
        },
      }),
    );
    const queue = new ActionQueue();
    const draftAsks = new DraftAsks({ scheduler: h.scheduler, queue, live });
    const open = () => queue.pending().filter((p) => p.meta?.scheduleDraft);
    const first = () => {
      const [prompt] = open();
      if (!prompt) throw Error('no draft prompt is open');
      return prompt;
    };
    return { h, queue, draftAsks, open, first };
  }

  test('one Accept/Reject prompt on the proposing thread, accepted by the owner', async () => {
    const { h, queue, draftAsks, open, first } = asks();
    draftAsks.reconcile();
    draftAsks.reconcile();
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({
      kind: 'choice',
      threadId: 't1',
      message: draftAsk('Sweep'),
      meta: { structural: true, scheduleDraft: { id: 'sweep' } },
    });
    queue.resolve(first().id, 'accept', { by: 'human' });
    await settle(() => h.scheduler.find('sweep')?.schedule.draft === undefined);
    await settle(() => open().length === 0);
  });

  test('rejecting removes the draft', async () => {
    const { h, queue, draftAsks, first } = asks();
    draftAsks.reconcile();
    queue.resolve(first().id, 'reject', { by: 'human' });
    await settle(() => h.scheduler.find('sweep') === undefined);
  });

  test('a renamed draft is asked again, and an answer to the old ask does nothing', async () => {
    const { h, queue, draftAsks, open, first } = asks();
    draftAsks.reconcile();
    const asked = first();
    h.edit((config) => {
      const sweep = config.scheduler?.schedules?.[0];
      if (sweep) sweep.name = 'Sweep the inbox';
    });
    draftAsks.reconcile();
    await settle(() => open().length === 1 && open()[0]?.id !== asked.id);
    expect(first().message).toBe(draftAsk('Sweep the inbox'));
    // The withdrawn prompt is no longer answerable as the owner's.
    queue.resolve(asked.id, 'accept', { by: 'human' });
    await Bun.sleep(20);
    expect(h.scheduler.find('sweep')?.schedule.draft).toEqual({ threadId: 't1' });
  });

  test('accepted elsewhere withdraws the prompt; a dead thread is never asked', async () => {
    const { h, draftAsks, open } = asks();
    draftAsks.reconcile();
    await h.scheduler.accept(
      'sweep',
      h.scheduler.list().find((view) => view.schedule.id === 'sweep')!.version,
    );
    draftAsks.reconcile();
    await settle(() => open().length === 0);
    const dead = asks(() => false);
    dead.draftAsks.reconcile();
    expect(dead.open()).toHaveLength(0);
  });

  test('close withdraws every open prompt', async () => {
    const { draftAsks, open } = asks();
    draftAsks.reconcile();
    draftAsks.close();
    await settle(() => open().length === 0);
  });
});
