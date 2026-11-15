import { describe, expect, test } from 'bun:test';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import {
  draftAsk,
  listSchedulesForAgent,
  removeScheduleAsAgent,
  type ScheduleAgentDeps,
  setScheduleAsAgent,
  threadWhere,
} from '../src/scheduler/agent-tools';
import { dueBetween, nextDueAfter, ONCE_GRACE_MS } from '../src/scheduler/due';
import { Scheduler } from '../src/scheduler/scheduler';
import type { Schedule, ScheduleWhere } from '../src/scheduler/types';
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
  setNow(at: number): void;
  started: Array<{ id: string; dueAt: number; where: ScheduleWhere }>;
  busy: Set<string>;
  failNext: { error?: Error };
  accepted: Schedule[];
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
  const accepted: Schedule[] = [];
  const scheduler = new Scheduler({
    config: () => config,
    update: async (edit) => {
      const draft = structuredClone(config);
      edit(draft);
      validateConfig(draft);
      config = draft;
    },
    store,
    startRun: async ({ schedule, where, dueAt }) => {
      if (failNext.error) {
        const error = failNext.error;
        delete failNext.error;
        throw error;
      }
      started.push({ id: schedule.id, dueAt, where });
      return `thread-${started.length}`;
    },
    busy: (threadId) => busy.has(threadId),
    changed: () => {
      changes++;
    },
    accepted: (schedule) => {
      accepted.push(schedule);
    },
    now: () => now,
  });
  return {
    scheduler,
    store,
    config: () => config,
    setNow: (at) => {
      now = at;
    },
    started,
    busy,
    failNext,
    accepted,
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

  test('accepting a draft, or the owner saving it, makes it live and reports it', async () => {
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
    await h.scheduler.accept('a');
    await h.scheduler.save({ id: 'b', ...base, when: { every: '1h' } }, GLOBAL);
    expect(h.accepted.map((schedule) => schedule.draft?.threadId)).toEqual(['t1', 't2']);
    expect(h.scheduler.find('a')?.schedule).toMatchObject({ since: T0 + 3 * HOUR });
    expect(h.scheduler.find('a')?.schedule.draft).toBeUndefined();
    await expect(h.scheduler.accept('a')).rejects.toThrow('is not a draft');
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
          scheduler: { schedules: [{ ...schedule, scope: 'forge', role: 'coder' }] },
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
    const asked: Array<{ threadId: string; text: string }> = [];
    const deps: ScheduleAgentDeps = {
      scheduler: h.scheduler,
      ownerInstructed: () => owner,
      askOwner: (threadId, text) => {
        asked.push({ threadId, text });
      },
    };
    return { deps, asked };
  }
  const input = { id: 'digest', ...base, when: { every: '1h' } as const };

  test('told by the owner, the agent schedules at once at its own Where', async () => {
    const h = harness(
      withSettings({
        projects: { app: { id: 'app', path: '/tmp/app' } },
      } as Partial<FoundryConfig>),
    );
    const { deps, asked } = agentDeps(h, true);
    const text = await setScheduleAsAgent(deps, 't1', { projectId: 'app' }, input);
    expect(text).toStartWith('Scheduled "Nightly digest" (digest) in project app');
    expect(h.scheduler.find('digest')?.schedule.draft).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test('on its own, the agent drafts and the thread asks the owner', async () => {
    const h = harness();
    const { deps, asked } = agentDeps(h, false);
    const text = await setScheduleAsAgent(deps, 't1', { role: 'feedback' }, input);
    expect(text).toContain('nothing was scheduled');
    expect(h.scheduler.find('digest')).toMatchObject({
      schedule: { draft: { threadId: 't1' } },
      where: { kind: 'scope', scope: 'feedback' },
    });
    expect(asked).toEqual([{ threadId: 't1', text: draftAsk('Nightly digest') }]);
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
    expect(threadWhere({ projectId: 'app', role: 'feedback' })).toEqual({
      kind: 'project',
      projectId: 'app',
    });
    expect(threadWhere({ role: 'forge-master' })).toEqual({ kind: 'scope', scope: 'forge' });
    expect(threadWhere({ role: 'coder' })).toEqual({ kind: 'global' });
  });
});
