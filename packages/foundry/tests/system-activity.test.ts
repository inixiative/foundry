import { describe, expect, test } from 'bun:test';
import type { ProjectHostState } from '../src/providers/project-warden-hosts';
import {
  decisionPressureActivity,
  prefilterActivity,
  primedEventActivity,
  projectHostActivity,
  resetTime,
} from '../src/viewer/system-activity';
import {
  advised,
  elapsedLabel,
  READY_SHOWN_MS,
  shows,
  stripView,
} from '../src/viewer/ui/system-strip.js';

const host = (over: Partial<ProjectHostState>): ProjectHostState => ({
  status: 'starting',
  expected: 75,
  held: 0,
  failures: 0,
  resets: {},
  generation: 1,
  ...over,
});

describe('a project host in plain words', () => {
  const said = (state: ProjectHostState) => projectHostActivity('proj_1', 'Kingdom', state);

  test('starting is work in progress, with the count and no ids', () => {
    const a = said(host({ reason: 'start' }));
    expect(a).toMatchObject({
      key: 'project-wardens:proj_1',
      projectId: 'proj_1',
      state: 'working',
    });
    expect(a.summary).toBe(
      "Getting Kingdom's 75 Wardens ready. Reminders may be slower until they are.",
    );
    expect(a.summary).not.toContain('proj_1');
    expect(a.detail).toContain('proj_1 starting: 0/75 held (start)');
  });

  test('serving with no reason is ready; a refreshed roster is ready too', () => {
    expect(said(host({ status: 'serving', held: 75, setupMs: 37435 }))).toMatchObject({
      state: 'ready',
      summary: "Kingdom's 75 Wardens are ready.",
    });
    expect(said(host({ status: 'serving', reason: 'roster refreshed' })).state).toBe('ready');
  });

  test('a replacement while serving says the current ones keep answering', () => {
    expect(said(host({ status: 'serving', reason: 'roster grew' })).summary).toContain(
      'the current ones keep answering',
    );
    for (const reason of ['memory bound', 'recycle churn', 'process ended (exit 1)', 'not serving'])
      expect(said(host({ status: 'serving', reason }))).toMatchObject({
        state: 'working',
        summary: "Restarting Kingdom's Wardens; the current ones keep answering.",
      });
  });

  test('a failed start is degraded, failed for good is red, idle is for the log only', () => {
    expect(said(host({ reason: 'start failed (boom); again in 2000 ms' })).state).toBe('degraded');
    expect(said(host({ status: 'failed', reason: '3 starts failed in a row' })).state).toBe(
      'failed',
    );
    expect(said(host({ status: 'serving', reason: 'idle' })).state).toBe('idle');
    expect(said(host({ status: 'closed' })).state).toBe('idle');
    expect(said(host({ reason: 'no Wardens' })).state).toBe('idle');
  });
});

test('decision pressure touches every thread; a rate limit shows until it ends', () => {
  const limited = decisionPressureActivity({ kind: 'rate-limited', until: 5000, backoffMs: 4000 });
  expect(limited).toMatchObject({ state: 'degraded', until: 5000 });
  expect(limited.projectId).toBeUndefined();
  expect(decisionPressureActivity({ kind: 'closed', reason: 'auth' }).state).toBe('failed');
  const shed = decisionPressureActivity(
    { kind: 'shed', threadId: 't', priority: 1, queued: 3 },
    1000,
  );
  expect(shed.until).toBeGreaterThan(1000);
  expect(shed.summary).not.toContain('t,');
});

test('a decision process recycling is logged, never shown; other primed events are dropped', () => {
  expect(
    primedEventActivity({ type: 'process-recycled', generation: 2, reason: 'tokens' })?.state,
  ).toBe('idle');
  expect(primedEventActivity({ type: 'process-started', generation: 1, ms: 10 })).toBeUndefined();
});

test('the pre-filter: down or missing is degraded under one key, back is ready', () => {
  expect(prefilterActivity({ ok: false, reason: 'refused' }).state).toBe('degraded');
  expect(prefilterActivity('not-installed').summary).toContain('not installed');
  expect(prefilterActivity({ ok: true })).toMatchObject({
    key: 'warden-prefilter',
    state: 'ready',
  });
});

