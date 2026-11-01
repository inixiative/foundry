import { expect, test } from 'bun:test';
import { lifecycle } from '../src/viewer/ui/lifecycle.js';

// The Loop tab's strip: where the work stands on plan → build → review → land, from what is recorded.

const current = (steps: ReturnType<typeof lifecycle>) => steps.find((s) => s.current)?.id;

test('a thread with no turns is at plan', () => {
  expect(current(lifecycle([], { status: 'idle' }))).toBe('plan');
});

test('a task list means planned; a completed turn means building has happened', () => {
  expect(current(lifecycle([{ tasks: [{}], status: 'active' }], {}))).toBe('review');
  expect(current(lifecycle([{ status: 'completed' }], {}))).toBe('review');
});

test('guards on a turn, or a linked pull request, mean reviewed', () => {
  expect(current(lifecycle([{ status: 'completed', guards: [{}] }], {}))).toBe('land');
  const meta = { context: { references: [{ integration: 'github', ref: '#57' }] } };
  expect(current(lifecycle([{ status: 'completed' }], meta))).toBe('land');
});

test('an archived thread has landed, every step done', () => {
  const steps = lifecycle([{ status: 'completed', guards: [{}] }], { status: 'archived' });
  expect(current(steps)).toBe('land');
  expect(steps.every((s) => s.done)).toBe(true);
});
