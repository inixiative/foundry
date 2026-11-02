import { expect, test } from 'bun:test';
import { contextSummary } from '../src/context';
import { guardComments } from '../src/guard';

// FEAT-008 in hosts: a degraded chorus is said in the "Foundry: context" item and as a guard comment.
// ACP has no action channel for Retry; the viewer has it.

const degraded = [{ domain: 'security', kind: 'timeout', layer: 1, silent: true, reason: 'late' }];

test('the context item names the unheard Wardens and reads the sealed row, not a retry', () => {
  const summary = contextSummary({
    phases: [
      {
        phase: 'advice',
        record: {
          trigger: 'user-message',
          participants: [{ domain: 'security', decision: 'timeout' }],
          degraded,
        },
      },
      {
        phase: 'advice',
        record: {
          trigger: 'user-message',
          retryOf: 'p1',
          participants: [{ domain: 'security', decision: 'contribute' }],
        },
      },
    ],
  })!;
  expect(summary.participants).toEqual([{ domain: 'security', decision: 'timeout' }]);
  expect(summary.degraded).toEqual(degraded);
  expect(summary.text).toContain(
    'Chorus degraded; the turn went on without them: security (Layer 1 timed out).',
  );
});

test('a guard row with unheard Wardens becomes a comment even with no findings', () => {
  const [comment] = guardComments({
    phases: [
      {
        id: 'g1',
        phase: 'guard-outcome',
        record: {
          observation: { tool: 'Edit' },
          domainsChecked: ['security'],
          notes: [],
          degraded,
        },
      },
    ],
  });
  expect(comment!.text).toContain('security (Layer 1 timed out)');
  expect(comment!.meta.degraded).toEqual(degraded);
});
