import { expect, test } from 'bun:test';
import { subagentParentOf } from '../src/viewer/ui/thread-status.js';

// Only a subagent nests under its parent: it carries `meta.spawn`. A thread a person started from
// another ("start another thread", fork) keeps its parent link for Plan but lists flat.
test('a subagent nests under its parent; a user-started child thread does not', () => {
  expect(
    subagentParentOf({ parentThreadId: 'main', spawn: { via: 'native-claude', observed: true } }),
  ).toBe('main');
  expect(subagentParentOf({ parentThreadId: 'main' })).toBeNull();
  expect(subagentParentOf({ spawn: { via: 'foundry' } })).toBeNull();
  expect(subagentParentOf(undefined)).toBeNull();
});
