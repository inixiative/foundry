import { expect, test } from 'bun:test';
import { restartBlockers, updateLine } from '../src/viewer/ui/update-line.js';

// Aron, 2026-11-16: restarting mode counts what blocks it; the update's own wording is unchanged.

const turn = (id: string) => ({ threadId: id, turnId: id });

test('a plain restart counts its blockers and names them', () => {
  const state = {
    phase: 'spinning-down',
    reason: 'the owner asked',
    running: [turn('a'), turn('b'), turn('c')],
    pausing: [turn('a')],
    pauseAtLocal: Date.now() + 45_500,
  };
  expect(restartBlockers(state)).toBe(3);
  expect(updateLine(state)).toBe(
    'Restarting: 3 blockers left (pausing 1 turn, 2 turns running, paused in 0:46 unless they finish)',
  );
  expect(updateLine({ ...state, running: [], pausing: [] })).toBe('Restarting now');
  expect(updateLine({ ...state, phase: 'restarting' })).toBe('Restarting…');
});

test('an update keeps its own line', () => {
  expect(updateLine({ phase: 'spinning-down', candidate: 'c1', running: [], pausing: [] })).toBe(
    'Update ready: restarting now',
  );
  expect(updateLine({ phase: 'restarting', candidate: 'c1' })).toBe('Restarting onto the update…');
});
