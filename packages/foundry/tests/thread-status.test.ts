import { describe, expect, test } from 'bun:test';
import { STATES, statusSvg } from '../src/viewer/ui/status-icons.js';
import { categoryOf, promptState, threadState } from '../src/viewer/ui/thread-status.js';

// A thread's status icon comes from the fields the viewer already holds. The most urgent colour wins:
// red › orange › green › light yellow › light blue › neutral › charcoal.

const t = (over: Record<string, unknown> = {}) => ({ meta: { status: 'idle' }, ...over });

describe('threadState', () => {
  test('an idle thread with no turns is idle (neutral)', () => {
    expect(threadState(t())).toBe('idle');
  });
  test('archived wins over everything, including a failed turn', () => {
    expect(threadState(t({ meta: { status: 'archived' }, lastTurn: { status: 'failed' } }))).toBe(
      'archived',
    );
  });
  test('a failed last turn is red, above a pending prompt', () => {
    expect(
      threadState(t({ lastTurn: { status: 'failed' } }), { prompts: [{ kind: 'approval' }] }),
    ).toBe('error');
  });
  test('a pending prompt beats working', () => {
    expect(
      threadState(t({ meta: { status: 'active' }, lastTurn: { status: 'running' } }), {
        prompts: [{ kind: 'approval' }],
      }),
    ).toBe('approve');
  });
  test('prompt kinds map to orange states', () => {
    expect(promptState({ kind: 'approval' })).toBe('approve');
    expect(promptState({ kind: 'choice' })).toBe('question');
    expect(promptState({ kind: 'input' })).toBe('question');
    expect(promptState({ kind: 'approval', meta: { conversationHeld: {} } })).toBe('held');
    expect(promptState({ kind: 'choice', meta: { conversationFloorRequest: {} } })).toBe('request');
  });
  test('an unread member post is a request; a held send is held', () => {
    expect(threadState(t({ conversation: { unread: 2 } }))).toBe('request');
    expect(threadState(t({ conversation: { held: 1, unread: 2 } }))).toBe('held');
  });
  test('starting, running and active are green', () => {
    expect(threadState(t({ meta: { status: 'idle', setup: { status: 'starting' } } }))).toBe(
      'starting',
    );
    expect(threadState(t({ lastTurn: { status: 'running' } }))).toBe('working');
    expect(threadState(t({ meta: { status: 'active' } }))).toBe('working');
    expect(threadState(t(), { childrenWorking: true })).toBe('subagents');
  });
  test('queued is light yellow; a completed last turn on an idle thread is done', () => {
    expect(threadState(t({ lastTurn: { status: 'queued' } }))).toBe('queued');
    expect(threadState(t({ lastTurn: { status: 'completed' } }))).toBe('done');
  });
  test('waiting (paused by the owner) and a paused conversation are paused', () => {
    expect(threadState(t({ meta: { status: 'waiting' } }))).toBe('paused');
    expect(threadState(t({ conversation: { paused: { by: 'owner' } } }))).toBe('paused');
  });
});

describe('the icon set', () => {
  test('every state has a category and renders a solid tile', () => {
    for (const state of Object.keys(STATES)) {
      expect(categoryOf(state)).toBe(STATES[state as keyof typeof STATES].cat);
      expect(statusSvg(state)).toContain('<svg class="ic');
    }
  });
  test('at most three cut-out symbols per colour', () => {
    const cutsByCategory = new Map<string, Set<string>>();
    for (const s of Object.values(STATES))
      cutsByCategory.set(s.cat, (cutsByCategory.get(s.cat) ?? new Set()).add(s.cut));
    for (const [, cuts] of cutsByCategory) expect(cuts.size).toBeLessThanOrEqual(3);
  });
  test('only orange carries the attention halo', () => {
    for (const [state, s] of Object.entries(STATES))
      expect(statusSvg(state).includes('class="halo"')).toBe(s.cat === 'attention');
  });
});

test('a snoozed thread reads as snoozed until the snooze ends; a request for you still shows', () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const thread = (until?: string) => ({
    threadId: 'nap',
    meta: { status: 'idle', tags: [], ...(until ? { snooze: { until, setAt: at(0) } } : {}) },
  });
  expect(threadState(thread(at(60_000)))).toBe('snoozed');
  expect(categoryOf('snoozed')).toBe('idle');
  expect(threadState(thread(at(60_000)), { prompts: [{ kind: 'approval' }] })).toBe('approve');
  expect(threadState(thread(at(-1)))).toBe('idle');
  expect(threadState(thread())).toBe('idle');
});
