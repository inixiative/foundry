import { expect, test } from 'bun:test';
import { worktreeLabel } from '../src/viewer/ui/worktree-pill.js';

test('the worktree pill names the slot, the folder, the main checkout or a released worktree', () => {
  const path = '/repos/kingdom/.worktrees/thread-view';
  expect(
    worktreeLabel({ mode: 'template', path, main: false, slot: 3, state: 'live' }),
  ).toMatchObject({
    tone: 'live',
    label: 'slot 3 · thread-view',
  });
  expect(
    worktreeLabel({ mode: 'template', path, main: false, slot: 3, state: 'live' }).title,
  ).toContain('its own ports, database and Redis');
  expect(worktreeLabel({ mode: 'classic', path, main: false, state: 'live' })).toMatchObject({
    label: 'thread-view',
  });
  expect(
    worktreeLabel({ mode: 'classic', path: '/repos/kingdom', main: true, state: 'live' }),
  ).toMatchObject({
    tone: 'muted',
    label: 'main checkout',
  });
  expect(
    worktreeLabel({ mode: 'template', path, main: false, slot: 3, state: 'released' }),
  ).toMatchObject({
    tone: 'released',
    label: 'thread-view · released',
  });
  expect(worktreeLabel({ mode: 'none', main: false, state: 'live' }).label).toBe('no checkout');
});

test('a worktree whose branch merged says where it merged into', () => {
  const path = '/repo/.worktrees/thread-view';
  const merged = { into: 'main', at: 1 };
  expect(worktreeLabel({ mode: 'classic', path, main: false, state: 'live', merged }).label).toBe(
    'thread-view · merged into main',
  );
  expect(
    worktreeLabel({ mode: 'template', path, main: false, slot: 3, state: 'released', merged })
      .label,
  ).toBe('thread-view · released · merged into main');
});
