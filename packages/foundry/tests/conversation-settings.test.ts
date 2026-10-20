import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import type { ThreadEntry } from '@inixiative/signet';
import { resolveConversationSettings } from '../src/conversations/settings';
import { DEFAULT_CONVERSATION_SETTINGS } from '../src/conversations/types';
import { capView, visibleTo } from '../src/conversations/view';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { defaultConfig, validateConfig } from '../src/viewer/config';
import { readRepositorySettings } from '../src/viewer/config-resolve';

// The conversations setting is one key in the existing cascade (CONVERSATIONS.md §4.6), the read-off
// point's cap (§4.7), and the journal's one order across messages and conversation rows.

test('the cascade: default, then the repository file, then this machine project settings, then the thread', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-settings-'));
  try {
    expect(resolveConversationSettings(undefined, undefined)).toEqual({
      settings: DEFAULT_CONVERSATION_SETTINGS,
      floorFrom: 'default',
    });
    mkdirSync(join(dir, '.foundry'));
    writeFileSync(
      join(dir, '.foundry', 'project.json'),
      JSON.stringify({ conversations: { floor: 'conch', conch: { holdSeconds: 60 } } }),
    );
    const repository = resolveConversationSettings({ path: dir }, undefined);
    expect(repository).toEqual({
      settings: {
        floor: 'conch',
        maxAgentTurns: 6,
        conch: { holdSeconds: 60, agentMayPass: false },
      },
      floorFrom: 'repository',
    });
    const mine = resolveConversationSettings(
      { path: dir, conversations: { maxAgentTurns: 3, conch: { agentMayPass: true } } },
      undefined,
    );
    expect(mine.settings).toEqual({
      floor: 'conch',
      maxAgentTurns: 3,
      conch: { holdSeconds: 60, agentMayPass: true },
    });
    const thread = resolveConversationSettings(
      { path: dir, conversations: { floor: 'talk' } },
      { floor: 'speak-when-spoken-to' },
    );
    expect(thread.floorFrom).toBe('thread');
    expect(thread.settings.floor).toBe('speak-when-spoken-to');
    expect(readRepositorySettings(dir)?.conversations).toEqual({
      floor: 'conch',
      conch: { holdSeconds: 60 },
    });
    writeFileSync(
      join(dir, '.foundry', 'project.json'),
      JSON.stringify({ conversations: { floor: 'chat' } }),
    );
    expect(readRepositorySettings(dir)?.error).toContain('conversations.floor');
    // An unreadable repository file contributes nothing.
    expect(resolveConversationSettings({ path: dir }, undefined).settings).toEqual(
      DEFAULT_CONVERSATION_SETTINGS,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings validation refuses a conversations value it cannot read, by field', () => {
  const config = defaultConfig();
  config.projects = {
    p: { id: 'p', path: '/tmp/p', conversations: { maxAgentTurns: 0 } },
  } as typeof config.projects;
  expect(() => validateConfig(config)).toThrow('projects.p.conversations.maxAgentTurns');
  config.projects.p!.conversations = { floor: 'talk', extra: true } as never;
  expect(() => validateConfig(config)).toThrow('projects.p.conversations');
  config.projects.p!.conversations = { floor: 'conch', conch: { holdSeconds: 120 } };
  expect(() => validateConfig(config)).not.toThrow();
});

test('a view is cut at the 16,000-character read cap: forward continues after the last entry, newest keeps the tail', () => {
  const entry = (seq: number, chars: number): ThreadEntry => ({
    journalSeq: seq,
    at: new Date(0).toISOString(),
    kind: 'post',
    member: { kind: 'signet', id: 'a' },
    text: 'x'.repeat(chars),
  });
  const entries = [entry(1, 9000), entry(2, 9000), entry(3, 100)];
  expect(capView(entries, 9, 'forward')).toMatchObject({
    journalSeq: 1,
    truncated: true,
    entries: [{ journalSeq: 1 }],
  });
  expect(capView(entries, 9, 'newest')).toMatchObject({
    journalSeq: 9,
    truncated: true,
    entries: [{ journalSeq: 2 }, { journalSeq: 3 }],
  });
  expect(capView([entry(1, 10)], 4, 'forward')).toEqual({
    journalSeq: 4,
    truncated: false,
    entries: [entry(1, 10)],
  });
  // `own` sees its posts and the sends addressed to it; never owner or agent messages.
  const owner: ThreadEntry = { ...entry(4, 1), kind: 'owner', member: null };
  const other: ThreadEntry = { ...entry(5, 1), member: { kind: 'signet', id: 'b' } };
  const own = { signetId: 'a', lens: { view: 'own' as const } };
  expect([entry(1, 1), owner, other].filter((e) => visibleTo(e, own))).toEqual([entry(1, 1)]);
  expect(
    [entry(1, 1), owner, other].filter((e) => visibleTo(e, { ...own, lens: { view: 'thread' } })),
  ).toHaveLength(3);
});

test('the journal keeps one order across a thread messages and its conversation rows; a v5 store is ordered as it was written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-journal-'));
  const path = join(dir, 'sessions.sqlite');
  try {
    const thread = new Thread('thread_order', new ContextStack());
    let store = new LocalSessionStore(path);
    store.beginTurn(thread, 'turn_a', 'first');
    store.appendPhase(thread, {
      id: 'phase_post',
      turnId: null,
      dispatchId: null,
      phase: 'member-post',
      record: { postId: 'p', signetId: 's', text: 'a post', delivery: 'note' },
    });
    store.beginTurn(thread, 'turn_b', 'second');
    store.appendPhase(thread, {
      id: 'phase_route',
      turnId: 'turn_b',
      dispatchId: null,
      phase: 'route',
      record: {},
    });
    const order = (s: LocalSessionStore) =>
      s
        .journalEntries(thread.id)
        .map((e) => (e.source === 'message' ? e.message.content : e.phase));
    // Middleware rows are never part of the order members read.
    expect(order(store)).toEqual(['first', 'member-post', 'second']);
    expect(store.lastOwnerSeq(thread.id)).toBe(3);
    expect(store.turnMessageSeq('turn_a')).toBe(1);
    store.close();

    // A store written before v6: messages only, no order. Opening it orders them as written.
    const raw = new Database(path);
    raw.exec('DROP TABLE session_journal; PRAGMA user_version = 5;');
    raw.close();
    store = new LocalSessionStore(path);
    expect(order(store)).toEqual(['first', 'second']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
