import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { ContextStack, Thread, type WindowReading } from '@inixiative/foundry-core';
import { expireSnoozes, quotaResetAt, resolveSnooze } from '../src/viewer/thread-snooze';
import { m0Scenario } from './helpers/m0-domain-loop';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const reading = (timestamp: number, windows: WindowReading['windows']): WindowReading => ({
  timestamp,
  provider: 'claude',
  phase: 'after',
  source: 'session',
  windows,
});

test('a snooze is set and cleared through the routes, journalled with the thread, and never changes its status', async () => {
  const s = await m0Scenario();
  cleanup.push(() => s.close());
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const put = (body: unknown) =>
    s.current.app.request('/api/threads/a/snooze', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const before = s.current.directory.get('a')!.meta.status;
  const res = await put({ until });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { meta: { snooze: unknown; status: string } };
  expect(body.meta.snooze).toEqual({ until, setAt: expect.any(String) });
  expect(body.meta.status).toBe(before);
  const saved = s.current.localStore!.threads().find((t) => t.id === 'a');
  expect(saved?.meta.snooze?.until).toBe(until);

  expect((await put({ until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
  expect((await put({ condition: 'ci-finished' })).status).toBe(422);
  // No reading shows a reached window: nothing to wait for.
  expect((await put({ condition: 'quota-reset' })).status).toBe(409);
  expect(
    (await s.current.app.request('/api/threads/nope/snooze', { method: 'DELETE' })).status,
  ).toBe(404);

  const cleared = await s.current.app.request('/api/threads/a/snooze', { method: 'DELETE' });
  expect(((await cleared.json()) as { meta: { snooze?: unknown } }).meta.snooze).toBeUndefined();
  expect(s.current.localStore!.threads().find((t) => t.id === 'a')?.meta.snooze).toBeUndefined();
});

test('quota-reset resolves to the latest reset of the newest reading’s reached windows', () => {
  const now = 1_000;
  const readings = [
    reading(10, { five_hour: { usedPercent: 100, resetsAt: 5_000 } }),
    reading(20, {
      five_hour: { usedPercent: 100, resetsAt: 9_000 },
      seven_day: { usedPercent: 100, resetsAt: 50_000 },
      opus: { usedPercent: 40, resetsAt: 90_000 },
    }),
  ];
  expect(quotaResetAt(readings, now)).toBe(50_000);
  expect(resolveSnooze({ condition: 'quota-reset' }, () => readings, now)).toEqual({
    snooze: {
      until: new Date(50_000).toISOString(),
      condition: 'quota-reset',
      setAt: new Date(now).toISOString(),
    },
  });
});

test('an expired snooze is cleared and the thread is as it was; a live one stays', () => {
  const thread = (id: string, until: number) => {
    const t = new Thread(id, new ContextStack(), { description: '' });
    t.meta.status = 'waiting';
    t.meta.snooze = { until: new Date(until).toISOString(), setAt: new Date(0).toISOString() };
    return t;
  };
  const due = thread('due', 100);
  const later = thread('later', 10_000);
  const changed: string[] = [];
  expect(expireSnoozes([due, later], (t) => changed.push(t.id), 5_000).map((t) => t.id)).toEqual([
    'due',
  ]);
  expect(changed).toEqual(['due']);
  expect(due.meta.snooze).toBeUndefined();
  expect(due.meta.status).toBe('waiting');
  expect(later.meta.snooze).toBeDefined();
});
