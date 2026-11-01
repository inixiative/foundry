import { describe, expect, test } from 'bun:test';
import { buildChecklist, progress, stepState } from '../src/viewer/ui/plan-checklist.js';

const turn = (
  turnId: string,
  items: Array<[string, string]>,
  extra: { status?: string; goal?: string; source?: string } = {},
) => ({
  turnId,
  status: extra.status ?? 'completed',
  tasks: [
    {
      source: extra.source ?? 'TodoWrite',
      ...(extra.goal ? { goal: extra.goal } : {}),
      items: items.map(([text, status]) => ({ text, status })),
    },
  ],
});

describe('stepState', () => {
  test('maps plan-tool statuses onto status icons', () => {
    expect(stepState('completed')).toBe('done');
    expect(stepState('in_progress')).toBe('working');
    expect(stepState('pending')).toBe('queued');
    expect(stepState('blocked')).toBe('blocked');
    expect(stepState('something-else')).toBe('queued');
  });

  test('an in-progress step needs you while a prompt waits, and fails with a failed turn', () => {
    expect(stepState('in_progress', { needsYou: true })).toBe('approve');
    expect(stepState('in_progress', { failed: true })).toBe('error');
    expect(stepState('completed', { needsYou: true })).toBe('done');
  });
});

describe('buildChecklist', () => {
  test('the latest list is the plan; each step keeps the turn it reached its status', () => {
    const list = buildChecklist({
      turns: [
        turn('t1', [
          ['Read the schema', 'in_progress'],
          ['Add the column', 'pending'],
        ]),
        turn('t2', [
          ['Read the schema', 'completed'],
          ['Add the column', 'pending'],
        ]),
        turn('t3', [
          ['Read the schema', 'completed'],
          ['Add the column', 'in_progress'],
        ]),
      ],
    });
    expect(list.goals).toHaveLength(1);
    expect(list.goals[0]!.steps).toEqual([
      { text: 'Read the schema', state: 'done', when: 't2', children: [] },
      { text: 'Add the column', state: 'working', when: 't3', children: [] },
    ]);
    expect(progress(list)).toEqual({ done: 1, total: 2 });
  });

  test("Codex's explanation is the goal; each plan tool is its own group", () => {
    const list = buildChecklist({
      turns: [
        turn('t1', [['Read', 'completed']]),
        turn('t2', [['expand', 'pending']], { source: 'update_plan', goal: 'Migrate safely' }),
      ],
    });
    expect(list.goals.map((g) => [g.source, g.goal])).toEqual([
      ['TodoWrite', null],
      ['update_plan', 'Migrate safely'],
    ]);
  });

  test('a child thread nests under the step in progress on the turn that spawned it', () => {
    const list = buildChecklist({
      turns: [
        turn('t1', [
          ['Survey callers', 'in_progress'],
          ['Patch', 'pending'],
        ]),
      ],
      children: [
        { threadId: 'c1', name: 'Find the callers', state: 'working', parentTurnId: 't1' },
        { threadId: 'c2', name: 'Unrelated spawn', state: 'done', parentTurnId: 'tX' },
        { threadId: 'c3', name: 'No spawn turn', state: 'idle' },
      ],
    });
    expect(list.goals[0]!.steps[0]!.children).toEqual([
      { threadId: 'c1', name: 'Find the callers', state: 'working' },
    ]);
    expect(list.loose.map((c) => c.threadId)).toEqual(['c2', 'c3']);
  });

  test('no plan tool recorded gives an empty plan', () => {
    expect(buildChecklist({ turns: [{ turnId: 't1', status: 'completed' }] })).toEqual({
      goals: [],
      loose: [],
    });
  });
});