describe('the strip', () => {
  const at = (state: string, timestamp: number, extra = {}) => ({
    key: `${state}:${timestamp}`,
    source: 's',
    state,
    summary: state,
    detail: state,
    timestamp,
    ...extra,
  });

  test('idle never shows, ready only briefly, an expired one not at all', () => {
    expect(shows(at('idle', 0), 0)).toBe(false);
    expect(shows(at('ready', 0), READY_SHOWN_MS - 1)).toBe(true);
    expect(shows(at('ready', 0), READY_SHOWN_MS)).toBe(false);
    expect(shows(at('degraded', 0, { until: 10 }), 10)).toBe(false);
    expect(shows(at('failed', 0), 1e12)).toBe(true);
  });

  test('the headline is the most pressing, the rest are counted; nothing shows when quiet', () => {
    const view = stripView([at('working', 100), at('failed', 50), at('ready', 90)], 1000);
    expect(view?.state).toBe('failed');
    expect(view?.others.map((a: { state: string }) => a.state)).toEqual(['working', 'ready']);
    expect(stripView([at('idle', 0)], 1)).toBeNull();
    expect(stripView([at('working', 0)], 12_500)?.elapsed).toBe('12s');
  });

  test('an outage is advised once per thread: quiet after the person sends a message, back when new', () => {
    const outage = { ...at('failed', 50), key: 'project-wardens:p', outageStartedAt: 40 };
    expect(stripView([outage], 1000, undefined)?.head.key).toBe('project-wardens:p');
    expect(stripView([outage], 1000, 30)?.head.key).toBe('project-wardens:p');
    expect(stripView([outage], 1000, 45)).toBeNull();
    expect(stripView([{ ...outage, outageStartedAt: 60 }], 1000, 45)?.head.key).toBe(
      'project-wardens:p',
    );
    expect(advised(at('working', 10), 45)).toBe(false);
    // A retry inside an advised outage stays quiet too.
    expect(advised({ ...at('working', 50), outageStartedAt: 40 }, 45)).toBe(true);
  });

  test('an outage whose fix is Restart stays until acted on', () => {
    const stopped = { ...at('failed', 50), key: 'decisions:admission', outageStartedAt: 40 };
    expect(stripView([stopped], 1000, 45)?.head.key).toBe('decisions:admission');
  });

  test('elapsed reads in seconds, then minutes', () => {
    expect(elapsedLabel(65_000)).toBe('1m 5s');
    expect(elapsedLabel(-5)).toBe('0s');
  });
});

test('a used-up login is one paused notice until its reset, project and decisions alike', () => {
  const now = Date.now();
  const reset = now + 2 * 3_600_000;
  const paused = projectHostActivity(
    'proj_1',
    'Kingdom',
    host({ quotaResetsAt: reset, failures: 0, reason: 'usage used up; again at its reset' }),
  );
  expect(paused).toMatchObject({ state: 'degraded', until: reset });
  expect(paused.summary).toBe(
    `Kingdom's Wardens are paused: the Claude login's usage is used up until ${resetTime(reset)}.`,
  );
  // Back serving: the pause is over even before the stored reset is cleared.
  expect(
    projectHostActivity('proj_1', 'Kingdom', host({ status: 'serving', quotaResetsAt: reset }))
      .summary,
  ).not.toContain('paused');
  const decisions = decisionPressureActivity({ kind: 'quota-paused', until: reset }, now);
  // The same key as a rate limit: the pause replaces that notice instead of adding one.
  expect(decisions).toMatchObject({ key: 'decisions:rate-limit', state: 'degraded', until: reset });
  expect(decisions.summary).toContain(resetTime(reset, now));
});

test('a reset within the day is a time; further off it carries the day', () => {
  const now = new Date(2026, 10, 17, 9, 0).getTime();
  expect(resetTime(now + 3 * 3_600_000, now)).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  expect(resetTime(now + 3 * 86_400_000, now)).toMatch(/Fri/);
});
