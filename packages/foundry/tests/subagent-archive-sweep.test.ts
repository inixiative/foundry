import { expect, test } from 'bun:test';
import { ContextStack, Thread, type ThreadMeta } from '@inixiative/foundry-core';
import { ViewerThreadDirectory } from '../src/viewer/thread-directory';

const meta = (over: Partial<ThreadMeta>): ThreadMeta => ({
  description: '',
  status: 'idle',
  createdAt: 1,
  lastActiveAt: 1,
  tags: [],
  ...over,
});
const spawn = { via: 'native-claude', observed: true } as const;

test('startup archives open subagents under an archived parent, at every depth', () => {
  const directory = new ViewerThreadDirectory(new Thread('main', new ContextStack()));
  directory.restore([
    { id: 'gone', meta: meta({ status: 'archived', archivedAt: 5 }) },
    { id: 'child', meta: meta({ parentThreadId: 'gone', spawn }) },
    { id: 'grandchild', meta: meta({ parentThreadId: 'child', spawn }) },
    { id: 'live', meta: meta({}) },
    { id: 'live-child', meta: meta({ parentThreadId: 'live', spawn }) },
    // A thread a person started from the archived one is top-level: it stays.
    { id: 'follow-up', meta: meta({ parentThreadId: 'gone' }) },
  ]);
  const archived = directory.archiveOrphanedSubagents().map((t) => t.id);
  expect(archived.sort()).toEqual(['child', 'grandchild']);
  expect(directory.get('grandchild')?.meta.status).toBe('archived');
  expect(directory.get('live-child')?.meta.status).toBe('idle');
  expect(directory.get('follow-up')?.meta.status).toBe('idle');
  expect(directory.archiveOrphanedSubagents()).toEqual([]);
  // Each takes the archived ancestor's time, so undoing that archive brings it back.
  expect(directory.get('grandchild')?.meta.archivedAt).toBe(5);
});

test('an archived observed subagent reopens from its meta; nothing else does through that path', () => {
  const directory = new ViewerThreadDirectory(new Thread('main', new ContextStack()));
  directory.restore([
    { id: 'gone', meta: meta({ status: 'archived', archivedAt: 5 }) },
    { id: 'child', meta: meta({ parentThreadId: 'gone', spawn }) },
  ]);
  directory.archiveOrphanedSubagents();
  const back = directory.reopenObserved('child');
  expect(back?.disposed).toBe(false);
  expect(back?.meta.status).toBe('idle');
  expect(back?.meta.archivedAt).toBeUndefined();
  expect(directory.get('child')).toBe(back);
  expect(directory.reopenObserved('gone')).toBeUndefined();
  expect(directory.reopenObserved('child')).toBeUndefined();
});
