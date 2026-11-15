import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import { ConversationService } from '../src/conversations/service';
import { LocalSessionStore } from '../src/persistence/local-session-store';

// Aron, 2026-11-14 ("pause + resume"): Foundry's continuation of a turn a restart paused resumes
// that turn's instruction, so it carries the paused turn's owner authority, and only that.

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'restart-authority-'));
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  const thread = new Thread('main', new ContextStack());
  store.saveThread(thread);
  let running: string | null = null;
  const service = new ConversationService({
    store,
    thread: (id) => (id === thread.id ? thread : undefined),
    threads: () => [thread],
    turns: () => ({
      accept: () => {
        throw Error('not used');
      },
      interrupt: async () => undefined,
      runningTurn: () => running,
    }),
    queue: null,
    project: () => undefined,
    hosted: () => [],
    subscriptions: () => [],
  });
  cleanup.push(() => {
    service.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const continuation = (id: string, of: string) =>
    store.beginTurn(thread, id, 'resume', {
      origin: {
        member: { kind: 'local', id: `restart:${of}` },
        displayName: 'Foundry',
        postId: `restart:${of}`,
        restart: true,
      },
    });
  return {
    store,
    thread,
    service,
    continuation,
    run: (id: string | null) => {
      running = id;
    },
  };
}

test("a restart's continuation of the owner's own turn is his; Foundry's line alone never is", () => {
  const f = fixture();
  f.store.beginTurn(f.thread, 'turn_owner', 'refactor the scheduler');
  f.continuation('turn_resume', 'turn_owner');
  expect(f.store.restartContinuationOf('turn_resume')).toBe('turn_owner');
  expect(f.store.restartContinuationOf('turn_owner')).toBeUndefined();
  f.run('turn_owner');
  expect(f.service.ownerInstructed('main')).toBe(true);
  f.run('turn_resume');
  expect(f.service.ownerInstructed('main')).toBe(true);
  // Paused again after its own restart: still his, through the chain.
  f.continuation('turn_resume_2', 'turn_resume');
  f.run('turn_resume_2');
  expect(f.service.ownerInstructed('main')).toBe(true);
  // A continuation of a turn that doesn't exist carries nothing.
  f.continuation('turn_orphan', 'turn_missing');
  f.run('turn_orphan');
  expect(f.service.ownerInstructed('main')).toBe(false);
});

test("a continuation of a turn another party's post opened is not the owner's", () => {
  const f = fixture();
  f.store.beginTurn(f.thread, 'turn_member', 'mute everyone', {
    origin: { member: { kind: 'signet', id: 'sig_jobco' }, displayName: 'JobCo', postId: 'p1' },
  });
  f.continuation('turn_resume', 'turn_member');
  f.run('turn_resume');
  expect(f.service.ownerInstructed('main')).toBe(false);
});
