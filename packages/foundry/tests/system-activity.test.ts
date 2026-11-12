import { describe, expect, test } from 'bun:test';
import type { ProjectHostState } from '../src/providers/project-warden-hosts';
import {
  decisionPressureActivity,
  prefilterActivity,
  primedEventActivity,
  projectHostActivity,
} from '../src/viewer/system-activity';
import { elapsedLabel, READY_SHOWN_MS, shows, stripView } from '../src/viewer/ui/system-strip.js';

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

  test('elapsed reads in seconds, then minutes', () => {
    expect(elapsedLabel(65_000)).toBe('1m 5s');
    expect(elapsedLabel(-5)).toBe('0s');
  });
});
